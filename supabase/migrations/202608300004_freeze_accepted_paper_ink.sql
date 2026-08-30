-- BEGIN ACCEPTED PAPER INK FREEZE 202608300004
-- Once a full-paper submit attempt has been accepted, the independently
-- persisted page checkpoints are evidence.  A stale tab must not overwrite or
-- delete them through the normal (user_id, client_id) upsert path.

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

  -- Ordinary practice and the separate correction overlay do not match the
  -- exact paper checkpoint namespace and remain writable.
  if v_old_run is null and v_new_run is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- The auth.users parent row is already absent while ON DELETE CASCADE is
  -- removing child rows.  Let account deletion satisfy the declared retention
  -- contract instead of trapping private evidence forever.
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

  -- This is the same per-learner lock used by submit accept/cancel.  Therefore
  -- an ink write and an accept decision cannot both cross the boundary at the
  -- same time: the transaction that obtains the lock second observes the
  -- first transaction's committed state.
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
