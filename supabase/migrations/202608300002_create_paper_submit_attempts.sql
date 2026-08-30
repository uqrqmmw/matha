-- BEGIN PAPER SUBMIT ATTEMPT PROTOCOL 202608300002
-- Immutable, fail-closed arbitration for concurrent full-paper submissions.
-- Client roles can read only their own rows; all writes go through the three
-- authenticated RPCs below. service_role gets table SELECT only so the Edge
-- grading authority can verify an accepted receipt; it gets no RPC or write.

create table if not exists public.paper_submit_attempts (
  user_id                  uuid not null references auth.users (id) on delete cascade,
  attempt_id               text not null,
  run_id                   text not null,
  source_id                text not null,
  status                   text not null,
  remaining_ms             bigint not null,
  ink_snapshot_sha256      text not null,
  submitted_at             bigint not null,
  accepted_at              timestamptz,
  canceled_at              timestamptz,
  run_created_app_version  text not null,
  decision_reason          text not null,
  winner_attempt_id        text,
  created_at               timestamptz not null default now(),
  primary key (user_id, attempt_id),
  constraint paper_submit_attempts_attempt_id_valid
    check (attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  constraint paper_submit_attempts_run_id_valid
    check (run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  constraint paper_submit_attempts_status_valid
    check (status in ('accepted', 'canceled')),
  constraint paper_submit_attempts_payload_valid
    check (
      length(source_id) between 1 and 160
      and remaining_ms between 0 and 43200000
      and ink_snapshot_sha256 ~ '^[0-9a-f]{64}$'
      and submitted_at between 1 and 9007199254740991
      and run_created_app_version ~ '^[0-9]{4}[a-z]$'
    ),
  constraint paper_submit_attempts_decision_time_valid
    check (
      (
        status = 'accepted'
        and accepted_at is not null
        and canceled_at is null
        and decision_reason = 'accepted-first-for-run'
        and winner_attempt_id is null
      )
      or
      (
        status = 'canceled'
        and accepted_at is null
        and canceled_at is not null
        and (
          (decision_reason = 'client-canceled-before-accept' and winner_attempt_id is null)
          or
          (
            decision_reason = 'superseded-by-accepted-attempt'
            and winner_attempt_id is not null
            and winner_attempt_id <> attempt_id
          )
        )
      )
  )
);

alter table public.paper_submit_attempts
  add column if not exists winner_attempt_id text;

-- This is the final database backstop for cross-device races.  The RPC also
-- takes a per-user transaction lock so the losing attempt can be recorded as
-- an immutable canceled tombstone instead of surfacing a uniqueness error.
create unique index if not exists paper_submit_attempts_one_accepted_run
  on public.paper_submit_attempts (user_id, run_id)
  where status = 'accepted';

create index if not exists paper_submit_attempts_user_run
  on public.paper_submit_attempts (user_id, run_id, created_at desc);

alter table public.paper_submit_attempts enable row level security;
revoke all on table public.paper_submit_attempts from public, anon, authenticated, service_role;
grant select on table public.paper_submit_attempts to authenticated;
grant select on table public.paper_submit_attempts to service_role;

drop policy if exists "own paper submit attempts read" on public.paper_submit_attempts;
create policy "own paper submit attempts read" on public.paper_submit_attempts
  for select
  to authenticated
  using (
    auth.uid() = user_id
    and public.is_matha_user(auth.uid())
  );

-- Attempts are append-only, including for service-role callers.  No legitimate
-- protocol path updates or deletes a decision; a canceled attempt can therefore
-- never be changed to accepted after the fact.
create or replace function public.matha_paper_submit_attempt_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'paper submit attempts are immutable'
    using errcode = '55000';
end;
$$;
revoke all on function public.matha_paper_submit_attempt_immutable() from public, anon, authenticated, service_role;

drop trigger if exists paper_submit_attempts_immutable on public.paper_submit_attempts;
create trigger paper_submit_attempts_immutable
before update or delete on public.paper_submit_attempts
for each row execute function public.matha_paper_submit_attempt_immutable();

-- Internal receipt formatter.  Superseded attempts carry the authoritative
-- accepted winner receipt so every device converges to the same locked run.
create or replace function public.matha_paper_submit_receipt(
  p_result public.paper_submit_attempts,
  p_winner public.paper_submit_attempts default null
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'attempt_id', (p_result).attempt_id,
    'run_id', (p_result).run_id,
    'source_id', (p_result).source_id,
    'status', (p_result).status,
    'remaining_ms', (p_result).remaining_ms,
    'ink_snapshot_sha256', (p_result).ink_snapshot_sha256,
    'submitted_at', (p_result).submitted_at,
    'accepted_at', (p_result).accepted_at,
    'canceled_at', (p_result).canceled_at,
    'run_created_app_version', (p_result).run_created_app_version,
    'decision_reason', (p_result).decision_reason,
    'winner_attempt_id', (p_result).winner_attempt_id,
    'winner', case
      when (p_winner).attempt_id is null then null
      else jsonb_build_object(
        'attempt_id', (p_winner).attempt_id,
        'run_id', (p_winner).run_id,
        'source_id', (p_winner).source_id,
        'status', (p_winner).status,
        'remaining_ms', (p_winner).remaining_ms,
        'ink_snapshot_sha256', (p_winner).ink_snapshot_sha256,
        'submitted_at', (p_winner).submitted_at,
        'accepted_at', (p_winner).accepted_at,
        'canceled_at', (p_winner).canceled_at,
        'run_created_app_version', (p_winner).run_created_app_version,
        'decision_reason', (p_winner).decision_reason,
        'winner_attempt_id', (p_winner).winner_attempt_id,
        'winner', null
      )
    end
  );
$$;
revoke all on function public.matha_paper_submit_receipt(
  public.paper_submit_attempts, public.paper_submit_attempts
) from public, anon, authenticated, service_role;

drop function if exists public.matha_paper_submit_accept(text, text, text, bigint, text, bigint, text);
create or replace function public.matha_paper_submit_accept(
  p_attempt_id text,
  p_run_id text,
  p_source_id text,
  p_remaining_ms bigint,
  p_ink_snapshot_sha256 text,
  p_submitted_at bigint,
  p_run_created_app_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_existing public.paper_submit_attempts%rowtype;
  v_winner public.paper_submit_attempts%rowtype;
  v_result public.paper_submit_attempts%rowtype;
begin
  if v_user is null or not public.is_matha_user(v_user) then
    raise exception 'authenticated MathA user required' using errcode = '42501';
  end if;
  if p_attempt_id is null
      or p_attempt_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
      or p_run_id is null
      or p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      or p_source_id is null
      or length(p_source_id) not between 1 and 160
      or p_remaining_ms is null
      or p_remaining_ms not between 0 and 43200000
      or p_ink_snapshot_sha256 is null
      or p_ink_snapshot_sha256 !~ '^[0-9a-f]{64}$'
      or p_submitted_at is null
      or p_submitted_at not between 1 and 9007199254740991
      or p_run_created_app_version is null
      or p_run_created_app_version !~ '^[0-9]{4}[a-z]$' then
    raise exception 'invalid paper submit attempt payload' using errcode = '22023';
  end if;

  -- One lock serializes accept/cancel decisions for this learner.  It covers an
  -- unknown cancellation tombstone and also prevents an attempt_id being raced
  -- under two different run_id values.
  perform pg_advisory_xact_lock(
    hashtextextended('matha-paper-submit:' || v_user::text, 0)
  );

  select * into v_existing
  from public.paper_submit_attempts
  where user_id = v_user and attempt_id = p_attempt_id;

  if found then
    if v_existing.run_id <> p_run_id then
      raise exception 'paper submit attempt id belongs to another run' using errcode = '22023';
    end if;
    if v_existing.source_id is distinct from p_source_id
        or v_existing.remaining_ms is distinct from p_remaining_ms
        or v_existing.ink_snapshot_sha256 is distinct from p_ink_snapshot_sha256
        or v_existing.submitted_at is distinct from p_submitted_at
        or v_existing.run_created_app_version is distinct from p_run_created_app_version then
      raise exception 'paper submit attempt payload changed' using errcode = '22023';
    else
      v_result := v_existing;
      if v_result.winner_attempt_id is not null then
        select * into v_winner
        from public.paper_submit_attempts
        where user_id = v_user
          and attempt_id = v_result.winner_attempt_id
          and run_id = v_result.run_id
          and status = 'accepted';
        if not found then
          raise exception 'paper submit winner receipt is missing' using errcode = '55000';
        end if;
      end if;
    end if;
  else
    select * into v_winner
    from public.paper_submit_attempts
    where user_id = v_user and run_id = p_run_id and status = 'accepted';

    if found then
      insert into public.paper_submit_attempts (
        user_id, attempt_id, run_id, source_id, status, remaining_ms,
        ink_snapshot_sha256, submitted_at, canceled_at,
        run_created_app_version, decision_reason, winner_attempt_id
      ) values (
        v_user, p_attempt_id, p_run_id, p_source_id, 'canceled', p_remaining_ms,
        p_ink_snapshot_sha256, p_submitted_at, now(),
        p_run_created_app_version, 'superseded-by-accepted-attempt', v_winner.attempt_id
      ) returning * into v_result;
    else
      insert into public.paper_submit_attempts (
        user_id, attempt_id, run_id, source_id, status, remaining_ms,
        ink_snapshot_sha256, submitted_at, accepted_at,
        run_created_app_version, decision_reason
      ) values (
        v_user, p_attempt_id, p_run_id, p_source_id, 'accepted', p_remaining_ms,
        p_ink_snapshot_sha256, p_submitted_at, now(),
        p_run_created_app_version, 'accepted-first-for-run'
      ) returning * into v_result;
    end if;
  end if;

  return public.matha_paper_submit_receipt(v_result, v_winner);
end;
$$;

drop function if exists public.matha_paper_submit_lookup(text, text);
create or replace function public.matha_paper_submit_lookup(
  p_attempt_id text,
  p_run_id text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_result public.paper_submit_attempts%rowtype;
  v_winner public.paper_submit_attempts%rowtype;
begin
  if v_user is null or not public.is_matha_user(v_user) then
    raise exception 'authenticated MathA user required' using errcode = '42501';
  end if;
  if p_attempt_id is null
      or p_attempt_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
      or p_run_id is null
      or p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' then
    raise exception 'invalid paper submit lookup' using errcode = '22023';
  end if;

  select * into v_result
  from public.paper_submit_attempts
  where user_id = v_user
    and attempt_id = p_attempt_id
    and run_id = p_run_id;
  if not found then
    return null;
  end if;
  if v_result.winner_attempt_id is not null then
    select * into v_winner
    from public.paper_submit_attempts
    where user_id = v_user
      and attempt_id = v_result.winner_attempt_id
      and run_id = v_result.run_id
      and status = 'accepted';
    if not found then
      raise exception 'paper submit winner receipt is missing' using errcode = '55000';
    end if;
  end if;
  return public.matha_paper_submit_receipt(v_result, v_winner);
end;
$$;

drop function if exists public.matha_paper_submit_cancel(text, text);
drop function if exists public.matha_paper_submit_cancel(text, text, text, bigint, text, bigint, text);
create or replace function public.matha_paper_submit_cancel(
  p_attempt_id text,
  p_run_id text,
  p_source_id text,
  p_remaining_ms bigint,
  p_ink_snapshot_sha256 text,
  p_submitted_at bigint,
  p_run_created_app_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_existing public.paper_submit_attempts%rowtype;
  v_result public.paper_submit_attempts%rowtype;
  v_winner public.paper_submit_attempts%rowtype;
begin
  if v_user is null or not public.is_matha_user(v_user) then
    raise exception 'authenticated MathA user required' using errcode = '42501';
  end if;
  if p_attempt_id is null
      or p_attempt_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
      or p_run_id is null
      or p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      or p_source_id is null
      or length(p_source_id) not between 1 and 160
      or p_remaining_ms is null
      or p_remaining_ms not between 0 and 43200000
      or p_ink_snapshot_sha256 is null
      or p_ink_snapshot_sha256 !~ '^[0-9a-f]{64}$'
      or p_submitted_at is null
      or p_submitted_at not between 1 and 9007199254740991
      or p_run_created_app_version is null
      or p_run_created_app_version !~ '^[0-9]{4}[a-z]$' then
    raise exception 'invalid paper submit cancellation' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('matha-paper-submit:' || v_user::text, 0)
  );

  select * into v_existing
  from public.paper_submit_attempts
  where user_id = v_user and attempt_id = p_attempt_id;
  if found then
    if v_existing.run_id <> p_run_id then
      raise exception 'paper submit attempt id belongs to another run' using errcode = '22023';
    end if;
    if v_existing.source_id is distinct from p_source_id
        or v_existing.remaining_ms is distinct from p_remaining_ms
        or v_existing.ink_snapshot_sha256 is distinct from p_ink_snapshot_sha256
        or v_existing.submitted_at is distinct from p_submitted_at
        or v_existing.run_created_app_version is distinct from p_run_created_app_version then
      raise exception 'paper submit attempt payload changed' using errcode = '22023';
    end if;
    v_result := v_existing;
    if v_result.winner_attempt_id is not null then
      select * into v_winner
      from public.paper_submit_attempts
      where user_id = v_user
        and attempt_id = v_result.winner_attempt_id
        and run_id = v_result.run_id
        and status = 'accepted';
      if not found then
        raise exception 'paper submit winner receipt is missing' using errcode = '55000';
      end if;
    end if;
  else
    -- An unknown local attempt may still have lost to another device while its
    -- network request was in flight.  If this run already has a winner, seal a
    -- superseded tombstone and return that accepted receipt; never authorize
    -- the losing device to restore ink.  Only a run with no winner receives the
    -- client-canceled-before-accept decision.
    select * into v_winner
    from public.paper_submit_attempts
    where user_id = v_user and run_id = p_run_id and status = 'accepted';

    if found then
      insert into public.paper_submit_attempts (
        user_id, attempt_id, run_id, source_id, status, remaining_ms,
        ink_snapshot_sha256, submitted_at, canceled_at,
        run_created_app_version, decision_reason, winner_attempt_id
      ) values (
        v_user, p_attempt_id, p_run_id, p_source_id, 'canceled', p_remaining_ms,
        p_ink_snapshot_sha256, p_submitted_at, now(),
        p_run_created_app_version, 'superseded-by-accepted-attempt', v_winner.attempt_id
      ) returning * into v_result;
    else
      -- Unknown attempts become durable tombstones in the same transaction. A
      -- delayed accept of this attempt_id must return canceled forever.
      insert into public.paper_submit_attempts (
        user_id, attempt_id, run_id, source_id, status, remaining_ms,
        ink_snapshot_sha256, submitted_at, canceled_at,
        run_created_app_version, decision_reason
      ) values (
        v_user, p_attempt_id, p_run_id, p_source_id, 'canceled', p_remaining_ms,
        p_ink_snapshot_sha256, p_submitted_at, now(),
        p_run_created_app_version, 'client-canceled-before-accept'
      ) returning * into v_result;
    end if;
  end if;

  return public.matha_paper_submit_receipt(v_result, v_winner);
end;
$$;

-- Explicit grants: learner JWT only.  anon cannot call, and service_role is not
-- an ownership substitute for these client-facing decisions.
revoke all on function public.matha_paper_submit_accept(text, text, text, bigint, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_submit_lookup(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_submit_cancel(text, text, text, bigint, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.matha_paper_submit_accept(text, text, text, bigint, text, bigint, text)
  to authenticated;
grant execute on function public.matha_paper_submit_lookup(text, text)
  to authenticated;
grant execute on function public.matha_paper_submit_cancel(text, text, text, bigint, text, bigint, text)
  to authenticated;
-- END PAPER SUBMIT ATTEMPT PROTOCOL 202608300002
