-- BEGIN PAPER GRADE COMPLETION ARTIFACT RECOVERY 202608300007
-- A whole-paper model response is first written to a deterministic private
-- Storage object and read back byte-for-byte.  Only then may this service-role
-- RPC atomically move the dispatched job to completed.  If the Edge worker
-- dies between those two operations, paper_grade_status can verify the same
-- object and call this RPC without making another paid model request.

alter table public.paper_grade_jobs
  add column if not exists completion_artifact_path text,
  add column if not exists completion_artifact_sha256 text,
  add column if not exists completion_artifact_canonical_digest text,
  add column if not exists completion_artifact_bytes bigint,
  add column if not exists recovered_from_artifact boolean not null default false;

-- Migration 003 briefly exposed a direct completion RPC.  Refuse to install
-- the artifact-only protocol over any row produced through that legacy path:
-- silently grandfathering it would leave an unverified completed result that
-- status/readback routes could never safely return.  Production rollout must
-- first prove this set is empty (the expected state before first deployment).
do $migration$
begin
  if exists (
    select 1 from public.paper_grade_jobs
    where status = 'completed'
      and (
        completion_artifact_path is null
        or completion_artifact_sha256 is null
        or completion_artifact_canonical_digest is null
        or completion_artifact_bytes is null
        or recovered_from_artifact is distinct from true
      )
  ) then
    raise exception 'legacy paper grade completion requires verified artifact backfill'
      using errcode = '55000';
  end if;
end
$migration$;

alter table public.paper_grade_jobs
  drop constraint if exists paper_grade_jobs_completion_artifact_shape_valid;
alter table public.paper_grade_jobs
  add constraint paper_grade_jobs_completion_artifact_shape_valid check (
    (
      status <> 'completed'
      and completion_artifact_path is null
      and completion_artifact_sha256 is null
      and completion_artifact_canonical_digest is null
      and completion_artifact_bytes is null
      and recovered_from_artifact = false
    )
    or
    (
      status = 'completed'
      and completion_artifact_path ~ '^grade-completions/matha_[0-9a-f]{32}/paper-run-[0-9]{10,20}/paper-submit-[A-Za-z0-9._:-]{16,127}/generation-[0-9]{1,10}/input-[0-9a-f]{64}\.json$'
      and completion_artifact_sha256 ~ '^[0-9a-f]{64}$'
      and completion_artifact_canonical_digest ~ '^[0-9a-f]{64}$'
      and completion_artifact_bytes between 1 and 2000000
      and recovered_from_artifact = true
    )
  );

-- There is exactly one way to enter completed after migration 007: the
-- service-role artifact recovery RPC below.  DROP (rather than only revoking
-- client roles) also prevents Edge/service_role from bypassing Storage
-- readback with the migration-003 JSON-only completion signature.
drop function if exists public.matha_paper_grade_job_complete(
  uuid, text, text, text, bigint, text, jsonb, jsonb, jsonb
);

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
    'terminal', p_action = 'lost',
    'requires_explicit_generation', p_action = 'lost',
    'run_id', (p_job).run_id,
    'accepted_attempt_id', (p_job).accepted_attempt_id,
    'model_input_binding_sha256', (p_job).model_input_binding_sha256,
    'generation', (p_job).generation,
    'issuance_request_id', (p_job).issuance_request_id,
    'lease_expires_at', (p_job).lease_expires_at,
    'dispatched_at', (p_job).dispatched_at,
    'completed_at', (p_job).completed_at,
    'completion_artifact', case
      when (p_job).completion_artifact_path is not null then jsonb_build_object(
        'authority', 'supabase-service-role-storage-readback',
        'verified', (p_job).recovered_from_artifact,
        'bucket', 'matha-audit-private',
        'path', (p_job).completion_artifact_path,
        'sha256', (p_job).completion_artifact_sha256,
        'canonical_digest', (p_job).completion_artifact_canonical_digest,
        'bytes', (p_job).completion_artifact_bytes
      ) else null end,
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

-- Read-only status becomes explicitly terminal after 15 minutes in the
-- dispatched state.  The row remains dispatched (and therefore can never be
-- leased or auto-resent); an explicit generation N+1 is the only retry path.
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
      or coalesce(p_run_id, '') !~ '^paper-run-[0-9]{10,20}$'
      or coalesce(p_accepted_attempt_id, '') !~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$'
      or p_generation is null or p_generation not between 0 and 2147483647 then
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
  if v_job.status = 'completed' then
    return public.matha_paper_grade_job_receipt(v_job, 'completed');
  end if;
  if v_job.status = 'dispatched'
      and v_job.dispatched_at <= now() - interval '15 minutes' then
    return public.matha_paper_grade_job_receipt(v_job, 'lost');
  end if;
  return public.matha_paper_grade_job_receipt(v_job, 'pending');
end;
$$;

create or replace function public.matha_paper_grade_job_recover_from_artifact(
  p_user_id uuid,
  p_run_id text,
  p_accepted_attempt_id text,
  p_model_input_binding_sha256 text,
  p_generation bigint,
  p_completion_artifact jsonb,
  p_completion_artifact_path text,
  p_completion_artifact_sha256 text,
  p_completion_artifact_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.paper_grade_jobs%rowtype;
  v_expected_user_binding text;
  v_expected_path text;
  v_identity jsonb;
  v_storage jsonb;
  v_payload jsonb;
  v_digests jsonb;
  v_normalized_model_json jsonb;
  v_model_metadata jsonb;
  v_receipt_envelope jsonb;
  v_artifact_canonical_digest text;
begin
  if p_user_id is null
      or coalesce(p_run_id, '') !~ '^paper-run-[0-9]{10,20}$'
      or coalesce(p_accepted_attempt_id, '') !~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$'
      or coalesce(p_model_input_binding_sha256, '') !~ '^[0-9a-f]{64}$'
      or p_generation is null or p_generation not between 0 and 2147483647
      or p_completion_artifact is null
      or jsonb_typeof(p_completion_artifact) <> 'object'
      or octet_length(p_completion_artifact::text) > 2000000
      or coalesce(p_completion_artifact_sha256, '') !~ '^[0-9a-f]{64}$'
      or p_completion_artifact_bytes is null
      or p_completion_artifact_bytes not between 1 and 2000000 then
    raise exception 'invalid paper grade completion artifact' using errcode = '22023';
  end if;

  v_expected_user_binding := 'matha_' || substr(encode(digest(
    convert_to(p_user_id::text, 'UTF8'), 'sha256'
  ), 'hex'), 1, 32);
  v_expected_path := 'grade-completions/' || v_expected_user_binding || '/' ||
    p_run_id || '/' || p_accepted_attempt_id || '/generation-' ||
    p_generation::text || '/input-' || p_model_input_binding_sha256 || '.json';
  if p_completion_artifact_path is distinct from v_expected_path then
    raise exception 'paper grade completion artifact path mismatch' using errcode = '55000';
  end if;

  v_identity := p_completion_artifact -> 'identity';
  v_storage := p_completion_artifact -> 'storage';
  v_payload := p_completion_artifact -> 'payload';
  v_digests := p_completion_artifact -> 'contentDigests';
  v_artifact_canonical_digest := lower(p_completion_artifact ->> 'canonicalDigest');
  if coalesce(p_completion_artifact ->> 'kind', '') <>
        'matha-paper-grade-completion-artifact-v1'
      or coalesce(p_completion_artifact ->> 'schemaVersion', '') <> '1'
      or coalesce(jsonb_typeof(v_identity), '') <> 'object'
      or coalesce(jsonb_typeof(v_storage), '') <> 'object'
      or coalesce(jsonb_typeof(v_payload), '') <> 'object'
      or coalesce(jsonb_typeof(v_digests), '') <> 'object'
      or coalesce(v_identity ->> 'userBinding', '') <> v_expected_user_binding
      or coalesce(v_identity ->> 'runId', '') <> p_run_id
      or coalesce(v_identity ->> 'acceptedAttemptId', '') <> p_accepted_attempt_id
      or coalesce(v_identity ->> 'generation', '') <> p_generation::text
      or lower(coalesce(v_identity ->> 'modelInputBindingSha256', '')) <>
        p_model_input_binding_sha256
      or coalesce(v_storage ->> 'bucket', '') <> 'matha-audit-private'
      or coalesce(v_storage ->> 'path', '') <> v_expected_path
      or coalesce(v_artifact_canonical_digest, '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_digests ->> 'normalizedModelJsonSha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_digests ->> 'modelMetadataSha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_digests ->> 'receiptEnvelopeSha256', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'paper grade completion artifact binding mismatch' using errcode = '55000';
  end if;

  v_normalized_model_json := v_payload -> 'normalizedModelJson';
  v_model_metadata := v_payload -> 'modelMetadata';
  v_receipt_envelope := v_payload -> 'receiptEnvelope';
  if coalesce(jsonb_typeof(v_normalized_model_json), '') <> 'object'
      or octet_length(v_normalized_model_json::text) > 1000000
      or coalesce(jsonb_typeof(v_model_metadata), '') <> 'object'
      or octet_length(v_model_metadata::text) > 100000
      or coalesce(jsonb_typeof(v_receipt_envelope), '') <> 'object'
      or octet_length(v_receipt_envelope::text) > 1000000
      or coalesce(v_receipt_envelope #>> '{privateReadback,submitAttemptId}', '') <>
        p_accepted_attempt_id
      or coalesce(v_receipt_envelope #>> '{privateReadback,gradeGeneration}', '') <>
        p_generation::text
      or lower(coalesce(
        v_receipt_envelope #>> '{privateReadback,modelInputBindingSha256}', ''
      )) <>
        p_model_input_binding_sha256
      or coalesce(v_receipt_envelope #>> '{receipt,submitAttempt,attemptId}', '') <>
        p_accepted_attempt_id
      or coalesce(v_receipt_envelope #>> '{receipt,gradeGeneration}', '') <>
        p_generation::text
      or lower(coalesce(
        v_receipt_envelope #>> '{receipt,modelInputBinding,canonicalDigest}', ''
      )) <>
        p_model_input_binding_sha256
      or coalesce(v_receipt_envelope #>> '{privateReadback,authority}', '') <>
        'supabase-service-role-storage-readback'
      or coalesce(v_receipt_envelope #>> '{privateReadback,bucket}', '') <>
        'matha-audit-private'
      or coalesce(v_receipt_envelope #>> '{privateReadback,canonicalDigest}', '') !~
        '^[0-9a-f]{64}$'
      or coalesce(v_receipt_envelope #>> '{privateReadback,canonicalDigest}', '') <>
        coalesce(v_receipt_envelope #>> '{receipt,canonicalDigest}', '')
      or coalesce(v_receipt_envelope #>> '{privateReadback,path}', '') <>
        'grade-receipts/' || v_expected_user_binding || '/' || p_run_id ||
        '/grade-' || coalesce(v_receipt_envelope #>> '{receipt,canonicalDigest}', '') ||
        '.json'
      or coalesce(v_receipt_envelope #>> '{privateReadback,sha256}', '') !~
        '^[0-9a-f]{64}$'
      or coalesce(v_model_metadata ->> 'requestId', '') <>
        coalesce(v_receipt_envelope #>> '{receipt,requestId}', '')
      or coalesce(v_model_metadata ->> 'requestId', '') <>
        coalesce(v_receipt_envelope #>> '{privateReadback,requestId}', '')
      or coalesce(v_model_metadata ->> 'model', '') <>
        coalesce(v_receipt_envelope #>> '{receipt,model}', '')
      or coalesce(v_model_metadata ->> 'model', '') <>
        coalesce(v_receipt_envelope #>> '{privateReadback,model}', '') then
    raise exception 'paper grade completion payload binding mismatch' using errcode = '55000';
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
    if v_job.recovered_from_artifact is distinct from true
        or v_job.normalized_model_json is distinct from v_normalized_model_json
        or v_job.model_metadata is distinct from v_model_metadata
        or v_job.receipt_envelope is distinct from v_receipt_envelope
        or v_job.completion_artifact_path is distinct from p_completion_artifact_path
        or v_job.completion_artifact_sha256 is distinct from p_completion_artifact_sha256
        or v_job.completion_artifact_canonical_digest is distinct from v_artifact_canonical_digest
        or v_job.completion_artifact_bytes is distinct from p_completion_artifact_bytes then
      raise exception 'completed paper grade artifact changed' using errcode = '55000';
    end if;
    return public.matha_paper_grade_job_receipt(v_job, 'completed');
  end if;
  if v_job.status <> 'dispatched' then
    raise exception 'paper grade dispatched job required for artifact recovery' using errcode = '55000';
  end if;

  update public.paper_grade_jobs set
    status = 'completed', completed_at = now(),
    normalized_model_json = v_normalized_model_json,
    normalized_model_json_sha256 = encode(digest(
      convert_to(v_normalized_model_json::text, 'UTF8'), 'sha256'
    ), 'hex'),
    model_metadata = v_model_metadata,
    model_metadata_sha256 = encode(digest(
      convert_to(v_model_metadata::text, 'UTF8'), 'sha256'
    ), 'hex'),
    receipt_envelope = v_receipt_envelope,
    receipt_envelope_sha256 = encode(digest(
      convert_to(v_receipt_envelope::text, 'UTF8'), 'sha256'
    ), 'hex'),
    completion_artifact_path = p_completion_artifact_path,
    completion_artifact_sha256 = p_completion_artifact_sha256,
    completion_artifact_canonical_digest = v_artifact_canonical_digest,
    completion_artifact_bytes = p_completion_artifact_bytes,
    recovered_from_artifact = true
  where user_id = v_job.user_id and run_id = v_job.run_id
    and accepted_attempt_id = v_job.accepted_attempt_id
    and model_input_binding_sha256 = v_job.model_input_binding_sha256
    and generation = v_job.generation
  returning * into v_job;
  return public.matha_paper_grade_job_receipt(v_job, 'completed');
end;
$$;

revoke all on function public.matha_paper_grade_job_recover_from_artifact(
  uuid, text, text, text, bigint, jsonb, text, text, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.matha_paper_grade_job_recover_from_artifact(
  uuid, text, text, text, bigint, jsonb, text, text, bigint
) to service_role;

-- Keep the status function callable only by Edge's service role after replace.
revoke all on function public.matha_paper_grade_job_status(uuid, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.matha_paper_grade_job_status(uuid, text, text, bigint)
  to service_role;
-- END PAPER GRADE COMPLETION ARTIFACT RECOVERY 202608300007
