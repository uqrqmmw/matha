-- BEGIN PAPER DETAIL JOB PROTOCOL 202608300011
-- Service-role-only idempotency for one question-level detailed analysis.
-- The exact accepted paper attempt and immutable next-day correction receipt
-- are server verified before a generation can exist.  The business identity
-- deliberately excludes caller-computed hashes so drift cannot create a
-- second paid invocation.  A dispatched job is never leased again.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.paper_detail_jobs (
  job_id                          uuid primary key default extensions.gen_random_uuid(),
  user_id                         uuid not null references auth.users (id) on delete cascade,
  run_id                          text not null,
  source_id                       text not null,
  question_no                    integer not null,
  accepted_attempt_id             text not null,
  retry_receipt_id                text not null,
  retry_receipt_digest            text not null,
  generation                      integer not null,
  issuance_request_id              text,
  model_input_binding              jsonb not null,
  model_input_binding_sha256       text not null,
  input_background                 jsonb not null,
  input_background_sha256          text not null,
  status                           text not null,
  lease_token                      text,
  lease_expires_at                 timestamptz,
  lease_attempts                   integer not null default 0,
  dispatched_at                    timestamptz,
  completed_at                     timestamptz,
  normalized_result                jsonb,
  normalized_result_sha256         text,
  model_metadata                   jsonb,
  model_metadata_sha256            text,
  result_receipt                   jsonb,
  result_receipt_sha256             text,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now(),
  foreign key (user_id, accepted_attempt_id)
    references public.paper_submit_attempts (user_id, attempt_id) on delete cascade,
  foreign key (user_id, retry_receipt_id)
    references public.paper_correction_retry_receipts (user_id, receipt_id)
    on delete cascade,
  constraint paper_detail_job_identity_valid check (
    run_id ~ '^paper-run-[0-9]{10,20}$'
    and length(source_id) between 1 and 160
    and question_no between 1 and 20
    and accepted_attempt_id ~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$'
    and retry_receipt_id ~ '^paper-correction-retry-[A-Za-z0-9._:-]{16,127}$'
    and retry_receipt_digest ~ '^[0-9a-f]{64}$'
    and generation between 0 and 2147483647
    and model_input_binding_sha256 ~ '^[0-9a-f]{64}$'
    and input_background_sha256 ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(model_input_binding) = 'object'
    and pg_column_size(model_input_binding) <= 200000
    and jsonb_typeof(input_background) = 'object'
    and pg_column_size(input_background) <= 200000
    and lease_attempts between 0 and 1000
  ),
  constraint paper_detail_job_issuance_valid check (
    (generation = 0 and issuance_request_id is null)
    or
    (generation > 0 and issuance_request_id
      ~ '^paper-detail-generation-[A-Za-z0-9._:-]{16,127}$')
  ),
  constraint paper_detail_job_status_valid check (
    status in ('reserved', 'leased', 'dispatched', 'completed')
  ),
  constraint paper_detail_job_state_shape_valid check (
    (
      status = 'reserved'
      and lease_token is null and lease_expires_at is null
      and lease_attempts = 0
      and dispatched_at is null and completed_at is null
      and normalized_result is null and normalized_result_sha256 is null
      and model_metadata is null and model_metadata_sha256 is null
      and result_receipt is null and result_receipt_sha256 is null
    )
    or
    (
      status = 'leased'
      and lease_token ~ '^paper-detail-lease-[A-Za-z0-9._:-]{16,127}$'
      and lease_expires_at is not null and lease_attempts between 1 and 1000
      and dispatched_at is null and completed_at is null
      and normalized_result is null and normalized_result_sha256 is null
      and model_metadata is null and model_metadata_sha256 is null
      and result_receipt is null and result_receipt_sha256 is null
    )
    or
    (
      status = 'dispatched'
      and lease_token ~ '^paper-detail-lease-[A-Za-z0-9._:-]{16,127}$'
      and lease_expires_at is null and lease_attempts between 1 and 1000
      and dispatched_at is not null and completed_at is null
      and normalized_result is null and normalized_result_sha256 is null
      and model_metadata is null and model_metadata_sha256 is null
      and result_receipt is null and result_receipt_sha256 is null
    )
    or
    (
      status = 'completed'
      and lease_token ~ '^paper-detail-lease-[A-Za-z0-9._:-]{16,127}$'
      and lease_expires_at is null and lease_attempts between 1 and 1000
      and dispatched_at is not null and completed_at is not null
      and jsonb_typeof(normalized_result) = 'object'
      and normalized_result_sha256 ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(model_metadata) = 'object'
      and model_metadata_sha256 ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(result_receipt) = 'object'
      and result_receipt_sha256 ~ '^[0-9a-f]{64}$'
    )
  )
);

create unique index if not exists paper_detail_job_one_binding_per_generation
  on public.paper_detail_jobs (
    user_id, run_id, source_id, question_no, retry_receipt_id, generation
  );
create unique index if not exists paper_detail_job_issuance_request
  on public.paper_detail_jobs (
    user_id, run_id, source_id, question_no, retry_receipt_id,
    issuance_request_id
  ) where issuance_request_id is not null;
create unique index if not exists paper_detail_job_exact_identity
  on public.paper_detail_jobs (
    user_id, run_id, source_id, question_no, retry_receipt_id, generation,
    retry_receipt_digest, model_input_binding_sha256, input_background_sha256
  );
create index if not exists paper_detail_job_owner_status
  on public.paper_detail_jobs (
    user_id, run_id, source_id, question_no, retry_receipt_id,
    status, generation desc
  );

alter table public.paper_detail_jobs enable row level security;
alter table public.paper_detail_jobs force row level security;
revoke all on table public.paper_detail_jobs
  from public, anon, authenticated, service_role;
grant select on table public.paper_detail_jobs to authenticated, service_role;

drop policy if exists "own paper detail jobs read" on public.paper_detail_jobs;
create policy "own paper detail jobs read"
  on public.paper_detail_jobs for select to authenticated
  using (auth.uid() = user_id and public.is_matha_user(auth.uid()));

create or replace function public.matha_paper_detail_job_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.job_id is distinct from new.job_id
      or old.user_id is distinct from new.user_id
      or old.run_id is distinct from new.run_id
      or old.source_id is distinct from new.source_id
      or old.question_no is distinct from new.question_no
      or old.accepted_attempt_id is distinct from new.accepted_attempt_id
      or old.retry_receipt_id is distinct from new.retry_receipt_id
      or old.retry_receipt_digest is distinct from new.retry_receipt_digest
      or old.generation is distinct from new.generation
      or old.issuance_request_id is distinct from new.issuance_request_id
      or old.model_input_binding is distinct from new.model_input_binding
      or old.model_input_binding_sha256 is distinct from new.model_input_binding_sha256
      or old.input_background is distinct from new.input_background
      or old.input_background_sha256 is distinct from new.input_background_sha256
      or old.created_at is distinct from new.created_at then
    raise exception 'paper detail job identity is immutable' using errcode = '55000';
  end if;
  if old.status = 'completed' then
    raise exception 'completed paper detail job is immutable' using errcode = '55000';
  end if;
  if (old.status = 'reserved' and new.status not in ('reserved', 'leased'))
      or (old.status = 'leased' and new.status = 'leased'
        and not (old.dispatched_at is null and old.lease_expires_at <= now()))
      or (old.status = 'leased' and new.status not in ('leased', 'dispatched'))
      or (old.status = 'dispatched' and new.status <> 'completed') then
    raise exception 'invalid paper detail job transition' using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.matha_paper_detail_job_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists paper_detail_jobs_guard on public.paper_detail_jobs;
create trigger paper_detail_jobs_guard
before update on public.paper_detail_jobs
for each row execute function public.matha_paper_detail_job_guard();

create or replace function public.matha_paper_detail_job_payload(
  p_job public.paper_detail_jobs,
  p_action text
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'authority', 'supabase-paper-detail-job-v1',
    'action', p_action,
    'job_id', (p_job).job_id,
    'status', (p_job).status,
    'run_id', (p_job).run_id,
    'source_id', (p_job).source_id,
    'question_no', (p_job).question_no,
    'accepted_attempt_id', (p_job).accepted_attempt_id,
    'retry_receipt_id', (p_job).retry_receipt_id,
    'retry_receipt_digest', (p_job).retry_receipt_digest,
    'generation', (p_job).generation,
    'issuance_request_id', (p_job).issuance_request_id,
    'model_input_binding', (p_job).model_input_binding,
    'model_input_binding_sha256', (p_job).model_input_binding_sha256,
    'input_background', (p_job).input_background,
    'input_background_sha256', (p_job).input_background_sha256,
    'dispatched_at', (p_job).dispatched_at,
    'completed_at', (p_job).completed_at,
    'result', case when (p_job).status = 'completed' then jsonb_build_object(
      'json', (p_job).normalized_result,
      'model_metadata', (p_job).model_metadata,
      'receipt', (p_job).result_receipt,
      'content_digests', jsonb_build_object(
        'normalized_result_sha256', (p_job).normalized_result_sha256,
        'model_metadata_sha256', (p_job).model_metadata_sha256,
        'result_receipt_sha256', (p_job).result_receipt_sha256
      )
    ) else null end
  ) || case when p_action = 'invoke' then jsonb_build_object(
    'lease_token', (p_job).lease_token,
    'lease_expires_at', (p_job).lease_expires_at
  ) else '{}'::jsonb end;
$$;
revoke all on function public.matha_paper_detail_job_payload(
  public.paper_detail_jobs, text
) from public, anon, authenticated, service_role;

create or replace function public.matha_paper_detail_assert_authority(
  p_user_id uuid,
  p_run_id text,
  p_source_id text,
  p_question_no integer,
  p_accepted_attempt_id text,
  p_retry_receipt_id text,
  p_retry_receipt_digest text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null
      or p_run_id !~ '^paper-run-[0-9]{10,20}$'
      or p_source_id is null or length(p_source_id) not between 1 and 160
      or p_question_no not between 1 and 20
      or p_accepted_attempt_id !~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$'
      or p_retry_receipt_id !~ '^paper-correction-retry-[A-Za-z0-9._:-]{16,127}$'
      or p_retry_receipt_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid paper detail authority identity' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.paper_submit_attempts
    where user_id = p_user_id and attempt_id = p_accepted_attempt_id
      and run_id = p_run_id and source_id = p_source_id
      and status = 'accepted' and decision_reason = 'accepted-first-for-run'
  ) then
    raise exception 'accepted paper submit winner required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.paper_correction_retry_receipts
    where user_id = p_user_id and receipt_id = p_retry_receipt_id
      and run_id = p_run_id and source_id = p_source_id
      and question_no = p_question_no
      and accepted_attempt_id = p_accepted_attempt_id
      and canonical_digest = p_retry_receipt_digest
  ) then
    raise exception 'exact immutable correction retry receipt required'
      using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.matha_paper_detail_assert_authority(
  uuid, text, text, integer, text, text, text
) from public, anon, authenticated, service_role;

create or replace function public.matha_paper_detail_issue_generation(
  p_user_id uuid,
  p_run_id text,
  p_source_id text,
  p_question_no integer,
  p_accepted_attempt_id text,
  p_retry_receipt_id text,
  p_retry_receipt_digest text,
  p_model_input_binding jsonb,
  p_model_input_binding_sha256 text,
  p_input_background jsonb,
  p_input_background_sha256 text,
  p_previous_generation integer,
  p_issuance_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_existing public.paper_detail_jobs%rowtype;
  v_job public.paper_detail_jobs%rowtype;
  v_generation integer;
begin
  perform public.matha_paper_detail_assert_authority(
    p_user_id, p_run_id, p_source_id, p_question_no,
    p_accepted_attempt_id, p_retry_receipt_id, p_retry_receipt_digest
  );
  if p_model_input_binding is null or jsonb_typeof(p_model_input_binding) <> 'object'
      or pg_column_size(p_model_input_binding) > 200000
      or p_model_input_binding_sha256 !~ '^[0-9a-f]{64}$'
      or p_input_background is null or jsonb_typeof(p_input_background) <> 'object'
      or pg_column_size(p_input_background) > 200000
      or p_input_background_sha256 !~ '^[0-9a-f]{64}$'
      or encode(extensions.digest(convert_to(
        public.matha_canonical_jsonb_text(p_model_input_binding), 'UTF8'
      ), 'sha256'), 'hex') <> p_model_input_binding_sha256
      or encode(extensions.digest(convert_to(
        public.matha_canonical_jsonb_text(p_input_background), 'UTF8'
      ), 'sha256'), 'hex') <> p_input_background_sha256
      or p_previous_generation not between 0 and 2147483646
      or p_issuance_request_id
        !~ '^paper-detail-generation-[A-Za-z0-9._:-]{16,127}$' then
    raise exception 'invalid paper detail generation request' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-detail:' || p_user_id::text || ':' || p_run_id || ':'
      || p_source_id || ':' || p_question_no::text || ':' || p_retry_receipt_id,
    0
  ));
  select * into v_existing from public.paper_detail_jobs
  where user_id = p_user_id and run_id = p_run_id and source_id = p_source_id
    and question_no = p_question_no and retry_receipt_id = p_retry_receipt_id
    and issuance_request_id = p_issuance_request_id;
  if found then
    return public.matha_paper_detail_job_payload(v_existing, 'issued');
  end if;

  v_generation := p_previous_generation + 1;
  select * into v_existing from public.paper_detail_jobs
  where user_id = p_user_id and run_id = p_run_id and source_id = p_source_id
    and question_no = p_question_no and retry_receipt_id = p_retry_receipt_id
    and generation = v_generation;
  if found then
    return public.matha_paper_detail_job_payload(v_existing, 'issued');
  end if;
  if exists (
    select 1 from public.paper_detail_jobs
    where user_id = p_user_id and run_id = p_run_id and source_id = p_source_id
      and question_no = p_question_no and retry_receipt_id = p_retry_receipt_id
      and generation > p_previous_generation
  ) then
    raise exception 'paper detail previous generation is stale' using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.paper_detail_jobs
    where user_id = p_user_id and run_id = p_run_id and source_id = p_source_id
      and question_no = p_question_no and retry_receipt_id = p_retry_receipt_id
      and generation = p_previous_generation
  ) then
    raise exception 'paper detail previous generation is unknown' using errcode = '22023';
  end if;

  insert into public.paper_detail_jobs (
    user_id, run_id, source_id, question_no, accepted_attempt_id,
    retry_receipt_id, retry_receipt_digest, generation, issuance_request_id,
    model_input_binding, model_input_binding_sha256,
    input_background, input_background_sha256, status
  ) values (
    p_user_id, p_run_id, p_source_id, p_question_no, p_accepted_attempt_id,
    p_retry_receipt_id, p_retry_receipt_digest, v_generation, p_issuance_request_id,
    p_model_input_binding, p_model_input_binding_sha256,
    p_input_background, p_input_background_sha256, 'reserved'
  ) returning * into v_job;
  return public.matha_paper_detail_job_payload(v_job, 'issued');
end;
$$;

create or replace function public.matha_paper_detail_job_claim(
  p_user_id uuid,
  p_run_id text,
  p_source_id text,
  p_question_no integer,
  p_accepted_attempt_id text,
  p_retry_receipt_id text,
  p_retry_receipt_digest text,
  p_generation integer,
  p_model_input_binding jsonb,
  p_model_input_binding_sha256 text,
  p_input_background jsonb,
  p_input_background_sha256 text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.paper_detail_jobs%rowtype;
  v_lease_token text;
begin
  perform public.matha_paper_detail_assert_authority(
    p_user_id, p_run_id, p_source_id, p_question_no,
    p_accepted_attempt_id, p_retry_receipt_id, p_retry_receipt_digest
  );
  if p_generation not between 0 and 2147483647
      or p_model_input_binding is null or jsonb_typeof(p_model_input_binding) <> 'object'
      or pg_column_size(p_model_input_binding) > 200000
      or p_model_input_binding_sha256 !~ '^[0-9a-f]{64}$'
      or p_input_background is null or jsonb_typeof(p_input_background) <> 'object'
      or pg_column_size(p_input_background) > 200000
      or p_input_background_sha256 !~ '^[0-9a-f]{64}$'
      or encode(extensions.digest(convert_to(
        public.matha_canonical_jsonb_text(p_model_input_binding), 'UTF8'
      ), 'sha256'), 'hex') <> p_model_input_binding_sha256
      or encode(extensions.digest(convert_to(
        public.matha_canonical_jsonb_text(p_input_background), 'UTF8'
      ), 'sha256'), 'hex') <> p_input_background_sha256
      or p_lease_seconds not between 30 and 300 then
    raise exception 'invalid paper detail job claim' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-detail:' || p_user_id::text || ':' || p_run_id || ':'
      || p_source_id || ':' || p_question_no::text || ':' || p_retry_receipt_id,
    0
  ));
  select * into v_job from public.paper_detail_jobs
  where user_id = p_user_id and run_id = p_run_id and source_id = p_source_id
    and question_no = p_question_no and retry_receipt_id = p_retry_receipt_id
    and generation = p_generation;
  if found then
    if v_job.accepted_attempt_id <> p_accepted_attempt_id
        or v_job.retry_receipt_digest <> p_retry_receipt_digest
        or v_job.model_input_binding_sha256 <> p_model_input_binding_sha256
        or v_job.model_input_binding is distinct from p_model_input_binding
        or v_job.input_background_sha256 <> p_input_background_sha256
        or v_job.input_background is distinct from p_input_background then
      raise exception 'paper detail immutable binding changed' using errcode = '22023';
    end if;
    if v_job.status = 'completed' then
      return public.matha_paper_detail_job_payload(v_job, 'completed');
    end if;
    if v_job.status = 'dispatched'
        or (v_job.status = 'leased' and v_job.lease_expires_at > now()) then
      return public.matha_paper_detail_job_payload(v_job, 'pending');
    end if;
    if v_job.status not in ('reserved', 'leased') or v_job.dispatched_at is not null then
      raise exception 'paper detail job cannot be reclaimed' using errcode = '55000';
    end if;
  else
    if p_generation <> 0 then
      raise exception 'paper detail generation must be server issued' using errcode = '42501';
    end if;
    insert into public.paper_detail_jobs (
      user_id, run_id, source_id, question_no, accepted_attempt_id,
      retry_receipt_id, retry_receipt_digest, generation, issuance_request_id,
      model_input_binding, model_input_binding_sha256,
      input_background, input_background_sha256, status
    ) values (
      p_user_id, p_run_id, p_source_id, p_question_no, p_accepted_attempt_id,
      p_retry_receipt_id, p_retry_receipt_digest, 0, null,
      p_model_input_binding, p_model_input_binding_sha256,
      p_input_background, p_input_background_sha256, 'reserved'
    ) returning * into v_job;
  end if;

  v_lease_token := 'paper-detail-lease-' || extensions.gen_random_uuid()::text;
  update public.paper_detail_jobs set
    status = 'leased', lease_token = v_lease_token,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    lease_attempts = lease_attempts + 1
  where job_id = v_job.job_id
    and (status = 'reserved' or (
      status = 'leased' and dispatched_at is null and lease_expires_at <= now()
    ))
  returning * into v_job;
  if not found then
    raise exception 'paper detail lease race lost' using errcode = '40001';
  end if;
  return public.matha_paper_detail_job_payload(v_job, 'invoke');
end;
$$;

create or replace function public.matha_paper_detail_job_mark_dispatched(
  p_user_id uuid,
  p_job_id uuid,
  p_lease_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.paper_detail_jobs%rowtype;
begin
  if p_user_id is null or p_job_id is null
      or p_lease_token !~ '^paper-detail-lease-[A-Za-z0-9._:-]{16,127}$' then
    raise exception 'invalid paper detail dispatch request' using errcode = '22023';
  end if;
  select * into v_job from public.paper_detail_jobs
  where user_id = p_user_id and job_id = p_job_id for update;
  if not found then
    raise exception 'paper detail job identity mismatch' using errcode = '22023';
  end if;
  if v_job.status = 'completed' then
    return public.matha_paper_detail_job_payload(v_job, 'completed');
  end if;
  if v_job.status = 'dispatched' then
    if v_job.lease_token <> p_lease_token then
      raise exception 'paper detail dispatch lease mismatch' using errcode = '55000';
    end if;
    return public.matha_paper_detail_job_payload(v_job, 'pending');
  end if;
  if v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
      or v_job.lease_expires_at <= now() then
    raise exception 'paper detail lease lost' using errcode = '55000';
  end if;
  update public.paper_detail_jobs set
    status = 'dispatched', lease_expires_at = null, dispatched_at = now()
  where job_id = v_job.job_id and status = 'leased'
    and lease_token = p_lease_token and lease_expires_at > now()
  returning * into v_job;
  if not found then
    raise exception 'paper detail dispatch race lost' using errcode = '40001';
  end if;
  return public.matha_paper_detail_job_payload(v_job, 'dispatched');
end;
$$;

create or replace function public.matha_paper_detail_job_complete(
  p_user_id uuid,
  p_job_id uuid,
  p_lease_token text,
  p_normalized_result jsonb,
  p_model_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.paper_detail_jobs%rowtype;
  v_result_sha256 text;
  v_metadata_sha256 text;
  v_completed_at timestamptz;
  v_core jsonb;
  v_receipt jsonb;
  v_receipt_sha256 text;
begin
  if p_user_id is null or p_job_id is null
      or p_lease_token !~ '^paper-detail-lease-[A-Za-z0-9._:-]{16,127}$'
      or p_normalized_result is null or jsonb_typeof(p_normalized_result) <> 'object'
      or pg_column_size(p_normalized_result) > 1000000
      or p_model_metadata is null or jsonb_typeof(p_model_metadata) <> 'object'
      or pg_column_size(p_model_metadata) > 100000 then
    raise exception 'invalid paper detail completed payload' using errcode = '22023';
  end if;
  v_result_sha256 := encode(extensions.digest(convert_to(
    public.matha_canonical_jsonb_text(p_normalized_result), 'UTF8'
  ), 'sha256'), 'hex');
  v_metadata_sha256 := encode(extensions.digest(convert_to(
    public.matha_canonical_jsonb_text(p_model_metadata), 'UTF8'
  ), 'sha256'), 'hex');

  select * into v_job from public.paper_detail_jobs
  where user_id = p_user_id and job_id = p_job_id for update;
  if not found then
    raise exception 'paper detail job identity mismatch' using errcode = '22023';
  end if;
  if v_job.status = 'completed' then
    if v_job.lease_token <> p_lease_token
        or v_job.normalized_result_sha256 <> v_result_sha256
        or v_job.model_metadata_sha256 <> v_metadata_sha256
        or v_job.normalized_result is distinct from p_normalized_result
        or v_job.model_metadata is distinct from p_model_metadata then
      raise exception 'completed paper detail payload changed' using errcode = '55000';
    end if;
    return public.matha_paper_detail_job_payload(v_job, 'completed');
  end if;
  if v_job.status <> 'dispatched' or v_job.lease_token <> p_lease_token then
    raise exception 'dispatched paper detail lease required' using errcode = '55000';
  end if;

  v_completed_at := clock_timestamp();
  v_core := jsonb_build_object(
    'authority', 'supabase-immutable-paper-detail-result-v1',
    'jobId', v_job.job_id,
    'jobKind', 'paper_detail',
    'generation', v_job.generation,
    'runId', v_job.run_id,
    'sourceId', v_job.source_id,
    'questionNo', v_job.question_no,
    'acceptedAttemptId', v_job.accepted_attempt_id,
    'retryReceiptId', v_job.retry_receipt_id,
    'retryReceiptDigest', v_job.retry_receipt_digest,
    'modelInputBindingSha256', v_job.model_input_binding_sha256,
    'inputBackgroundSha256', v_job.input_background_sha256,
    'normalizedResultSha256', v_result_sha256,
    'modelMetadataSha256', v_metadata_sha256,
    'completedAt', to_char(v_completed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_receipt_sha256 := encode(extensions.digest(convert_to(
    public.matha_canonical_jsonb_text(v_core), 'UTF8'
  ), 'sha256'), 'hex');
  v_receipt := v_core || jsonb_build_object('canonicalDigest', v_receipt_sha256);

  update public.paper_detail_jobs set
    status = 'completed', completed_at = v_completed_at,
    normalized_result = p_normalized_result,
    normalized_result_sha256 = v_result_sha256,
    model_metadata = p_model_metadata,
    model_metadata_sha256 = v_metadata_sha256,
    result_receipt = v_receipt,
    result_receipt_sha256 = v_receipt_sha256
  where job_id = v_job.job_id and status = 'dispatched'
    and lease_token = p_lease_token
  returning * into v_job;
  if not found then
    raise exception 'paper detail completion race lost' using errcode = '40001';
  end if;
  return public.matha_paper_detail_job_payload(v_job, 'completed');
end;
$$;

create or replace function public.matha_paper_detail_job_status(
  p_user_id uuid,
  p_run_id text,
  p_source_id text,
  p_question_no integer,
  p_accepted_attempt_id text,
  p_retry_receipt_id text,
  p_retry_receipt_digest text,
  p_generation integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.paper_detail_jobs%rowtype;
begin
  perform public.matha_paper_detail_assert_authority(
    p_user_id, p_run_id, p_source_id, p_question_no,
    p_accepted_attempt_id, p_retry_receipt_id, p_retry_receipt_digest
  );
  if p_generation not between 0 and 2147483647 then
    raise exception 'invalid paper detail status request' using errcode = '22023';
  end if;
  select * into v_job from public.paper_detail_jobs
  where user_id = p_user_id and run_id = p_run_id and source_id = p_source_id
    and question_no = p_question_no and accepted_attempt_id = p_accepted_attempt_id
    and retry_receipt_id = p_retry_receipt_id
    and retry_receipt_digest = p_retry_receipt_digest
    and generation = p_generation;
  if not found then
    return jsonb_build_object(
      'authority', 'supabase-paper-detail-job-v1',
      'action', 'missing', 'status', 'missing',
      'run_id', p_run_id, 'source_id', p_source_id,
      'question_no', p_question_no,
      'accepted_attempt_id', p_accepted_attempt_id,
      'retry_receipt_id', p_retry_receipt_id,
      'retry_receipt_digest', p_retry_receipt_digest,
      'generation', p_generation
    );
  end if;
  return public.matha_paper_detail_job_payload(
    v_job,
    case when v_job.status = 'completed' then 'completed' else 'pending' end
  );
end;
$$;

revoke all on function public.matha_paper_detail_issue_generation(
  uuid, text, text, integer, text, text, text, jsonb, text,
  jsonb, text, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_detail_job_claim(
  uuid, text, text, integer, text, text, text, integer,
  jsonb, text, jsonb, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_detail_job_mark_dispatched(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_detail_job_complete(
  uuid, uuid, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_detail_job_status(
  uuid, text, text, integer, text, text, text, integer
) from public, anon, authenticated, service_role;

grant execute on function public.matha_paper_detail_issue_generation(
  uuid, text, text, integer, text, text, text, jsonb, text,
  jsonb, text, integer, text
) to service_role;
grant execute on function public.matha_paper_detail_job_claim(
  uuid, text, text, integer, text, text, text, integer,
  jsonb, text, jsonb, text, integer
) to service_role;
grant execute on function public.matha_paper_detail_job_mark_dispatched(
  uuid, uuid, text
) to service_role;
grant execute on function public.matha_paper_detail_job_complete(
  uuid, uuid, text, jsonb, jsonb
) to service_role;
grant execute on function public.matha_paper_detail_job_status(
  uuid, text, text, integer, text, text, text, integer
) to service_role;
-- END PAPER DETAIL JOB PROTOCOL 202608300011
