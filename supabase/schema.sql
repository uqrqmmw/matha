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
