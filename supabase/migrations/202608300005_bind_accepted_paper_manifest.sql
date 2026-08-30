-- BEGIN ACCEPTED PAPER MANIFEST 202608300005
-- Capture the exact cloud checkpoints in the same advisory-lock transaction
-- that accepts a paper.  This closes the readback -> accept TOCTOU window and
-- gives Edge a DB-owned page/client/revision/hash authority independent of
-- mutable app_state runtime-audit references.

alter table public.paper_submit_attempts
  add column if not exists page_manifest jsonb;

do $$
begin
  alter table public.paper_submit_attempts
    add constraint paper_submit_attempts_accepted_manifest_required
    check (
      status <> 'accepted'
      or (page_manifest is not null and jsonb_typeof(page_manifest) = 'array')
    ) not valid;
exception when duplicate_object then null;
end;
$$;

-- Match the browser canonical JSON used for the immutable cloud SHA.  Keys are
-- sorted and insignificant whitespace is omitted recursively.
create or replace function public.matha_canonical_jsonb_text(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select case jsonb_typeof(p_value)
    when 'object' then (
      select '{' || coalesce(string_agg(
        to_jsonb(entry.key)::text || ':' ||
          public.matha_canonical_jsonb_text(entry.value),
        ',' order by entry.key
      ), '') || '}'
      from jsonb_each(p_value) entry
    )
    when 'array' then (
      select '[' || coalesce(string_agg(
        public.matha_canonical_jsonb_text(entry.value),
        ',' order by entry.ordinality
      ), '') || ']'
      from jsonb_array_elements(p_value) with ordinality entry(value, ordinality)
    )
    else p_value::text
  end;
$$;
revoke all on function public.matha_canonical_jsonb_text(jsonb)
  from public, anon, authenticated, service_role;

-- Receipts expose the immutable manifest to its owner and to Edge readback.
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
    'page_manifest', (p_result).page_manifest,
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
        'page_manifest', (p_winner).page_manifest,
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

-- Remove the manifest-less accept overload: keeping it callable would be a
-- direct bypass of the new transaction-bound checkpoint verification.
drop function if exists public.matha_paper_submit_accept(
  text, text, text, bigint, text, bigint, text
);
create or replace function public.matha_paper_submit_accept(
  p_attempt_id text,
  p_run_id text,
  p_source_id text,
  p_remaining_ms bigint,
  p_ink_snapshot_sha256 text,
  p_submitted_at bigint,
  p_run_created_app_version text,
  p_page_manifest jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_existing public.paper_submit_attempts%rowtype;
  v_winner public.paper_submit_attempts%rowtype;
  v_result public.paper_submit_attempts%rowtype;
  v_ink public.ink_sessions%rowtype;
  v_item jsonb;
  v_manifest jsonb := '[]'::jsonb;
  v_pages integer[] := '{}';
  v_page integer;
  v_revision integer;
  v_qid text;
  v_client_id text;
  v_cloud_sha256 text;
  v_updated_at timestamptz;
  v_server_sha256 text;
begin
  if v_user is null or not public.is_matha_user(v_user) then
    raise exception 'authenticated MathA user required' using errcode = '42501';
  end if;
  if p_attempt_id is null
      or p_attempt_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
      or p_run_id is null
      or p_run_id !~ '^paper-run-[0-9]{10,20}$'
      or p_source_id is null
      or length(p_source_id) not between 1 and 160
      or p_remaining_ms is null
      or p_remaining_ms not between 0 and 43200000
      or p_ink_snapshot_sha256 is null
      or p_ink_snapshot_sha256 !~ '^[0-9a-f]{64}$'
      or p_submitted_at is null
      or p_submitted_at not between 1 and 9007199254740991
      or p_run_created_app_version is null
      or p_run_created_app_version !~ '^[0-9]{4}[a-z]$'
      or p_page_manifest is null
      or jsonb_typeof(p_page_manifest) <> 'array'
      or jsonb_array_length(p_page_manifest) not between 1 and 20 then
    raise exception 'invalid paper submit attempt payload' using errcode = '22023';
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
        or v_existing.run_created_app_version is distinct from p_run_created_app_version
        or (v_existing.status = 'accepted'
          and v_existing.page_manifest is distinct from p_page_manifest) then
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
    return public.matha_paper_submit_receipt(v_result, v_winner);
  end if;

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
    return public.matha_paper_submit_receipt(v_result, v_winner);
  end if;

  -- The ink guard takes the same lock.  Every row below therefore either
  -- matches the client's just-read checkpoint or changed before this lock and
  -- fails; after INSERT accepted, later writes are rejected by the guard.
  for v_item in select value from jsonb_array_elements(p_page_manifest)
  loop
    if jsonb_typeof(v_item) <> 'object'
        or coalesce(v_item->>'page', '') !~ '^(0|[1-9][0-9]?)$'
        or coalesce(v_item->>'revision', '') !~ '^(0|[1-9][0-9]*)$'
        or coalesce(v_item->>'cloudSha256', '') !~ '^[0-9a-f]{64}$'
        or coalesce(v_item->>'updatedAt', '') !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
      raise exception 'invalid accepted paper page manifest' using errcode = '22023';
    end if;
    v_page := (v_item->>'page')::integer;
    v_revision := (v_item->>'revision')::integer;
    v_qid := v_item->>'qid';
    v_client_id := v_item->>'clientId';
    v_cloud_sha256 := v_item->>'cloudSha256';
    v_updated_at := (v_item->>'updatedAt')::timestamptz;
    if v_page = any(v_pages)
        or v_qid !~ ('^paper:' || p_run_id || ':v[0-9]+:' || v_page::text || '$')
        or v_client_id is null or length(v_client_id) not between 1 and 300 then
      raise exception 'invalid accepted paper page identity' using errcode = '22023';
    end if;
    v_pages := array_append(v_pages, v_page);

    select * into v_ink
    from public.ink_sessions
    where user_id = v_user and client_id = v_client_id and qid = v_qid
      and updated_at = v_updated_at;
    if not found
        or coalesce((v_ink.proc->>'overlay')::boolean, false) is distinct from true
        or v_ink.proc->>'mode' <> 'paper-source'
        or v_ink.proc->'event' is not null
        or (v_ink.proc->>'page')::integer is distinct from v_page
        or (v_ink.proc->>'revision')::integer is distinct from v_revision
        or coalesce((v_ink.strokes->>'paper')::boolean, false) is distinct from true
        or (v_ink.strokes->>'revision')::integer is distinct from v_revision then
      raise exception 'accepted paper page changed before arbitration' using errcode = '40001';
    end if;
    v_server_sha256 := encode(extensions.digest(convert_to(
      public.matha_canonical_jsonb_text(v_ink.strokes), 'UTF8'
    ), 'sha256'), 'hex');
    if v_server_sha256 <> v_cloud_sha256 then
      raise exception 'accepted paper page digest changed before arbitration' using errcode = '40001';
    end if;
    v_manifest := v_manifest || jsonb_build_array(jsonb_build_object(
      'page', v_page,
      'qid', v_qid,
      'clientId', v_client_id,
      'revision', v_revision,
      'cloudSha256', v_server_sha256,
      'updatedAt', to_char(v_ink.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ));
  end loop;

  if array_length(v_pages, 1) <> jsonb_array_length(p_page_manifest)
      or (select min(page) from unnest(v_pages) page) <> 0
      or (select max(page) from unnest(v_pages) page) <>
        jsonb_array_length(p_page_manifest) - 1 then
    raise exception 'accepted paper page manifest is not contiguous' using errcode = '22023';
  end if;
  select jsonb_agg(value order by (value->>'page')::integer)
  into v_manifest from jsonb_array_elements(v_manifest);
  if v_manifest is distinct from p_page_manifest then
    raise exception 'accepted paper page manifest is not canonical' using errcode = '22023';
  end if;

  insert into public.paper_submit_attempts (
    user_id, attempt_id, run_id, source_id, status, remaining_ms,
    ink_snapshot_sha256, page_manifest, submitted_at, accepted_at,
    run_created_app_version, decision_reason
  ) values (
    v_user, p_attempt_id, p_run_id, p_source_id, 'accepted', p_remaining_ms,
    p_ink_snapshot_sha256, v_manifest, p_submitted_at, now(),
    p_run_created_app_version, 'accepted-first-for-run'
  ) returning * into v_result;
  return public.matha_paper_submit_receipt(v_result, null);
end;
$$;

revoke all on function public.matha_paper_submit_accept(
  text, text, text, bigint, text, bigint, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.matha_paper_submit_accept(
  text, text, text, bigint, text, bigint, text, jsonb
) to authenticated;
-- END ACCEPTED PAPER MANIFEST 202608300005
