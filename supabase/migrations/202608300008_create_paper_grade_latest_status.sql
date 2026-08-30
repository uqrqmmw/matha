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
