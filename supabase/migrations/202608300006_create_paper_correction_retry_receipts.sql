-- BEGIN PAPER CORRECTION RETRY RECEIPT 202608300006
-- Server-controlled proof that, on a later Asia/Taipei date, the learner
-- persisted real correction ink for one question.  Owner-writable app_state
-- retry counters/logs are never an unlock authority.

-- `updated_at` is part of the sync protocol and is supplied by the client.
-- Keep a second timestamp that the database always owns; next-day receipts
-- must never trust a future/forged client clock.
alter table public.ink_sessions
  add column if not exists server_updated_at timestamptz;

create or replace function public.matha_ink_session_server_timestamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.matha_ink_session_server_timestamp()
  from public, anon, authenticated, service_role;
drop trigger if exists ink_sessions_server_timestamp on public.ink_sessions;
create trigger ink_sessions_server_timestamp
before insert or update on public.ink_sessions
for each row execute function public.matha_ink_session_server_timestamp();

create table if not exists public.paper_correction_retry_receipts (
  user_id                         uuid not null references auth.users (id) on delete cascade,
  receipt_id                     text not null,
  run_id                         text not null,
  source_id                      text not null,
  question_no                    integer not null,
  accepted_attempt_id            text not null,
  accepted_page_manifest_sha256  text not null,
  correction_page                integer not null,
  correction_qid                 text not null,
  correction_client_id           text not null,
  correction_revision            integer not null,
  correction_updated_at          timestamptz not null,
  correction_server_updated_at   timestamptz not null,
  correction_cloud_sha256        text not null,
  correction_page_manifest       jsonb not null,
  correction_live_stroke_ids     jsonb not null,
  correction_new_stroke_ids      jsonb not null,
  correction_live_stroke_digests jsonb not null,
  correction_new_stroke_digests  jsonb not null,
  correction_live_strokes        jsonb not null,
  correction_new_strokes         jsonb not null,
  receipt                        jsonb not null,
  canonical_digest               text not null,
  issued_at                      timestamptz not null,
  created_at                     timestamptz not null default now(),
  primary key (user_id, receipt_id),
  foreign key (user_id, accepted_attempt_id)
    references public.paper_submit_attempts (user_id, attempt_id) on delete cascade,
  constraint paper_correction_retry_receipt_id_valid
    check (receipt_id ~ '^paper-correction-retry-[A-Za-z0-9._:-]{16,127}$'),
  constraint paper_correction_retry_identity_valid
    check (
      run_id ~ '^paper-run-[0-9]{10,20}$'
      and length(source_id) between 1 and 160
      and question_no between 1 and 20
      and correction_page between 0 and 19
      and correction_qid ~ '^paper:paper-run-[0-9]{10,20}-correction:v[0-9]+:[0-9]+$'
      and length(correction_client_id) between 1 and 300
      and correction_revision >= 0
      and accepted_page_manifest_sha256 ~ '^[0-9a-f]{64}$'
      and correction_cloud_sha256 ~ '^[0-9a-f]{64}$'
      and canonical_digest ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(correction_page_manifest) = 'array'
      and jsonb_array_length(correction_page_manifest) = 1
      and jsonb_typeof(correction_live_stroke_ids) = 'array'
      and jsonb_array_length(correction_live_stroke_ids) > 0
      and jsonb_typeof(correction_new_stroke_ids) = 'array'
      and jsonb_array_length(correction_new_stroke_ids) > 0
      and jsonb_typeof(correction_live_stroke_digests) = 'array'
      and jsonb_array_length(correction_live_stroke_digests) > 0
      and jsonb_typeof(correction_new_stroke_digests) = 'array'
      and jsonb_array_length(correction_new_stroke_digests) > 0
      and jsonb_typeof(correction_live_strokes) = 'array'
      and jsonb_array_length(correction_live_strokes) > 0
      and jsonb_array_length(correction_live_strokes) <= 1000
      and pg_column_size(correction_live_strokes) <= 1000000
      and jsonb_typeof(correction_new_strokes) = 'array'
      and jsonb_array_length(correction_new_strokes) > 0
      and jsonb_array_length(correction_new_strokes) <= 1000
      and pg_column_size(correction_new_strokes) <= 1000000
      and jsonb_typeof(receipt) = 'object'
    )
);

create unique index if not exists paper_correction_retry_checkpoint_once
  on public.paper_correction_retry_receipts (
    user_id, run_id, correction_client_id,
    correction_revision, correction_cloud_sha256
  );
create index if not exists paper_correction_retry_user_run
  on public.paper_correction_retry_receipts (user_id, run_id, question_no, issued_at desc);

alter table public.paper_correction_retry_receipts enable row level security;
alter table public.paper_correction_retry_receipts force row level security;
revoke all on table public.paper_correction_retry_receipts
  from public, anon, authenticated, service_role;
grant select on table public.paper_correction_retry_receipts to authenticated, service_role;

drop policy if exists "own paper correction retry receipts read"
  on public.paper_correction_retry_receipts;
create policy "own paper correction retry receipts read"
  on public.paper_correction_retry_receipts
  for select to authenticated
  using (auth.uid() = user_id and public.is_matha_user(auth.uid()));

create or replace function public.matha_paper_correction_retry_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'paper correction retry receipts are immutable'
    using errcode = '55000';
end;
$$;
revoke all on function public.matha_paper_correction_retry_immutable()
  from public, anon, authenticated, service_role;
drop trigger if exists paper_correction_retry_receipts_immutable
  on public.paper_correction_retry_receipts;
create trigger paper_correction_retry_receipts_immutable
before update on public.paper_correction_retry_receipts
for each row execute function public.matha_paper_correction_retry_immutable();

create or replace function public.matha_paper_correction_retry_accept(
  p_receipt_id text,
  p_run_id text,
  p_source_id text,
  p_question_no integer,
  p_accepted_attempt_id text,
  p_page_manifest jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_attempt public.paper_submit_attempts%rowtype;
  v_existing public.paper_correction_retry_receipts%rowtype;
  v_ink public.ink_sessions%rowtype;
  v_item jsonb;
  v_manifest jsonb;
  v_core jsonb;
  v_receipt jsonb;
  v_page integer;
  v_expected_page integer;
  v_question_pages integer[];
  v_revision integer;
  v_qid text;
  v_client_id text;
  v_cloud_sha256 text;
  v_updated_at timestamptz;
  v_server_updated_at timestamptz;
  v_server_sha256 text;
  v_live_stroke_ids jsonb;
  v_new_stroke_ids jsonb;
  v_live_stroke_digests jsonb;
  v_new_stroke_digests jsonb;
  v_live_strokes jsonb;
  v_new_strokes jsonb;
  v_total_points bigint;
  v_accepted_manifest_sha256 text;
  v_digest text;
  v_issued_at timestamptz;
begin
  if v_user is null or not public.is_matha_user(v_user) then
    raise exception 'authenticated MathA user required' using errcode = '42501';
  end if;
  if p_receipt_id is null
      or p_receipt_id !~ '^paper-correction-retry-[A-Za-z0-9._:-]{16,127}$'
      or p_run_id is null or p_run_id !~ '^paper-run-[0-9]{10,20}$'
      or p_source_id is null or length(p_source_id) not between 1 and 160
      or p_question_no not between 1 and 20
      or p_accepted_attempt_id is null
      or p_accepted_attempt_id !~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$'
      or p_page_manifest is null
      or jsonb_typeof(p_page_manifest) <> 'array'
      or jsonb_array_length(p_page_manifest) <> 1 then
    raise exception 'invalid paper correction retry request' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'matha-paper-correction:' || v_user::text || ':' || p_run_id,
    0
  ));

  select * into v_attempt from public.paper_submit_attempts
  where user_id = v_user and attempt_id = p_accepted_attempt_id
    and run_id = p_run_id and source_id = p_source_id
    and status = 'accepted' and decision_reason = 'accepted-first-for-run';
  if not found or v_attempt.page_manifest is null then
    raise exception 'immutable accepted paper attempt required' using errcode = '42501';
  end if;
  if ((v_attempt.accepted_at at time zone 'Asia/Taipei')::date + 1) >
      (clock_timestamp() at time zone 'Asia/Taipei')::date then
    raise exception 'paper correction retry is not next-day eligible'
      using errcode = '42501';
  end if;

  v_question_pages := case p_source_id
    when 'paper-mock-1' then array[0,0,0,0,0,1,1,1,2,2,2,3,3,3,4,4,4,5,5,5]
    when 'paper-mock-3' then array[0,0,0,0,0,1,1,1,2,2,2,2,2,3,3,3,3,3,3,3]
    when 'paper-official-110-trial' then array[1,1,1,1,2,2,2,3,3,3,4,4,4,5,5,5,5,6,6,6]
    when 'paper-official-111' then array[1,1,1,1,2,2,2,2,3,3,3,4,4,4,5,5,5,6,6,6]
    when 'paper-official-112' then array[1,1,1,1,2,2,2,3,3,3,4,4,4,5,5,5,5,6,6,6]
    when 'paper-official-113' then array[1,1,1,2,2,2,2,3,3,3,4,4,4,5,5,5,5,6,6,6]
    when 'paper-official-114' then array[1,1,1,2,2,2,3,3,3,4,4,4,5,5,5,6,6,6,6,6]
    when 'paper-official-115' then array[1,1,1,1,2,2,2,2,3,3,4,4,5,5,5,5,6,6,6,6]
    when 'paper-regional-ra4109' then array[0,0,0,0,0,0,1,1,1,1,1,2,2,2,2,2,2,3,3,3]
    when 'paper-regional-ra4110' then array[0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,2,2,2,2,2]
    when 'paper-regional-ra3101' then array[0,0,0,0,0,0,0,1,1,1,1,1,1,1,2,2,2,2,2,2]
    when 'paper-regional-ra3102' then array[0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,2,2,2]
    when 'paper-regional-ra1104' then array[0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,2,2,2]
    when 'paper-regional-ra2100' then array[0,0,0,0,0,0,0,0,0,1,1,1,1,1,2,2,2,2,2,2]
    when 'paper-regional-ra2101' then array[0,0,0,0,0,0,0,0,1,1,1,2,2,2,2,2,2,2,2,2]
    when 'paper-regional-ra1103' then array[0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,2,2,2]
    else null
  end;
  if v_question_pages is null or array_length(v_question_pages, 1) <> 20 then
    raise exception 'paper correction source is not supported'
      using errcode = '42501';
  end if;
  v_expected_page := v_question_pages[p_question_no];

  v_item := p_page_manifest->0;
  if jsonb_typeof(v_item) <> 'object'
      or coalesce(v_item->>'page', '') !~ '^(0|[1-9][0-9]?)$'
      or coalesce(v_item->>'revision', '') !~ '^(0|[1-9][0-9]{0,8})$'
      or coalesce(v_item->>'cloudSha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_item->>'updatedAt', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or coalesce(v_item->>'serverUpdatedAt', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3,6}Z$' then
    raise exception 'invalid paper correction page manifest' using errcode = '22023';
  end if;
  v_page := (v_item->>'page')::integer;
  v_revision := (v_item->>'revision')::integer;
  v_qid := v_item->>'qid';
  v_client_id := v_item->>'clientId';
  v_cloud_sha256 := v_item->>'cloudSha256';
  v_updated_at := (v_item->>'updatedAt')::timestamptz;
  v_server_updated_at := (v_item->>'serverUpdatedAt')::timestamptz;
  if v_page is distinct from v_expected_page
      or v_qid !~ ('^paper:' || p_run_id || '-correction:v[0-9]+:' || v_page::text || '$')
      or v_client_id is null or length(v_client_id) not between 1 and 300 then
    raise exception 'invalid paper correction page identity' using errcode = '22023';
  end if;

  -- Idempotent timeout recovery compares the immutable checkpoint identity.
  -- The browser's cross-language JSON digest is deliberately not an
  -- authority: PostgreSQL jsonb and JavaScript stringify exponent numbers
  -- differently, so the stored row is hashed only by the database below.
  select * into v_existing from public.paper_correction_retry_receipts
  where user_id = v_user and receipt_id = p_receipt_id;
  if found then
    if v_existing.run_id <> p_run_id
        or v_existing.source_id <> p_source_id
        or v_existing.question_no <> p_question_no
        or v_existing.accepted_attempt_id <> p_accepted_attempt_id
        or v_existing.correction_page <> v_page
        or v_existing.correction_qid <> v_qid
        or v_existing.correction_client_id <> v_client_id
        or v_existing.correction_revision <> v_revision
        or v_existing.correction_updated_at <> v_updated_at
        or v_existing.correction_server_updated_at <> v_server_updated_at then
      raise exception 'paper correction retry receipt payload changed'
        using errcode = '22023';
    end if;
    return v_existing.receipt;
  end if;

  select * into v_ink from public.ink_sessions
  where user_id = v_user and client_id = v_client_id and qid = v_qid;
  if not found
      or coalesce((v_ink.proc->>'overlay')::boolean, false) is distinct from true
      or v_ink.proc->>'mode' <> 'paper-correction'
      or v_ink.proc->'event' is not null
      or (v_ink.proc->>'page')::integer is distinct from v_page
      or (v_ink.proc->>'revision')::integer is distinct from v_revision
      or coalesce((v_ink.strokes->>'paper')::boolean, false) is distinct from true
      or (v_ink.strokes->>'revision')::integer is distinct from v_revision
      or coalesce(v_ink.strokes->>'questionTagSchema', '') <> '1'
      or jsonb_typeof(v_ink.strokes) is distinct from 'object'
      or pg_column_size(v_ink.strokes) > 2000000
      or jsonb_typeof(v_ink.strokes->'s') is distinct from 'array'
      or jsonb_array_length(v_ink.strokes->'s') > 1000
      or jsonb_typeof(v_ink.strokes->'deleted') is distinct from 'array'
      or jsonb_array_length(v_ink.strokes->'deleted') > 2000
      or v_ink.updated_at is distinct from v_updated_at
      or v_ink.server_updated_at is null
      or v_server_updated_at is null
      or v_ink.server_updated_at is distinct from v_server_updated_at
      or v_ink.server_updated_at <= v_attempt.accepted_at
      or ((v_ink.server_updated_at at time zone 'Asia/Taipei')::date <
        ((v_attempt.accepted_at at time zone 'Asia/Taipei')::date + 1))
      or v_ink.server_updated_at > clock_timestamp() then
    raise exception 'paper correction checkpoint changed before receipt'
      using errcode = '40001';
  end if;
  -- Correction pages can contain several questions.  Only strokes tagged by
  -- the current review UI with this exact integer question number are proof
  -- for this receipt.  Legacy/no-qno strokes and same-page work for another
  -- question remain visible in the checkpoint but are not unlock candidates.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', live.id,
      'qno', p_question_no,
      'pts', live.pts,
      'c', live.color,
      'w', live.width,
      't0', live.t0,
      't1', live.t1,
      'geometryDigest', live.digest
    ) order by live.id, live.digest), '[]'::jsonb)
    into v_live_strokes
  from (
    select distinct stroke->>'id' as id,
      stroke->'pts' as pts,
      stroke->'c' as color,
      stroke->'w' as width,
      (stroke->>'t0')::bigint as t0,
      (stroke->>'t1')::bigint as t1,
      encode(extensions.digest(convert_to(
        public.matha_canonical_jsonb_text(jsonb_build_object(
          'pts', stroke->'pts',
          'c', stroke->'c',
          'w', stroke->'w'
        )), 'UTF8'
      ), 'sha256'), 'hex') as digest
    from jsonb_array_elements(coalesce(v_ink.strokes->'s', '[]'::jsonb)) stroke
    where jsonb_typeof(stroke) = 'object'
      and length(coalesce(stroke->>'id', '')) between 1 and 300
      and coalesce(stroke->>'id', '') ~ '^[A-Za-z0-9._:-]+$'
      and jsonb_typeof(stroke->'pts') = 'array'
      and jsonb_array_length(stroke->'pts') > 1
      and jsonb_array_length(stroke->'pts') <= 10000
      and not exists (
        select 1
        from jsonb_array_elements(stroke->'pts') point
        where jsonb_typeof(point) is distinct from 'array'
          or jsonb_array_length(point) <> 3
          or case
            when jsonb_typeof(point->0) = 'number'
              and jsonb_typeof(point->1) = 'number'
              and jsonb_typeof(point->2) = 'number'
            then not (
              (point->>0)::numeric between 0 and 1
              and (point->>1)::numeric between 0 and 1
              and (point->>2)::numeric between 0 and 1
            )
            else true
          end
      )
      and jsonb_typeof(stroke->'c') = 'string'
      and stroke->>'c' in ('black', 'blue', 'green')
      and jsonb_typeof(stroke->'w') = 'number'
      and case when jsonb_typeof(stroke->'w') = 'number'
        then (stroke->>'w')::numeric between 0.35 and 2
        else false end
      and jsonb_typeof(stroke->'t0') = 'number'
      and jsonb_typeof(stroke->'t1') = 'number'
      and coalesce(stroke->>'t0', '') ~ '^(0|[1-9][0-9]{0,15})$'
      and coalesce(stroke->>'t1', '') ~ '^(0|[1-9][0-9]{0,15})$'
      and (stroke->>'t0')::numeric <= 9007199254740991
      and (stroke->>'t1')::numeric <= 9007199254740991
      and (stroke->>'t1')::numeric >= (stroke->>'t0')::numeric
      and jsonb_typeof(stroke->'qno') = 'number'
      and case
        when coalesce(stroke->>'qno', '') ~ '^([1-9]|1[0-9]|20)$'
          then (stroke->>'qno')::integer = p_question_no
        else false
      end
      and coalesce(stroke->>'dead', 'false') = 'false'
      and not exists (
        select 1 from jsonb_array_elements_text(
          coalesce(v_ink.strokes->'deleted', '[]'::jsonb)
        ) deleted(id)
        where deleted.id = stroke->>'id'
      )
  ) live;
  if jsonb_array_length(v_live_strokes) < 1 then
    raise exception 'paper correction requires a question-tagged live handwritten stroke'
      using errcode = '42501';
  end if;
  select coalesce(sum(jsonb_array_length(tagged.stroke->'pts')), 0)
    into v_total_points
  from jsonb_array_elements(v_live_strokes) tagged(stroke);
  if v_total_points > 50000 then
    raise exception 'paper correction receipt exceeds total point bound'
      using errcode = '22023';
  end if;
  if pg_column_size(v_live_strokes) > 1000000 then
    raise exception 'paper correction live geometry exceeds byte bound'
      using errcode = '22023';
  end if;
  -- Correction proof is append-only within a question.  A later checkpoint
  -- may add strokes, but it cannot edit or delete any exact geometry that an
  -- earlier immutable receipt already proved.
  if exists (
    select 1
    from public.paper_correction_retry_receipts prior,
      jsonb_array_elements(prior.correction_live_strokes) historical(stroke)
    where prior.user_id = v_user and prior.run_id = p_run_id
      and prior.question_no = p_question_no
      and not exists (
        select 1
        from jsonb_array_elements(v_live_strokes) current(stroke)
        where current.stroke = historical.stroke
      )
  ) then
    raise exception 'paper correction historical geometry changed or was deleted'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_live_strokes) tagged(stroke)
    group by tagged.stroke->>'id' having count(*) > 1
  ) then
    raise exception 'paper correction stroke id has conflicting geometry'
      using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(distinct tagged.stroke->>'id'
      order by tagged.stroke->>'id'), '[]'::jsonb)
    into v_live_stroke_ids
  from jsonb_array_elements(v_live_strokes) tagged(stroke);
  select coalesce(jsonb_agg(distinct tagged.stroke->>'geometryDigest'
      order by tagged.stroke->>'geometryDigest'), '[]'::jsonb)
    into v_live_stroke_digests
  from jsonb_array_elements(v_live_strokes) tagged(stroke);

  v_server_sha256 := encode(extensions.digest(convert_to(
    public.matha_canonical_jsonb_text(v_ink.strokes), 'UTF8'
  ), 'sha256'), 'hex');
  v_manifest := jsonb_build_array(jsonb_build_object(
    'page', v_page,
    'qid', v_qid,
    'clientId', v_client_id,
    'revision', v_revision,
    'cloudSha256', v_server_sha256,
    'updatedAt', to_char(v_ink.updated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'serverUpdatedAt', to_char(v_ink.server_updated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ));

  select * into v_existing from public.paper_correction_retry_receipts
  where user_id = v_user and run_id = p_run_id
    and correction_client_id = v_client_id
    and correction_revision = v_revision
    and correction_cloud_sha256 = v_server_sha256;
  if found then
    if v_existing.question_no <> p_question_no
        or v_existing.source_id <> p_source_id
        or v_existing.accepted_attempt_id <> p_accepted_attempt_id then
      raise exception 'paper correction checkpoint already proves another question'
        using errcode = '42501';
    end if;
    return v_existing.receipt;
  end if;

  -- ID and geometry novelty are evaluated on the same server-read pair.  The
  -- paired object is stored in the immutable receipt so independent ID and
  -- digest arrays can never be spliced to claim a different stroke.
  select coalesce(jsonb_agg(candidate.stroke order by candidate.stroke->>'id'), '[]'::jsonb)
    into v_new_strokes
  from jsonb_array_elements(v_live_strokes) candidate(stroke)
  where not exists (
    select 1
    from public.paper_correction_retry_receipts prior,
      jsonb_array_elements_text(prior.correction_live_stroke_ids) used(id)
    where prior.user_id = v_user and prior.run_id = p_run_id
      and used.id = candidate.stroke->>'id'
  ) and not exists (
    select 1
    from public.paper_correction_retry_receipts prior,
      jsonb_array_elements_text(prior.correction_live_stroke_digests) used(digest)
    where prior.user_id = v_user and prior.run_id = p_run_id
      and used.digest = candidate.stroke->>'geometryDigest'
  );
  if jsonb_array_length(v_new_strokes) < 1 then
    raise exception 'paper correction retry requires a new question-tagged stroke geometry'
      using errcode = '42501';
  end if;
  if pg_column_size(v_new_strokes) > 1000000 then
    raise exception 'paper correction receipt geometry exceeds byte bound'
      using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(tagged.stroke->>'id' order by tagged.stroke->>'id'), '[]'::jsonb)
    into v_new_stroke_ids
  from jsonb_array_elements(v_new_strokes) tagged(stroke);
  select coalesce(jsonb_agg(distinct tagged.stroke->>'geometryDigest'
      order by tagged.stroke->>'geometryDigest'), '[]'::jsonb)
    into v_new_stroke_digests
  from jsonb_array_elements(v_new_strokes) tagged(stroke);

  v_accepted_manifest_sha256 := encode(extensions.digest(convert_to(
    public.matha_canonical_jsonb_text(v_attempt.page_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_issued_at := clock_timestamp();
  v_core := jsonb_build_object(
    'authority', 'supabase-immutable-paper-correction-retry-v1',
    'receiptId', p_receipt_id,
    'runId', p_run_id,
    'sourceId', p_source_id,
    'questionNo', p_question_no,
    'acceptedAttemptId', p_accepted_attempt_id,
    'acceptedInkSnapshotSha256', v_attempt.ink_snapshot_sha256,
    'acceptedPageManifestSha256', v_accepted_manifest_sha256,
    'correctionPageManifest', v_manifest,
    'correctionLiveStrokeIds', v_live_stroke_ids,
    'correctionNewStrokeIds', v_new_stroke_ids,
    'correctionLiveStrokeDigests', v_live_stroke_digests,
    'correctionNewStrokeDigests', v_new_stroke_digests,
    'correctionLiveStrokes', v_live_strokes,
    'correctionNewStrokes', v_new_strokes,
    'issuedAt', to_char(v_issued_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_digest := encode(extensions.digest(convert_to(
    public.matha_canonical_jsonb_text(v_core), 'UTF8'
  ), 'sha256'), 'hex');
  v_receipt := v_core || jsonb_build_object('canonicalDigest', v_digest);

  insert into public.paper_correction_retry_receipts (
    user_id, receipt_id, run_id, source_id, question_no,
    accepted_attempt_id, accepted_page_manifest_sha256,
    correction_page, correction_qid, correction_client_id,
    correction_revision, correction_updated_at, correction_server_updated_at,
    correction_cloud_sha256,
    correction_page_manifest, correction_live_stroke_ids,
    correction_new_stroke_ids, correction_live_stroke_digests,
    correction_new_stroke_digests, correction_live_strokes,
    correction_new_strokes,
    receipt, canonical_digest, issued_at
  ) values (
    v_user, p_receipt_id, p_run_id, p_source_id, p_question_no,
    p_accepted_attempt_id, v_accepted_manifest_sha256,
    v_page, v_qid, v_client_id,
    v_revision, v_updated_at, v_server_updated_at, v_server_sha256,
    v_manifest, v_live_stroke_ids,
    v_new_stroke_ids, v_live_stroke_digests,
    v_new_stroke_digests, v_live_strokes,
    v_new_strokes,
    v_receipt, v_digest, v_issued_at
  );
  return v_receipt;
end;
$$;

revoke all on function public.matha_paper_correction_retry_accept(
  text, text, text, integer, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.matha_paper_correction_retry_accept(
  text, text, text, integer, text, jsonb
) to authenticated;
-- END PAPER CORRECTION RETRY RECEIPT 202608300006
