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
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "own state" on public.app_state;
create policy "own state" on public.app_state
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 手寫筆跡永久檔：每題一列，含完整筆畫時間戳與過程指標 ──
create table if not exists public.ink_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  qid        text not null,
  t0         bigint not null,          -- 該次作答起始（epoch ms）
  proc       jsonb,                    -- 過程指標摘要 {fi, hes, era, tail, n}
  strokes    jsonb not null,           -- {s:[筆畫…], e:[塗改時間…]} 完整原始資料
  created_at timestamptz not null default now()
);

alter table public.ink_sessions enable row level security;

drop policy if exists "own ink" on public.ink_sessions;
create policy "own ink" on public.ink_sessions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists ink_sessions_user_time
  on public.ink_sessions (user_id, created_at desc);

-- ── 老師方法庫：42 堂課逐字稿蒸餾出的 1662 條方法（概念洞 UI 用） ──
-- 建表後資料用 supabase/upload_methodlib.py 灌入（來源檔在 E:\C槽冷資料\Desktop\重考\_matha_backup\teacher-methodlib.json）
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
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

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
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

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
create policy "authenticated read matha content" on storage.objects
  for select
  to authenticated
  using (bucket_id = 'matha-content');
