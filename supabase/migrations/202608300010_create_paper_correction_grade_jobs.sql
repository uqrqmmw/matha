-- BEGIN PAPER CORRECTION GRADE JOB PROTOCOL 202608300010
-- Service-role-only idempotency for one AI correction regrade.  The immutable
-- retry receipt names the exact question geometry; one receipt may bind to
-- only one model input.  A worker must mark the job dispatched before calling
-- the external model.  Dispatched jobs are never leased again, because a lost
-- HTTP response must not become a duplicate model charge.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.paper_correction_grade_jobs (
  job_id                         uuid primary key default extensions.gen_random_uuid(),
  user_id                        uuid not null references auth.users (id) on delete cascade,
  run_id                         text not null,
  source_id                      text not null,
  question_no                   integer not null,
  retry_receipt_id               text not null,
  retry_receipt_digest           text not null,
  model_input_binding_sha256      text not null,
  status                          text not null,
  lease_token                     text,
  lease_expires_at                timestamptz,
  lease_attempts                  integer not null default 1,
  dispatched_at                   timestamptz,
  completed_at                    timestamptz,
  normalized_result               jsonb,
  normalized_result_sha256        text,
  model_metadata                  jsonb,
  model_metadata_sha256           text,
  result_receipt                  jsonb,
  result_receipt_sha256           text,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  foreign key (user_id, retry_receipt_id)
    references public.paper_correction_retry_receipts (user_id, receipt_id)
    on delete cascade,
  constraint paper_correction_grade_job_identity_valid check (
    run_id ~ '^paper-run-[0-9]{10,20}$'
    and length(source_id) between 1 and 160
    and question_no between 1 and 20
    and retry_receipt_id ~ '^paper-correction-retry-[A-Za-z0-9._:-]{16,127}$'
    and retry_receipt_digest ~ '^[0-9a-f]{64}$'
    and model_input_binding_sha256 ~ '^[0-9a-f]{64}$'
    and lease_attempts between 1 and 1000
  ),
  constraint paper_correction_grade_job_status_valid check (
    status in ('leased', 'dispatched', 'completed')
  ),
  constraint paper_correction_grade_job_state_shape_valid check (
    (
      status = 'leased'
      and lease_token ~ '^paper-correction-grade-lease-[A-Za-z0-9._:-]{16,127}$'
      and lease_expires_at is not null
      and dispatched_at is null and completed_at is null
      and normalized_result is null and normalized_result_sha256 is null
      and model_metadata is null and model_metadata_sha256 is null
      and result_receipt is null and result_receipt_sha256 is null
    )
    or
    (
      status = 'dispatched'
      and lease_token ~ '^paper-correction-grade-lease-[A-Za-z0-9._:-]{16,127}$'
      and lease_expires_at is null
      and dispatched_at is not null and completed_at is null
      and normalized_result is null and normalized_result_sha256 is null
      and model_metadata is null and model_metadata_sha256 is null
      and result_receipt is null and result_receipt_sha256 is null
    )
    or
    (
      status = 'completed'
      and lease_token ~ '^paper-correction-grade-lease-[A-Za-z0-9._:-]{16,127}$'
      and lease_expires_at is null
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

-- The business identity deliberately excludes the model binding: a retry with
-- drifted bytes must hit the existing row and fail, not create another paid
-- job.  The second index documents and accelerates exact full-identity replay.
create unique index if not exists paper_correction_grade_job_one_binding
  on public.paper_correction_grade_jobs (
    user_id, run_id, source_id, question_no, retry_receipt_id
  );
create unique index if not exists paper_correction_grade_job_exact_identity
  on public.paper_correction_grade_jobs (
    user_id, run_id, source_id, question_no, retry_receipt_id,
    retry_receipt_digest, model_input_binding_sha256
  );
create index if not exists paper_correction_grade_job_owner_status
  on public.paper_correction_grade_jobs (user_id, run_id, question_no, status);

alter table public.paper_correction_grade_jobs enable row level security;
alter table public.paper_correction_grade_jobs force row level security;
revoke all on table public.paper_correction_grade_jobs
  from public, anon, authenticated, service_role;
grant select on table public.paper_correction_grade_jobs
  to authenticated, service_role;

drop policy if exists "own paper correction grade jobs read"
  on public.paper_correction_grade_jobs;
create policy "own paper correction grade jobs read"
  on public.paper_correction_grade_jobs
  for select to authenticated
  using (auth.uid() = user_id and public.is_matha_user(auth.uid()));

create or replace function public.matha_paper_correction_grade_job_guard()
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
      or old.retry_receipt_id is distinct from new.retry_receipt_id
      or old.retry_receipt_digest is distinct from new.retry_receipt_digest
      or old.model_input_binding_sha256 is distinct from new.model_input_binding_sha256
      or old.created_at is distinct from new.created_at then
    raise exception 'paper correction grade job identity is immutable'
      using errcode = '55000';
  end if;
  if old.status = 'completed' then
    raise exception 'completed paper correction grade job is immutable'
      using errcode = '55000';
  end if;
  if (old.status = 'leased' and new.status = 'leased'
        and not (old.dispatched_at is null and old.lease_expires_at <= now()))
      or (old.status = 'leased' and new.status not in ('leased', 'dispatched'))
      or (old.status = 'dispatched' and new.status <> 'completed') then
    raise exception 'invalid paper correction grade job transition'
      using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.matha_paper_correction_grade_job_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists paper_correction_grade_jobs_guard
  on public.paper_correction_grade_jobs;
create trigger paper_correction_grade_jobs_guard
before update on public.paper_correction_grade_jobs
for each row execute function public.matha_paper_correction_grade_job_guard();

create or replace function public.matha_paper_correction_grade_job_payload(
  p_job public.paper_correction_grade_jobs,
  p_action text
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'authority', 'supabase-paper-correction-grade-job-v1',
    'action', p_action,
    'job_id', (p_job).job_id,
    'status', (p_job).status,
    'run_id', (p_job).run_id,
    'source_id', (p_job).source_id,
    'question_no', (p_job).question_no,
    'retry_receipt_id', (p_job).retry_receipt_id,
    'retry_receipt_digest', (p_job).retry_receipt_digest,
    'model_input_binding_sha256', (p_job).model_input_binding_sha256,
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
revoke all on function public.matha_paper_correction_grade_job_payload(
  public.paper_correction_grade_jobs, text
) from public, anon, authenticated, service_role;

create or replace function public.matha_paper_correction_grade_job_claim(
  p_user_id uuid,
  p_run_id text,
  p_source_id text,
  p_question_no integer,
  p_retry_receipt_id text,
  p_retry_receipt_digest text,
  p_model_input_binding_sha256 text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_retry public.paper_correction_retry_receipts%rowtype;
  v_job public.paper_correction_grade_jobs%rowtype;
  v_lease_token text;
begin
  if p_user_id is null
      or p_run_id !~ '^paper-run-[0-9]{10,20}$'
      or p_source_id is null or length(p_source_id) not between 1 and 160
      or p_question_no not between 1 and 20
      or p_retry_receipt_id !~ '^paper-correction-retry-[A-Za-z0-9._:-]{16,127}$'
      or p_retry_receipt_digest !~ '^[0-9a-f]{64}$'
      or p_model_input_binding_sha256 !~ '^[0-9a-f]{64}$'
      or p_lease_seconds not between 30 and 300 then
    raise exception 'invalid paper correction grade job claim'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-correction-grade:' || p_user_id::text || ':' || p_run_id
      || ':' || p_question_no::text || ':' || p_retry_receipt_id,
    0
  ));

  select * into v_retry from public.paper_correction_retry_receipts
  where user_id = p_user_id and receipt_id = p_retry_receipt_id
    and run_id = p_run_id and source_id = p_source_id
    and question_no = p_question_no
    and canonical_digest = p_retry_receipt_digest;
  if not found then
    raise exception 'exact immutable correction retry receipt required'
      using errcode = '42501';
  end if;

  select * into v_job from public.paper_correction_grade_jobs
  where user_id = p_user_id and run_id = p_run_id
    and source_id = p_source_id and question_no = p_question_no
    and retry_receipt_id = p_retry_receipt_id;
  if found then
    if v_job.retry_receipt_digest <> p_retry_receipt_digest
        or v_job.model_input_binding_sha256 <> p_model_input_binding_sha256 then
      raise exception 'paper correction grade binding changed'
        using errcode = '22023';
    end if;
    if v_job.status = 'completed' then
      return public.matha_paper_correction_grade_job_payload(v_job, 'completed');
    end if;
    if v_job.status = 'dispatched'
        or (v_job.status = 'leased' and v_job.lease_expires_at > now()) then
      return public.matha_paper_correction_grade_job_payload(v_job, 'pending');
    end if;
    if v_job.status <> 'leased' or v_job.dispatched_at is not null then
      raise exception 'paper correction grade job cannot be reclaimed'
        using errcode = '55000';
    end if;
    v_lease_token := 'paper-correction-grade-lease-' || extensions.gen_random_uuid()::text;
    update public.paper_correction_grade_jobs set
      lease_token = v_lease_token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      lease_attempts = lease_attempts + 1
    where job_id = v_job.job_id and status = 'leased'
      and dispatched_at is null and lease_expires_at <= now()
    returning * into v_job;
    if not found then
      raise exception 'paper correction grade lease could not be reclaimed'
        using errcode = '40001';
    end if;
    return public.matha_paper_correction_grade_job_payload(v_job, 'invoke');
  end if;

  v_lease_token := 'paper-correction-grade-lease-' || extensions.gen_random_uuid()::text;
  insert into public.paper_correction_grade_jobs (
    user_id, run_id, source_id, question_no,
    retry_receipt_id, retry_receipt_digest, model_input_binding_sha256,
    status, lease_token, lease_expires_at
  ) values (
    p_user_id, p_run_id, p_source_id, p_question_no,
    p_retry_receipt_id, p_retry_receipt_digest, p_model_input_binding_sha256,
    'leased', v_lease_token, now() + make_interval(secs => p_lease_seconds)
  ) returning * into v_job;
  return public.matha_paper_correction_grade_job_payload(v_job, 'invoke');
end;
$$;

create or replace function public.matha_paper_correction_grade_job_mark_dispatched(
  p_user_id uuid,
  p_run_id text,
  p_source_id text,
  p_question_no integer,
  p_retry_receipt_id text,
  p_retry_receipt_digest text,
  p_model_input_binding_sha256 text,
  p_job_id uuid,
  p_lease_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.paper_correction_grade_jobs%rowtype;
begin
  if p_job_id is null
      or p_lease_token !~ '^paper-correction-grade-lease-[A-Za-z0-9._:-]{16,127}$'
      or p_retry_receipt_digest !~ '^[0-9a-f]{64}$'
      or p_model_input_binding_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid paper correction grade dispatch request'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-correction-grade:' || p_user_id::text || ':' || p_run_id
      || ':' || p_question_no::text || ':' || p_retry_receipt_id,
    0
  ));
  select * into v_job from public.paper_correction_grade_jobs
  where job_id = p_job_id and user_id = p_user_id and run_id = p_run_id
    and source_id = p_source_id and question_no = p_question_no
    and retry_receipt_id = p_retry_receipt_id
    and retry_receipt_digest = p_retry_receipt_digest
    and model_input_binding_sha256 = p_model_input_binding_sha256;
  if not found then
    raise exception 'paper correction grade job identity mismatch'
      using errcode = '22023';
  end if;
  if v_job.status = 'completed' then
    return public.matha_paper_correction_grade_job_payload(v_job, 'completed');
  end if;
  if v_job.status = 'dispatched' then
    if v_job.lease_token <> p_lease_token then
      raise exception 'paper correction grade dispatch lease mismatch'
        using errcode = '55000';
    end if;
    return public.matha_paper_correction_grade_job_payload(v_job, 'pending');
  end if;
  if v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
      or v_job.lease_expires_at <= now() then
    raise exception 'paper correction grade lease lost'
      using errcode = '55000';
  end if;
  update public.paper_correction_grade_jobs set
    status = 'dispatched', lease_expires_at = null, dispatched_at = now()
  where job_id = v_job.job_id and status = 'leased'
    and lease_token = p_lease_token and lease_expires_at > now()
  returning * into v_job;
  if not found then
    raise exception 'paper correction grade dispatch race lost'
      using errcode = '40001';
  end if;
  return public.matha_paper_correction_grade_job_payload(v_job, 'dispatched');
end;
$$;

create or replace function public.matha_paper_correction_grade_job_complete(
  p_user_id uuid,
  p_run_id text,
  p_source_id text,
  p_question_no integer,
  p_retry_receipt_id text,
  p_retry_receipt_digest text,
  p_model_input_binding_sha256 text,
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
  v_job public.paper_correction_grade_jobs%rowtype;
  v_result_sha256 text;
  v_metadata_sha256 text;
  v_completed_at timestamptz;
  v_core jsonb;
  v_receipt jsonb;
  v_receipt_sha256 text;
begin
  if p_job_id is null
      or p_lease_token !~ '^paper-correction-grade-lease-[A-Za-z0-9._:-]{16,127}$'
      or p_normalized_result is null
      or jsonb_typeof(p_normalized_result) <> 'object'
      or pg_column_size(p_normalized_result) > 1000000
      or p_model_metadata is null
      or jsonb_typeof(p_model_metadata) <> 'object'
      or pg_column_size(p_model_metadata) > 100000 then
    raise exception 'invalid paper correction grade completed payload'
      using errcode = '22023';
  end if;
  v_result_sha256 := encode(extensions.digest(convert_to(
    public.matha_canonical_jsonb_text(p_normalized_result), 'UTF8'
  ), 'sha256'), 'hex');
  v_metadata_sha256 := encode(extensions.digest(convert_to(
    public.matha_canonical_jsonb_text(p_model_metadata), 'UTF8'
  ), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-correction-grade:' || p_user_id::text || ':' || p_run_id
      || ':' || p_question_no::text || ':' || p_retry_receipt_id,
    0
  ));
  select * into v_job from public.paper_correction_grade_jobs
  where job_id = p_job_id and user_id = p_user_id and run_id = p_run_id
    and source_id = p_source_id and question_no = p_question_no
    and retry_receipt_id = p_retry_receipt_id
    and retry_receipt_digest = p_retry_receipt_digest
    and model_input_binding_sha256 = p_model_input_binding_sha256;
  if not found then
    raise exception 'paper correction grade job identity mismatch'
      using errcode = '22023';
  end if;
  if v_job.status = 'completed' then
    if v_job.lease_token <> p_lease_token
        or v_job.normalized_result_sha256 <> v_result_sha256
        or v_job.model_metadata_sha256 <> v_metadata_sha256
        or v_job.normalized_result is distinct from p_normalized_result
        or v_job.model_metadata is distinct from p_model_metadata then
      raise exception 'completed paper correction grade payload changed'
        using errcode = '55000';
    end if;
    return public.matha_paper_correction_grade_job_payload(v_job, 'completed');
  end if;
  if v_job.status <> 'dispatched' or v_job.lease_token <> p_lease_token then
    raise exception 'dispatched paper correction grade lease required'
      using errcode = '55000';
  end if;

  v_completed_at := clock_timestamp();
  v_core := jsonb_build_object(
    'authority', 'supabase-immutable-paper-correction-grade-result-v1',
    'jobId', v_job.job_id,
    'runId', v_job.run_id,
    'sourceId', v_job.source_id,
    'questionNo', v_job.question_no,
    'retryReceiptId', v_job.retry_receipt_id,
    'retryReceiptDigest', v_job.retry_receipt_digest,
    'modelInputBindingSha256', v_job.model_input_binding_sha256,
    'normalizedResultSha256', v_result_sha256,
    'modelMetadataSha256', v_metadata_sha256,
    'completedAt', to_char(v_completed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_receipt_sha256 := encode(extensions.digest(convert_to(
    public.matha_canonical_jsonb_text(v_core), 'UTF8'
  ), 'sha256'), 'hex');
  v_receipt := v_core || jsonb_build_object('canonicalDigest', v_receipt_sha256);

  update public.paper_correction_grade_jobs set
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
    raise exception 'paper correction grade completion race lost'
      using errcode = '40001';
  end if;
  return public.matha_paper_correction_grade_job_payload(v_job, 'completed');
end;
$$;

create or replace function public.matha_paper_correction_grade_job_status(
  p_user_id uuid,
  p_run_id text,
  p_source_id text,
  p_question_no integer,
  p_retry_receipt_id text,
  p_retry_receipt_digest text,
  p_model_input_binding_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.paper_correction_grade_jobs%rowtype;
begin
  if p_user_id is null
      or p_run_id !~ '^paper-run-[0-9]{10,20}$'
      or p_source_id is null or length(p_source_id) not between 1 and 160
      or p_question_no not between 1 and 20
      or p_retry_receipt_id !~ '^paper-correction-retry-[A-Za-z0-9._:-]{16,127}$'
      or p_retry_receipt_digest !~ '^[0-9a-f]{64}$'
      or p_model_input_binding_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid paper correction grade status request'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.paper_correction_retry_receipts
    where user_id = p_user_id and receipt_id = p_retry_receipt_id
      and run_id = p_run_id and source_id = p_source_id
      and question_no = p_question_no
      and canonical_digest = p_retry_receipt_digest
  ) then
    raise exception 'exact immutable correction retry receipt required'
      using errcode = '42501';
  end if;
  select * into v_job from public.paper_correction_grade_jobs
  where user_id = p_user_id and run_id = p_run_id
    and source_id = p_source_id and question_no = p_question_no
    and retry_receipt_id = p_retry_receipt_id;
  if not found then
    return jsonb_build_object(
      'authority', 'supabase-paper-correction-grade-job-v1',
      'action', 'missing', 'status', 'missing',
      'run_id', p_run_id, 'source_id', p_source_id,
      'question_no', p_question_no,
      'retry_receipt_id', p_retry_receipt_id,
      'retry_receipt_digest', p_retry_receipt_digest,
      'model_input_binding_sha256', p_model_input_binding_sha256
    );
  end if;
  if v_job.retry_receipt_digest <> p_retry_receipt_digest
      or v_job.model_input_binding_sha256 <> p_model_input_binding_sha256 then
    raise exception 'paper correction grade binding changed'
      using errcode = '22023';
  end if;
  return public.matha_paper_correction_grade_job_payload(
    v_job,
    case when v_job.status = 'completed' then 'completed' else 'pending' end
  );
end;
$$;

revoke all on function public.matha_paper_correction_grade_job_claim(
  uuid, text, text, integer, text, text, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_correction_grade_job_mark_dispatched(
  uuid, text, text, integer, text, text, text, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_correction_grade_job_complete(
  uuid, text, text, integer, text, text, text, uuid, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.matha_paper_correction_grade_job_status(
  uuid, text, text, integer, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.matha_paper_correction_grade_job_claim(
  uuid, text, text, integer, text, text, text, integer
) to service_role;
grant execute on function public.matha_paper_correction_grade_job_mark_dispatched(
  uuid, text, text, integer, text, text, text, uuid, text
) to service_role;
grant execute on function public.matha_paper_correction_grade_job_complete(
  uuid, text, text, integer, text, text, text, uuid, text, jsonb, jsonb
) to service_role;
grant execute on function public.matha_paper_correction_grade_job_status(
  uuid, text, text, integer, text, text, text
) to service_role;
-- END PAPER CORRECTION GRADE JOB PROTOCOL 202608300010
