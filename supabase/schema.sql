-- 數A 13級分特訓系統 — Supabase schema + RLS
-- 使用方式：Supabase Dashboard → SQL Editor → 貼上整份 → Run（跑一次即可，可重複執行）
--
-- 另外到 Authentication → Sign In / Providers → Email 確認：
--   1. Email provider 開啟（預設開）
--   2. 「Confirm email」建議關閉（單人使用，省去收確認信的一步；不關的話註冊後要先點信中連結才能登入）
--
-- 前端只用 publishable key（sb_publishable_...），所有資料表都開 RLS、
-- 只允許 auth.uid() = user_id 的列被讀寫；不需要也不要用 service_role key。

-- ── 主狀態文件：整包 localStorage 的鏡像（做題紀錄、錯題本、模擬成績…）──
create table if not exists public.app_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null,
  revision   bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- 舊專案已存在 app_state 時補欄位；前端以 revision 做 compare-and-swap，
-- 兩台裝置同時上傳時落後者會重新拉取、合併、重試，不再整包互蓋。
alter table public.app_state add column if not exists revision bigint not null default 0;

-- Only explicitly approved accounts may use this private training system.
-- The first migration preserves accounts that already own app_state rows, while
-- newly registered accounts remain blocked until an owner inserts their UUID.
create table if not exists public.app_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.app_users (user_id)
select user_id from public.app_state
on conflict (user_id) do nothing;

alter table public.app_users enable row level security;
revoke all on table public.app_users from anon, authenticated;

create or replace function public.is_matha_user(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_users
    where user_id = candidate and enabled
  );
$$;
revoke all on function public.is_matha_user(uuid) from public;
grant execute on function public.is_matha_user(uuid) to authenticated, service_role;

alter table public.app_state enable row level security;

drop policy if exists "own state" on public.app_state;
create policy "own state" on public.app_state
  for all
  using (auth.uid() = user_id and public.is_matha_user(auth.uid()))
  with check (auth.uid() = user_id and public.is_matha_user(auth.uid()));

-- ── 手寫筆跡永久檔：每題一列，含完整筆畫時間戳與過程指標 ──
create table if not exists public.ink_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  client_id  text,
  qid        text not null,
  t0         bigint not null,          -- 該次作答起始（epoch ms）
  proc       jsonb,                    -- 過程指標摘要 {fi, hes, era, tail, n}
  strokes    jsonb not null,           -- {s:[筆畫…], e:[塗改時間…]} 完整原始資料
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- client_id 由瀏覽器在落筆時建立，同一份草稿／完稿以 upsert 冪等更新。
-- 既有列先補 legacy id，再收緊 NOT NULL，遷移可安全重跑。
alter table public.ink_sessions add column if not exists client_id text;
alter table public.ink_sessions add column if not exists updated_at timestamptz not null default now();
update public.ink_sessions set client_id = 'legacy-' || id::text where client_id is null;
alter table public.ink_sessions alter column client_id set not null;
create unique index if not exists ink_sessions_user_client
  on public.ink_sessions (user_id, client_id);

insert into public.app_users (user_id)
select distinct user_id from public.ink_sessions
on conflict (user_id) do nothing;

alter table public.ink_sessions enable row level security;

drop policy if exists "own ink" on public.ink_sessions;
create policy "own ink" on public.ink_sessions
  for all
  using (auth.uid() = user_id and public.is_matha_user(auth.uid()))
  with check (auth.uid() = user_id and public.is_matha_user(auth.uid()));

create index if not exists ink_sessions_user_time
  on public.ink_sessions (user_id, created_at desc);
-- 原卷採「低頻整頁快照 + 每筆/刪除增量事件」。依使用者、原卷頁面與更新時間載入，
-- 避免一整回累積數千筆後退化成全表掃描。
create index if not exists ink_sessions_user_qid_updated
  on public.ink_sessions (user_id, qid, updated_at desc);

-- ── 老師方法庫：42 堂課逐字稿蒸餾出的 1662 條方法（概念洞 UI 用） ──
-- 建表後資料由專案擁有者以本機工具灌入（來源 teacher-methodlib.json 屬私人內容，工具與資料皆不進公開 repo）
create table if not exists public.teacher_methods (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  unit       text not null,            -- 14 單元鍵（num line poly seq comb prob data trig1 trig2 exp vec svec splane mat）
  lec        int,                      -- 第幾堂課
  concept    text not null,            -- 這條方法對付的概念
  method     text not null,            -- 老師的方法本體
  mnemonic   text,                     -- 口訣
  black      text,                     -- 黑板答案
  ex         text,                     -- 例題標號
  created_at timestamptz not null default now()
);

alter table public.teacher_methods enable row level security;

drop policy if exists "own methods" on public.teacher_methods;
create policy "own methods" on public.teacher_methods
  for all
  using (auth.uid() = user_id and public.is_matha_user(auth.uid()))
  with check (auth.uid() = user_id and public.is_matha_user(auth.uid()));

create index if not exists teacher_methods_user_unit
  on public.teacher_methods (user_id, unit);

-- ── 內容包（題庫/重點/公式卡）：與作答狀態分家，匯入才上傳、不再隨每次作答整包同步 ──
-- （app 會自動偵測本表：存在→啟用分家並遷移；不存在→維持舊行為，隨時可補跑）
create table if not exists public.content_packs (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  pack_id    text not null,
  kind       text not null,             -- qpack | notes | flash
  name       text,
  rev        bigint not null default 1, -- 每次匯入遞增，跨裝置比對用
  items      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, pack_id)
);

alter table public.content_packs enable row level security;

drop policy if exists "own packs" on public.content_packs;
create policy "own packs" on public.content_packs
  for all
  using (auth.uid() = user_id and public.is_matha_user(auth.uid()))
  with check (auth.uid() = user_id and public.is_matha_user(auth.uid()));

-- Private, read-only curated question bank. Files are uploaded by the project
-- owner; signed-in learners can download them, but cannot alter the bank.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'matha-content',
  'matha-content',
  false,
  1048576,
  array['application/json']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated read matha content" on storage.objects;
drop policy if exists "approved read matha content" on storage.objects;
create policy "approved read matha content" on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'matha-content'
    and public.is_matha_user(auth.uid())
  );

-- Private service-role-only evidence. Runtime PDFs and audit/capability JSON
-- must never share the learner-readable question-bank bucket. There is
-- intentionally no SELECT/INSERT/UPDATE/DELETE policy for authenticated or
-- public roles; the Edge Function writes and immediately reads back objects
-- with the service role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'matha-audit-private',
  'matha-audit-private',
  false,
  14680064,
  array['application/pdf', 'application/json']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated read matha audit private" on storage.objects;
drop policy if exists "approved read matha audit private" on storage.objects;
drop policy if exists "public read matha audit private" on storage.objects;
drop policy if exists "own matha audit private" on storage.objects;

-- Private, read-only question figures cropped from the approved textbook scans.
-- Only owner-curated, independently verified crops are uploaded; full pages and
-- answer-bearing crops never enter the learner-facing bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'matha-figures',
  'matha-figures',
  false,
  8388608,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated read matha figures" on storage.objects;
drop policy if exists "approved read matha figures" on storage.objects;
create policy "approved read matha figures" on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'matha-figures'
    and public.is_matha_user(auth.uid())
  );

-- ── 私有原版模考掃描：只由專案擁有者在 Dashboard 上傳 ──
-- 掃描頁含使用者合法提供的紙本內容，因此不進公開 GitHub、不設 public bucket。
-- 前端登入後只能讀取；沒有 insert/update/delete policy，學習帳號無法改寫題本。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'matha-papers',
  'matha-papers',
  false,
  8388608,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated read matha papers" on storage.objects;
drop policy if exists "approved read matha papers" on storage.objects;
create policy "approved read matha papers" on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'matha-papers'
    and public.is_matha_user(auth.uid())
  );

-- 官方詳解裁圖與題本分桶：沒有 authenticated select policy。只有 Edge Function
-- 以 service role 在「隔日＋已保存真實重想」後簽發 15 分鐘網址，首輪 Network
-- 與一般 Storage client 都無法取得內容。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'matha-solutions',
  'matha-solutions',
  false,
  8388608,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated read matha solutions" on storage.objects;
drop policy if exists "approved read matha solutions" on storage.objects;

-- Atomic AI budget accounting. One full-paper grade has a much larger weight
-- than a small concept check, so accidental retries cannot silently burn cost.
create table if not exists public.ai_daily_usage (
  user_id       uuid not null references auth.users (id) on delete cascade,
  usage_date    date not null,
  request_count integer not null default 0,
  request_weight integer not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  last_request_at timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (user_id, usage_date)
);
alter table public.ai_daily_usage enable row level security;
revoke all on table public.ai_daily_usage from anon, authenticated;

create or replace function public.claim_ai_request(
  p_user_id uuid,
  p_kind text,
  p_weight integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  usage_day date := (timezone('Asia/Taipei', now()))::date;
  current_row public.ai_daily_usage%rowtype;
  safe_weight integer := greatest(1, least(coalesce(p_weight, 1), 20));
begin
  if not public.is_matha_user(p_user_id) then
    return jsonb_build_object('allowed', false, 'reason', 'not_allowed');
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  select * into current_row
  from public.ai_daily_usage
  where user_id = p_user_id and usage_date = usage_day
  for update;
  if found and current_row.last_request_at > now() - interval '4 seconds' then
    return jsonb_build_object('allowed', false, 'reason', 'rate_limited');
  end if;
  if found and (
    current_row.request_count >= 60
    or current_row.request_weight + safe_weight > 120
  ) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'daily_limit',
      'requests', current_row.request_count,
      'weight', current_row.request_weight
    );
  end if;
  insert into public.ai_daily_usage (
    user_id, usage_date, request_count, request_weight, last_request_at, updated_at
  ) values (
    p_user_id, usage_day, 1, safe_weight, now(), now()
  )
  on conflict (user_id, usage_date) do update set
    request_count = public.ai_daily_usage.request_count + 1,
    request_weight = public.ai_daily_usage.request_weight + safe_weight,
    last_request_at = now(),
    updated_at = now();
  select * into current_row
  from public.ai_daily_usage
  where user_id = p_user_id and usage_date = usage_day;
  return jsonb_build_object(
    'allowed', true,
    'kind', p_kind,
    'date', usage_day,          -- 回傳扣額日：跨午夜完成的請求把 token 記回這一天
    'requests', current_row.request_count,
    'weight', current_row.request_weight,
    'limit', 120
  );
end;
$$;
revoke all on function public.claim_ai_request(uuid, text, integer) from public;
grant execute on function public.claim_ai_request(uuid, text, integer) to service_role;

-- OpenAI 呼叫失敗（逾時/HTTP 錯誤/拒絕/沒回文字）時由 proxy 退還額度：
-- 否則整卷批改（權重 12）逾時幾次就燒光一天額度卻沒拿到結果。
-- p_usage_date＝claim 回傳的 date：80 秒逾時可能跨台北午夜，要退回「扣額那天」的列，
-- 不能退「退款當下」的列（新日列可能不存在→無聲 no-op，或退錯天）。地板為 0；last_request_at 不動。
drop function if exists public.refund_ai_request(uuid, integer);
create or replace function public.refund_ai_request(
  p_user_id uuid,
  p_weight integer,
  p_usage_date date default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_daily_usage
  set request_count = greatest(request_count - 1, 0),
      request_weight = greatest(request_weight - greatest(1, least(coalesce(p_weight, 1), 20)), 0),
      updated_at = now()
  where user_id = p_user_id
    and usage_date = coalesce(p_usage_date, (timezone('Asia/Taipei', now()))::date);
$$;
revoke all on function public.refund_ai_request(uuid, integer, date) from public;
grant execute on function public.refund_ai_request(uuid, integer, date) to service_role;

-- 簽名改了（加 p_usage_date）：先移除舊 3 參數版本，避免留下兩個 overload
drop function if exists public.record_ai_usage(uuid, bigint, bigint);
create or replace function public.record_ai_usage(
  p_user_id uuid,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_usage_date date default null
)
returns void
language sql
security definer
set search_path = public
as $$
  -- 記回「扣額那天」的列（p_usage_date＝claim 回傳的 date）；沒帶就記今天。
  update public.ai_daily_usage
  set input_tokens = input_tokens + greatest(coalesce(p_input_tokens, 0), 0),
      output_tokens = output_tokens + greatest(coalesce(p_output_tokens, 0), 0),
      updated_at = now()
  where user_id = p_user_id
    and usage_date = coalesce(p_usage_date, (timezone('Asia/Taipei', now()))::date);
$$;
revoke all on function public.record_ai_usage(uuid, bigint, bigint, date) from public;
grant execute on function public.record_ai_usage(uuid, bigint, bigint, date) to service_role;

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

-- BEGIN ACCEPTED PAPER INK FREEZE 202608300004
-- An accepted full-paper checkpoint is immutable evidence.  Serializing this
-- guard with submit arbitration prevents an already-open stale tab from
-- overwriting the exact cloud rows whose SHA-256 is bound to the receipt.
create or replace function public.matha_paper_ink_accepted_guard()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user uuid;
  v_old_run text;
  v_new_run text;
  v_blocked_run text;
begin
  if tg_op <> 'INSERT' then
    v_old_run := substring(
      coalesce(old.qid, '')
      from '^paper:(paper-run-[0-9]{10,20}):v[0-9]+:[0-9]+$'
    );
  end if;
  if tg_op <> 'DELETE' then
    v_new_run := substring(
      coalesce(new.qid, '')
      from '^paper:(paper-run-[0-9]{10,20}):v[0-9]+:[0-9]+$'
    );
  end if;
  if v_old_run is null and v_new_run is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' and not exists (
    select 1 from auth.users where id = old.user_id
  ) then
    return old;
  end if;
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    raise exception 'paper ink checkpoint owner is immutable'
      using errcode = '55000';
  end if;
  v_user := case when tg_op = 'INSERT' then new.user_id else old.user_id end;
  perform pg_advisory_xact_lock(
    hashtextextended('matha-paper-submit:' || v_user::text, 0)
  );
  select candidate.run_id into v_blocked_run
  from (
    values (v_old_run), (v_new_run)
  ) as requested(run_id)
  join public.paper_submit_attempts candidate
    on candidate.user_id = v_user
   and candidate.run_id = requested.run_id
   and candidate.status = 'accepted'
   and candidate.decision_reason = 'accepted-first-for-run'
  where requested.run_id is not null
  limit 1;
  if v_blocked_run is not null then
    raise exception 'accepted paper ink is immutable for run %', v_blocked_run
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.matha_paper_ink_accepted_guard()
  from public, anon, authenticated, service_role;
drop trigger if exists ink_sessions_accepted_paper_guard
  on public.ink_sessions;
create trigger ink_sessions_accepted_paper_guard
before insert or update or delete on public.ink_sessions
for each row execute function public.matha_paper_ink_accepted_guard();
-- END ACCEPTED PAPER INK FREEZE 202608300004
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

-- BEGIN PAPER GRADE LATEST STATUS 202608300008
-- Read-only reconciliation for two devices that merged different explicit
-- generation requests.  It reveals the one server-authoritative latest job
-- without reserving, leasing, dispatching or otherwise invoking a model.

create or replace function public.matha_paper_grade_latest_status(
  p_user_id uuid,
  p_run_id text,
  p_accepted_attempt_id text
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
      or coalesce(p_accepted_attempt_id, '') !~ '^paper-submit-[A-Za-z0-9._:-]{16,127}$' then
    raise exception 'invalid latest paper grade job status request'
      using errcode = '22023';
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
  order by generation desc
  limit 1;
  if not found then
    return jsonb_build_object(
      'action', 'missing', 'status', 'missing', 'generation', null
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

revoke all on function public.matha_paper_grade_latest_status(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.matha_paper_grade_latest_status(uuid, text, text)
  to service_role;
-- END PAPER GRADE LATEST STATUS 202608300008
-- BEGIN SERVER-OWNED PAPER SOURCE CONTRACT 202608300009
-- Submission shape and the aggregate ink digest are database authority.  The
-- browser supplies checkpoint identities, never the aggregate digest.

create table if not exists public.paper_source_registry (
  source_id text primary key,
  page_count integer not null check (page_count between 1 and 20),
  paper_layout_version integer not null check (paper_layout_version between 1 and 100),
  required_app_version text not null check (required_app_version ~ '^[0-9]{4}[a-z]$'),
  submit_enabled boolean not null default false
);
revoke all on table public.paper_source_registry from public, anon, authenticated, service_role;

insert into public.paper_source_registry(source_id,page_count,paper_layout_version,required_app_version,submit_enabled)
values
 ('paper-mock-1',6,2,'0830b',true), ('paper-mock-2',6,2,'0830b',false), ('paper-mock-3',4,2,'0830b',true),
 ('paper-regional-ra4109',4,2,'0830b',true), ('paper-regional-ra4110',3,2,'0830b',true),
 ('paper-regional-ra3101',3,2,'0830b',true), ('paper-regional-ra3102',3,2,'0830b',true),
 ('paper-regional-ra1104',3,2,'0830b',true), ('paper-regional-ra2100',3,2,'0830b',true),
 ('paper-regional-ra2101',3,2,'0830b',true), ('paper-regional-ra1103',3,2,'0830b',true),
 ('paper-official-110-trial',8,2,'0830b',true), ('paper-official-111',8,2,'0830b',true),
 ('paper-official-112',8,2,'0830b',true), ('paper-official-113',8,2,'0830b',true),
 ('paper-official-114',8,2,'0830b',true), ('paper-official-115',8,2,'0830b',true)
on conflict (source_id) do update set
 page_count=excluded.page_count, paper_layout_version=excluded.paper_layout_version,
 required_app_version=excluded.required_app_version,
 submit_enabled=excluded.submit_enabled;


alter table public.paper_submit_attempts
 add column if not exists run_created_at bigint,
 add column if not exists paper_layout_version integer,
 add column if not exists source_page_count integer;
alter table public.paper_submit_attempts
 add column if not exists freshness_confirmed_at bigint;

do $$ begin
 if exists (select 1 from public.paper_submit_attempts where status='accepted'
   and (run_created_at is null or paper_layout_version is null or source_page_count is null)) then
  raise exception 'legacy accepted paper attempts require explicit contract migration before cutover'
    using errcode='55000';
 end if;
end $$;

create or replace function public.matha_paper_submit_receipt(
 p_result public.paper_submit_attempts, p_winner public.paper_submit_attempts default null
) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object(
  'attempt_id',(p_result).attempt_id,'run_id',(p_result).run_id,
  'source_id',(p_result).source_id,'status',(p_result).status,
  'remaining_ms',(p_result).remaining_ms,'ink_snapshot_sha256',(p_result).ink_snapshot_sha256,
  'page_manifest',(p_result).page_manifest,'submitted_at',(p_result).submitted_at,
  'accepted_at',(p_result).accepted_at,'canceled_at',(p_result).canceled_at,
  'run_created_app_version',(p_result).run_created_app_version,
  'run_created_at',(p_result).run_created_at,
  'paper_layout_version',(p_result).paper_layout_version,
  'source_page_count',(p_result).source_page_count,
  'freshness_confirmed_at',(p_result).freshness_confirmed_at,
  'decision_reason',(p_result).decision_reason,'winner_attempt_id',(p_result).winner_attempt_id,
  'winner',case when (p_winner).attempt_id is null then null else
   public.matha_paper_submit_receipt(p_winner,null) end
 );
$$;
revoke all on function public.matha_paper_submit_receipt(public.paper_submit_attempts,public.paper_submit_attempts)
 from public,anon,authenticated,service_role;

create or replace function public.matha_paper_submit_source_contract_stamp()
returns trigger language plpgsql set search_path=public as $$
begin
 if new.status='accepted' then
  new.run_created_at := nullif(current_setting('matha.submit_run_created_at',true),'')::bigint;
  new.paper_layout_version := nullif(current_setting('matha.submit_layout_version',true),'')::integer;
  new.source_page_count := nullif(current_setting('matha.submit_page_count',true),'')::integer;
  new.freshness_confirmed_at := nullif(current_setting('matha.submit_freshness_confirmed_at',true),'')::bigint;
  if new.run_created_at is null or new.paper_layout_version is null or new.source_page_count is null then
   raise exception 'server paper source contract missing' using errcode='55000'; end if;
 end if;
 return new;
end;
$$;
revoke all on function public.matha_paper_submit_source_contract_stamp() from public,anon,authenticated,service_role;
drop trigger if exists paper_submit_source_contract_stamp on public.paper_submit_attempts;
create trigger paper_submit_source_contract_stamp before insert on public.paper_submit_attempts
for each row execute function public.matha_paper_submit_source_contract_stamp();

create or replace function public.matha_paper_submit_accept(
 p_attempt_id text, p_run_id text, p_source_id text, p_remaining_ms bigint,
 p_submitted_at bigint, p_run_created_app_version text, p_run_created_at bigint,
 p_paper_layout_version integer, p_freshness_confirmed_at bigint, p_page_manifest jsonb
) returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
 v_user uuid := auth.uid(); v_source public.paper_source_registry%rowtype;
 v_item jsonb; v_ink public.ink_sessions%rowtype; v_pages jsonb := '[]'::jsonb;
 v_page integer; v_revision integer; v_server_sha text; v_aggregate text;
 v_receipt jsonb; v_result public.paper_submit_attempts%rowtype;
begin
 if v_user is null or not public.is_matha_user(v_user) then
  raise exception 'authenticated MathA user required' using errcode='42501'; end if;
 select * into v_source from public.paper_source_registry where source_id=p_source_id and submit_enabled;
 if not found or p_run_created_at is null or p_run_created_at not between 1 and 9007199254740991
   or p_submitted_at <= p_run_created_at
   or p_submitted_at > floor(extract(epoch from clock_timestamp())*1000)::bigint
   or p_run_created_app_version is distinct from v_source.required_app_version
   or p_paper_layout_version is distinct from v_source.paper_layout_version
   or (p_source_id <> 'paper-mock-1' and (p_freshness_confirmed_at is null
     or p_freshness_confirmed_at < p_run_created_at or p_freshness_confirmed_at > p_submitted_at))
   or (p_source_id = 'paper-mock-1' and p_freshness_confirmed_at is not null)
   or jsonb_typeof(p_page_manifest) <> 'array'
   or jsonb_array_length(p_page_manifest) <> v_source.page_count then
  raise exception 'paper source contract mismatch' using errcode='22023'; end if;

 for v_item in select value from jsonb_array_elements(p_page_manifest) loop
  v_page := (v_item->>'page')::integer; v_revision := (v_item->>'revision')::integer;
  if v_page < 0 or v_page >= v_source.page_count
    or v_item->>'qid' <> 'paper:'||p_run_id||':v'||p_paper_layout_version||':'||v_page
    or coalesce(v_item->>'clientId','') = '' then
   raise exception 'paper source page identity mismatch' using errcode='22023'; end if;
  select * into v_ink from public.ink_sessions
   where user_id=v_user and client_id=v_item->>'clientId' and qid=v_item->>'qid'
     and updated_at=(v_item->>'updatedAt')::timestamptz;
  if not found or v_ink.t0 is distinct from p_run_created_at + v_page
    or (v_ink.proc->>'page')::integer is distinct from v_page
    or (v_ink.proc->>'revision')::integer is distinct from v_revision then
   raise exception 'paper source checkpoint mismatch' using errcode='40001'; end if;
  v_server_sha := encode(extensions.digest(convert_to(public.matha_canonical_jsonb_text(v_ink.strokes),'UTF8'),'sha256'),'hex');
  if v_server_sha is distinct from v_item->>'cloudSha256' then
   raise exception 'paper source digest mismatch' using errcode='40001'; end if;
  v_pages := v_pages || jsonb_build_array(jsonb_build_object(
   'page',v_page,'qid',v_item->>'qid','clientId',v_item->>'clientId',
   'revision',v_revision,'sha256',v_server_sha));
 end loop;
 if (select count(distinct (x->>'page')::integer) from jsonb_array_elements(v_pages)x) <> v_source.page_count
   or (select min((x->>'page')::integer) from jsonb_array_elements(v_pages)x) <> 0
   or (select max((x->>'page')::integer) from jsonb_array_elements(v_pages)x) <> v_source.page_count-1 then
  raise exception 'paper source pages not exact' using errcode='22023'; end if;
 select jsonb_agg(x order by (x->>'page')::integer) into v_pages from jsonb_array_elements(v_pages)x;
 v_aggregate := encode(extensions.digest(convert_to(public.matha_canonical_jsonb_text(jsonb_build_object(
  'schema',1,'runId',p_run_id,'sourceId',p_source_id,'paperLayoutVersion',p_paper_layout_version,
  'submittedAt',p_submitted_at,
  'revisions',(select jsonb_agg(jsonb_build_object('page',(x->>'page')::integer,
    'revision',(x->>'revision')::integer,'persistedRevision',(x->>'revision')::integer,'dirty',false)
    order by (x->>'page')::integer) from jsonb_array_elements(v_pages)x),
  'pages',(select jsonb_agg(jsonb_build_object('page',(x->>'page')::integer,'qid',x->>'qid',
    'clientId',x->>'clientId','sha256',x->>'sha256','cloudSha256',x->>'sha256')
    order by (x->>'page')::integer) from jsonb_array_elements(v_pages)x)
 )),'UTF8'),'sha256'),'hex');

 perform set_config('matha.submit_run_created_at',p_run_created_at::text,true);
 perform set_config('matha.submit_layout_version',p_paper_layout_version::text,true);
 perform set_config('matha.submit_page_count',v_source.page_count::text,true);
 perform set_config('matha.submit_freshness_confirmed_at',coalesce(p_freshness_confirmed_at::text,''),true);
 v_receipt := public.matha_paper_submit_accept(p_attempt_id,p_run_id,p_source_id,p_remaining_ms,
  v_aggregate,p_submitted_at,p_run_created_app_version,p_page_manifest);
  select * into v_result from public.paper_submit_attempts where user_id=v_user and attempt_id=p_attempt_id;
 return public.matha_paper_submit_receipt(v_result,
  case when v_result.winner_attempt_id is null then null else
   (select w from public.paper_submit_attempts w where w.user_id=v_user and w.attempt_id=v_result.winner_attempt_id) end);
end;
$$;
revoke all on function public.matha_paper_submit_accept(text,text,text,bigint,text,bigint,text,jsonb)
 from public,anon,authenticated,service_role;
drop function if exists public.matha_paper_submit_accept(text,text,text,bigint,bigint,text,bigint,integer,jsonb);
revoke all on function public.matha_paper_submit_accept(text,text,text,bigint,bigint,text,bigint,integer,bigint,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function public.matha_paper_submit_accept(text,text,text,bigint,bigint,text,bigint,integer,bigint,jsonb)
 to authenticated;

create or replace function public.matha_paper_submit_lookup_run(p_run_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_result public.paper_submit_attempts%rowtype;
begin
 if v_user is null or not public.is_matha_user(v_user) or p_run_id !~ '^paper-run-[0-9]{10,20}$' then
  raise exception 'invalid paper run lookup' using errcode='42501'; end if;
 select * into v_result from public.paper_submit_attempts
  where user_id=v_user and run_id=p_run_id and status='accepted';
 if not found then return null; end if;
 return public.matha_paper_submit_receipt(v_result,null);
end $$;
revoke all on function public.matha_paper_submit_lookup_run(text) from public,anon,authenticated,service_role;
grant execute on function public.matha_paper_submit_lookup_run(text) to authenticated;
-- END SERVER-OWNED PAPER SOURCE CONTRACT 202608300009

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
