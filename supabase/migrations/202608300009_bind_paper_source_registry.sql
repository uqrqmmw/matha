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
