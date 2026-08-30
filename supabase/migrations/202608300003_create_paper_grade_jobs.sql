-- BEGIN PAPER GRADE JOB PROTOCOL 202608300003
-- Private, service-role-only idempotency for whole-paper grading.  A job is
-- bound to the immutable accepted submit winner, the exact server-built model
-- input, and a server-issued generation.  Once a request may have reached the
-- model it is never leased again: an unknown outcome is safer than a duplicate
-- charge.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.paper_grade_jobs (
  user_id                         uuid not null references auth.users (id) on delete cascade,
  run_id                          text not null,
  accepted_attempt_id             text not null,
  model_input_binding_sha256       text not null,
  generation                      bigint not null,
  issuance_request_id              text,
  status                           text not null,
  lease_token                      text,
  lease_expires_at                 timestamptz,
  dispatched_at                    timestamptz,
  completed_at                     timestamptz,
  normalized_model_json            jsonb,
  normalized_model_json_sha256     text,
  model_metadata                   jsonb,
  model_metadata_sha256            text,
  receipt_envelope                 jsonb,
  receipt_envelope_sha256          text,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now(),
  primary key (
    user_id, run_id, accepted_attempt_id, model_input_binding_sha256, generation
  ),
  foreign key (user_id, accepted_attempt_id)
    references public.paper_submit_attempts (user_id, attempt_id) on delete cascade,
  constraint paper_grade_jobs_run_id_valid
    check (run_id ~ '^paper-run-[0-9]{10,20}$'),
  constraint paper_grade_jobs_attempt_id_valid
    check (accepted_attempt_id ~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$'),
  constraint paper_grade_jobs_binding_valid
    check (model_input_binding_sha256 ~ '^[0-9a-f]{64}$'),
  constraint paper_grade_jobs_generation_valid
    check (generation between 0 and 2147483647),
  constraint paper_grade_jobs_issuance_valid
    check (
      (generation = 0 and issuance_request_id is null)
      or
      (
        generation > 0
        and issuance_request_id ~ '^paper-grade-generation-[A-Za-z0-9._:-]{16,127}$'
      )
    ),
  constraint paper_grade_jobs_status_valid
    check (status in ('reserved', 'leased', 'dispatched', 'completed')),
  constraint paper_grade_jobs_state_shape_valid
    check (
      (
        status = 'reserved'
        and lease_token is null and lease_expires_at is null
        and dispatched_at is null and completed_at is null
        and normalized_model_json is null
        and normalized_model_json_sha256 is null
        and model_metadata is null and model_metadata_sha256 is null
        and receipt_envelope is null and receipt_envelope_sha256 is null
      )
      or
      (
        status = 'leased'
        and lease_token is not null and lease_expires_at is not null
        and dispatched_at is null and completed_at is null
        and normalized_model_json is null
        and normalized_model_json_sha256 is null
        and model_metadata is null and model_metadata_sha256 is null
        and receipt_envelope is null and receipt_envelope_sha256 is null
      )
      or
      (
        status = 'dispatched'
        and lease_token is not null and lease_expires_at is null
        and dispatched_at is not null and completed_at is null
        and normalized_model_json is null
        and normalized_model_json_sha256 is null
        and model_metadata is null and model_metadata_sha256 is null
        and receipt_envelope is null and receipt_envelope_sha256 is null
      )
      or
      (
        status = 'completed'
        and lease_token is not null and lease_expires_at is null
        and dispatched_at is not null and completed_at is not null
        and normalized_model_json is not null
        and normalized_model_json_sha256 ~ '^[0-9a-f]{64}$'
        and model_metadata is not null
        and model_metadata_sha256 ~ '^[0-9a-f]{64}$'
        and receipt_envelope is not null
        and receipt_envelope_sha256 ~ '^[0-9a-f]{64}$'
      )
    )
);

-- A generation number can bind to only one model input.  In particular,
-- generation zero cannot be recreated with a different page/prompt digest.
create unique index if not exists paper_grade_jobs_generation_binding
  on public.paper_grade_jobs (user_id, run_id, accepted_attempt_id, generation);

-- Retrying generation issuance uses the same request id and therefore returns
-- the same generation instead of silently allocating another paid run.
create unique index if not exists paper_grade_jobs_issuance_request
  on public.paper_grade_jobs (user_id, run_id, accepted_attempt_id, issuance_request_id)
  where issuance_request_id is not null;

create index if not exists paper_grade_jobs_pending
  on public.paper_grade_jobs (user_id, run_id, accepted_attempt_id, status, generation desc);

alter table public.paper_grade_jobs enable row level security;
alter table public.paper_grade_jobs force row level security;
revoke all on table public.paper_grade_jobs from public, anon, authenticated, service_role;
grant select on table public.paper_grade_jobs to service_role;

-- The old submit-attempt BEFORE DELETE trigger also intercepted the FK cascade
-- from auth.users, making account deletion impossible.  Normal callers already
-- have no DELETE grant or delete policy, so guarding UPDATE preserves the
-- append-only protocol while allowing the declared account-retention cascade.
drop trigger if exists paper_submit_attempts_immutable on public.paper_submit_attempts;
create trigger paper_submit_attempts_immutable
before update on public.paper_submit_attempts
for each row execute function public.matha_paper_submit_attempt_immutable();

create or replace function public.matha_paper_grade_job_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id
      or old.run_id is distinct from new.run_id
      or old.accepted_attempt_id is distinct from new.accepted_attempt_id
      or old.generation is distinct from new.generation
      or old.issuance_request_id is distinct from new.issuance_request_id
      or old.created_at is distinct from new.created_at then
    raise exception 'paper grade job identity is immutable' using errcode = '55000';
  end if;
  if old.model_input_binding_sha256 is distinct from new.model_input_binding_sha256
      and (
        not (
          (old.status = 'reserved' and new.status = 'reserved'
            and old.lease_token is null and old.lease_expires_at is null)
          or (old.status = 'leased' and new.status = 'leased'
            and old.lease_expires_at <= now())
        )
        or old.dispatched_at is not null or old.completed_at is not null
      ) then
    raise exception 'paper grade model input binding is immutable after reservation' using errcode = '55000';
  end if;
  if old.status = 'completed' then
    raise exception 'completed paper grade job is immutable' using errcode = '55000';
  end if;
  if (old.status = 'reserved' and new.status not in ('reserved', 'leased'))
      or (old.status = 'leased' and new.status not in ('leased', 'dispatched'))
      or (old.status = 'dispatched' and new.status <> 'completed') then
    raise exception 'invalid paper grade job transition' using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.matha_paper_grade_job_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists paper_grade_jobs_guard on public.paper_grade_jobs;
create trigger paper_grade_jobs_guard
before update on public.paper_grade_jobs
for each row execute function public.matha_paper_grade_job_guard();

create or replace function public.matha_paper_grade_job_receipt(
  p_job public.paper_grade_jobs,
  p_action text
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'action', p_action,
    'status', (p_job).status,
    'run_id', (p_job).run_id,
    'accepted_attempt_id', (p_job).accepted_attempt_id,
    'model_input_binding_sha256', (p_job).model_input_binding_sha256,
    'generation', (p_job).generation,
    'issuance_request_id', (p_job).issuance_request_id,
    'lease_expires_at', (p_job).lease_expires_at,
    'dispatched_at', (p_job).dispatched_at,
    'completed_at', (p_job).completed_at,
    'result', case when (p_job).status = 'completed' then jsonb_build_object(
      'json', (p_job).normalized_model_json,
      'model_metadata', (p_job).model_metadata,
      'receipt_envelope', (p_job).receipt_envelope,
      'content_digests', jsonb_build_object(
        'normalized_model_json_sha256', (p_job).normalized_model_json_sha256,
        'model_metadata_sha256', (p_job).model_metadata_sha256,
        'receipt_envelope_sha256', (p_job).receipt_envelope_sha256
      )
    ) else null end
  );
$$;
revoke all on function public.matha_paper_grade_job_receipt(
  public.paper_grade_jobs, text
) from public, anon, authenticated, service_role;

-- Read-only terminal/in-flight recovery used when a device cannot prove that
-- its local composite is the immutable accepted snapshot.  A missing job is
-- reported without reserving one, so this path can never authorize a model
-- invocation or poison generation zero with caller-controlled bytes.
create or replace function public.matha_paper_grade_job_status(
  p_user_id uuid,
  p_run_id text,
  p_accepted_attempt_id text,
  p_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.paper_grade_jobs%rowtype;
begin
  if p_user_id is null
      or p_run_id !~ '^paper-run-[0-9]{10,20}$'
      or p_accepted_attempt_id !~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$'
      or p_generation not between 0 and 2147483647 then
    raise exception 'invalid paper grade job status request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.paper_submit_attempts
    where user_id = p_user_id and attempt_id = p_accepted_attempt_id
      and run_id = p_run_id and status = 'accepted'
      and decision_reason = 'accepted-first-for-run'
  ) then
    raise exception 'accepted paper submit winner required' using errcode = '42501';
  end if;
  select * into v_job from public.paper_grade_jobs
  where user_id = p_user_id and run_id = p_run_id
    and accepted_attempt_id = p_accepted_attempt_id
    and generation = p_generation;
  if not found then
    return jsonb_build_object(
      'action', 'missing', 'status', 'missing', 'generation', p_generation
    );
  end if;
  return public.matha_paper_grade_job_receipt(
    v_job,
    case when v_job.status = 'completed' then 'completed' else 'pending' end
  );
end;
$$;

-- Allocate a strictly new generation only for an explicit regrade request.
-- p_issuance_request_id makes a network retry idempotent.
create or replace function public.matha_paper_grade_issue_generation(
  p_user_id uuid,
  p_run_id text,
  p_accepted_attempt_id text,
  p_model_input_binding_sha256 text,
  p_previous_generation bigint,
  p_issuance_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_attempt public.paper_submit_attempts%rowtype;
  v_existing public.paper_grade_jobs%rowtype;
  v_job public.paper_grade_jobs%rowtype;
  v_generation bigint;
begin
  if p_user_id is null
      or p_run_id !~ '^paper-run-[0-9]{10,20}$'
      or p_accepted_attempt_id !~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$'
      or p_model_input_binding_sha256 !~ '^[0-9a-f]{64}$'
      or p_previous_generation not between 0 and 2147483646
      or p_issuance_request_id !~ '^paper-grade-generation-[A-Za-z0-9._:-]{16,127}$' then
    raise exception 'invalid paper grade generation request' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-grade:' || p_user_id::text || ':' || p_run_id || ':' || p_accepted_attempt_id,
    0
  ));

  select * into v_attempt from public.paper_submit_attempts
  where user_id = p_user_id and attempt_id = p_accepted_attempt_id
    and run_id = p_run_id and status = 'accepted'
    and decision_reason = 'accepted-first-for-run';
  if not found then
    raise exception 'accepted paper submit winner required' using errcode = '42501';
  end if;

  select * into v_existing from public.paper_grade_jobs
  where user_id = p_user_id and run_id = p_run_id
    and accepted_attempt_id = p_accepted_attempt_id
    and issuance_request_id = p_issuance_request_id;
  if found then
    if v_existing.generation = 0 then
      raise exception 'paper grade generation request is not explicit' using errcode = '22023';
    end if;
    -- A second device may encode the same accepted ink into different JPEG
    -- bytes.  The issuance id still names the already reserved generation; do
    -- not hide it or allocate another generation because the caller's newly
    -- composed binding drifted.
    return public.matha_paper_grade_job_receipt(v_existing, 'issued');
  end if;

  -- Compare-and-set issuance: two devices that both saw generation N may use
  -- different request ids, but they are both asking for N+1.  The advisory
  -- lock makes the first insert authoritative and every stale peer receives
  -- that same job.  A genuinely new N+2 is possible only after the client has
  -- observed/retained N+1 and explicitly sends it as p_previous_generation.
  v_generation := p_previous_generation + 1;
  select * into v_existing from public.paper_grade_jobs
  where user_id = p_user_id and run_id = p_run_id
    and accepted_attempt_id = p_accepted_attempt_id
    and generation = v_generation;
  if found then
    return public.matha_paper_grade_job_receipt(v_existing, 'issued');
  end if;

  if exists (
    select 1 from public.paper_grade_jobs
    where user_id = p_user_id and run_id = p_run_id
      and accepted_attempt_id = p_accepted_attempt_id
      and generation > p_previous_generation
  ) then
    raise exception 'paper grade previous generation is stale' using errcode = '40001';
  end if;
  if p_previous_generation > 0 and not exists (
    select 1 from public.paper_grade_jobs
    where user_id = p_user_id and run_id = p_run_id
      and accepted_attempt_id = p_accepted_attempt_id
      and generation = p_previous_generation
  ) then
    raise exception 'paper grade previous generation is unknown' using errcode = '22023';
  end if;

  insert into public.paper_grade_jobs (
    user_id, run_id, accepted_attempt_id, model_input_binding_sha256,
    generation, issuance_request_id, status
  ) values (
    p_user_id, p_run_id, p_accepted_attempt_id, p_model_input_binding_sha256,
    v_generation, p_issuance_request_id, 'reserved'
  ) returning * into v_job;
  return public.matha_paper_grade_job_receipt(v_job, 'issued');
end;
$$;

-- Claim the one pre-dispatch lease.  Only an expired leased job can be
-- recovered.  A dispatched job is never reclaimed because the external model
-- may already have charged even if its HTTP response was lost.
create or replace function public.matha_paper_grade_job_claim(
  p_user_id uuid,
  p_run_id text,
  p_accepted_attempt_id text,
  p_model_input_binding_sha256 text,
  p_generation bigint,
  p_lease_token text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.paper_submit_attempts%rowtype;
  v_job public.paper_grade_jobs%rowtype;
begin
  if p_user_id is null
      or p_run_id !~ '^paper-run-[0-9]{10,20}$'
      or p_accepted_attempt_id !~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$'
      or p_model_input_binding_sha256 !~ '^[0-9a-f]{64}$'
      or p_generation not between 0 and 2147483647
      or p_lease_token !~ '^paper-grade-lease-[A-Za-z0-9._:-]{16,127}$'
      or p_lease_seconds not between 30 and 300 then
    raise exception 'invalid paper grade job claim' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-grade:' || p_user_id::text || ':' || p_run_id || ':' || p_accepted_attempt_id,
    0
  ));

  select * into v_attempt from public.paper_submit_attempts
  where user_id = p_user_id and attempt_id = p_accepted_attempt_id
    and run_id = p_run_id and status = 'accepted'
    and decision_reason = 'accepted-first-for-run';
  if not found then
    raise exception 'accepted paper submit winner required' using errcode = '42501';
  end if;

  select * into v_job from public.paper_grade_jobs
  where user_id = p_user_id and run_id = p_run_id
    and accepted_attempt_id = p_accepted_attempt_id
    and generation = p_generation;

  if not found and p_generation = 0 then
    insert into public.paper_grade_jobs (
      user_id, run_id, accepted_attempt_id, model_input_binding_sha256,
      generation, issuance_request_id, status
    ) values (
      p_user_id, p_run_id, p_accepted_attempt_id, p_model_input_binding_sha256,
      0, null, 'reserved'
    ) returning * into v_job;
  elsif not found then
    raise exception 'server-issued paper grade generation required' using errcode = '42501';
  end if;

  if v_job.model_input_binding_sha256 <> p_model_input_binding_sha256 then
    if v_job.dispatched_at is null and v_job.status = 'reserved'
        and v_job.lease_token is null and v_job.lease_expires_at is null then
      -- Generation issuance and claim are separate requests.  If the issuer
      -- vanished before any lease/model activity, a retrying device may have
      -- an equivalent accepted snapshot encoded to different JPEG bytes.
      -- Rebinding an untouched reservation or an expired pre-dispatch lease is
      -- safe.  The following lease UPDATE replaces the old token; a crashed
      -- worker can therefore no longer mark its former binding dispatched.
      update public.paper_grade_jobs set
        model_input_binding_sha256 = p_model_input_binding_sha256
      where user_id = v_job.user_id and run_id = v_job.run_id
        and accepted_attempt_id = v_job.accepted_attempt_id
        and model_input_binding_sha256 = v_job.model_input_binding_sha256
        and generation = v_job.generation and status = 'reserved'
      returning * into v_job;
    elsif v_job.dispatched_at is null and v_job.status = 'leased'
        and v_job.lease_expires_at <= now() then
      -- Keep the row leased while atomically replacing both the binding and
      -- lease.  Moving leased -> reserved is forbidden by the state machine
      -- and would also leave a window in which the crashed token survived.
      update public.paper_grade_jobs set
        model_input_binding_sha256 = p_model_input_binding_sha256,
        status = 'leased',
        lease_token = p_lease_token,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds)
      where user_id = v_job.user_id and run_id = v_job.run_id
        and accepted_attempt_id = v_job.accepted_attempt_id
        and model_input_binding_sha256 = v_job.model_input_binding_sha256
        and generation = v_job.generation and status = 'leased'
        and dispatched_at is null and lease_expires_at <= now()
      returning * into v_job;
      if not found then
        raise exception 'expired paper grade lease could not be replaced'
          using errcode = '40001';
      end if;
      return public.matha_paper_grade_job_receipt(v_job, 'invoke');
    else
    -- The existing generation is authoritative.  Return its exact completed
    -- result or pending state, but never invoke the model with drifted bytes.
      return public.matha_paper_grade_job_receipt(
        v_job,
        case when v_job.status = 'completed' then 'completed' else 'pending' end
      );
    end if;
  end if;

  if v_job.status = 'completed' then
    return public.matha_paper_grade_job_receipt(v_job, 'completed');
  end if;
  if v_job.status = 'dispatched'
      or (v_job.status = 'leased' and v_job.lease_expires_at > now()
          and v_job.lease_token <> p_lease_token) then
    return public.matha_paper_grade_job_receipt(v_job, 'pending');
  end if;

  update public.paper_grade_jobs set
    status = 'leased', lease_token = p_lease_token,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where user_id = v_job.user_id and run_id = v_job.run_id
    and accepted_attempt_id = v_job.accepted_attempt_id
    and model_input_binding_sha256 = v_job.model_input_binding_sha256
    and generation = v_job.generation
  returning * into v_job;
  return public.matha_paper_grade_job_receipt(v_job, 'invoke');
end;
$$;

create or replace function public.matha_paper_grade_job_mark_dispatched(
  p_user_id uuid,
  p_run_id text,
  p_accepted_attempt_id text,
  p_model_input_binding_sha256 text,
  p_generation bigint,
  p_lease_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.paper_grade_jobs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-grade:' || p_user_id::text || ':' || p_run_id || ':' || p_accepted_attempt_id,
    0
  ));
  select * into v_job from public.paper_grade_jobs
  where user_id = p_user_id and run_id = p_run_id
    and accepted_attempt_id = p_accepted_attempt_id
    and model_input_binding_sha256 = p_model_input_binding_sha256
    and generation = p_generation;
  if not found then
    raise exception 'paper grade job missing' using errcode = '22023';
  end if;
  if v_job.status = 'completed' then
    return public.matha_paper_grade_job_receipt(v_job, 'completed');
  end if;
  if v_job.status = 'dispatched' then
    return public.matha_paper_grade_job_receipt(v_job, 'pending');
  end if;
  if v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
      or v_job.lease_expires_at <= now() then
    raise exception 'paper grade job lease lost' using errcode = '55000';
  end if;
  update public.paper_grade_jobs set
    status = 'dispatched', lease_expires_at = null, dispatched_at = now()
  where user_id = v_job.user_id and run_id = v_job.run_id
    and accepted_attempt_id = v_job.accepted_attempt_id
    and model_input_binding_sha256 = v_job.model_input_binding_sha256
    and generation = v_job.generation
  returning * into v_job;
  return public.matha_paper_grade_job_receipt(v_job, 'dispatched');
end;
$$;

create or replace function public.matha_paper_grade_job_complete(
  p_user_id uuid,
  p_run_id text,
  p_accepted_attempt_id text,
  p_model_input_binding_sha256 text,
  p_generation bigint,
  p_lease_token text,
  p_normalized_model_json jsonb,
  p_model_metadata jsonb,
  p_receipt_envelope jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.paper_grade_jobs%rowtype;
begin
  if p_normalized_model_json is null or jsonb_typeof(p_normalized_model_json) <> 'object'
      or octet_length(p_normalized_model_json::text) > 1000000
      or p_model_metadata is null or jsonb_typeof(p_model_metadata) <> 'object'
      or octet_length(p_model_metadata::text) > 100000
      or p_receipt_envelope is null or jsonb_typeof(p_receipt_envelope) <> 'object'
      or octet_length(p_receipt_envelope::text) > 1000000 then
    raise exception 'invalid paper grade completed payload' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-grade:' || p_user_id::text || ':' || p_run_id || ':' || p_accepted_attempt_id,
    0
  ));
  select * into v_job from public.paper_grade_jobs
  where user_id = p_user_id and run_id = p_run_id
    and accepted_attempt_id = p_accepted_attempt_id
    and model_input_binding_sha256 = p_model_input_binding_sha256
    and generation = p_generation;
  if not found then
    raise exception 'paper grade job missing' using errcode = '22023';
  end if;
  if v_job.status = 'completed' then
    if v_job.normalized_model_json is distinct from p_normalized_model_json
        or v_job.model_metadata is distinct from p_model_metadata
        or v_job.receipt_envelope is distinct from p_receipt_envelope then
      raise exception 'completed paper grade payload changed' using errcode = '55000';
    end if;
    return public.matha_paper_grade_job_receipt(v_job, 'completed');
  end if;
  if v_job.status <> 'dispatched' or v_job.lease_token <> p_lease_token then
    raise exception 'paper grade dispatched lease required' using errcode = '55000';
  end if;
  update public.paper_grade_jobs set
    status = 'completed', completed_at = now(),
    normalized_model_json = p_normalized_model_json,
    normalized_model_json_sha256 = encode(digest(convert_to(p_normalized_model_json::text, 'UTF8'), 'sha256'), 'hex'),
    model_metadata = p_model_metadata,
    model_metadata_sha256 = encode(digest(convert_to(p_model_metadata::text, 'UTF8'), 'sha256'), 'hex'),
    receipt_envelope = p_receipt_envelope,
    receipt_envelope_sha256 = encode(digest(convert_to(p_receipt_envelope::text, 'UTF8'), 'sha256'), 'hex')
  where user_id = v_job.user_id and run_id = v_job.run_id
    and accepted_attempt_id = v_job.accepted_attempt_id
    and model_input_binding_sha256 = v_job.model_input_binding_sha256
    and generation = v_job.generation
  returning * into v_job;
  return public.matha_paper_grade_job_receipt(v_job, 'completed');
end;
$$;

-- No browser role can see model output or call these state transitions.  Edge
-- uses the service role, and even it writes only through the guarded RPCs.
revoke all on function public.matha_paper_grade_issue_generation(uuid, text, text, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_grade_job_status(uuid, text, text, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_grade_job_claim(uuid, text, text, text, bigint, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_grade_job_mark_dispatched(uuid, text, text, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_grade_job_complete(uuid, text, text, text, bigint, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.matha_paper_grade_issue_generation(uuid, text, text, text, bigint, text)
  to service_role;
grant execute on function public.matha_paper_grade_job_status(uuid, text, text, bigint)
  to service_role;
grant execute on function public.matha_paper_grade_job_claim(uuid, text, text, text, bigint, text, integer)
  to service_role;
grant execute on function public.matha_paper_grade_job_mark_dispatched(uuid, text, text, text, bigint, text)
  to service_role;
grant execute on function public.matha_paper_grade_job_complete(uuid, text, text, text, bigint, text, jsonb, jsonb, jsonb)
  to service_role;
-- END PAPER GRADE JOB PROTOCOL 202608300003
