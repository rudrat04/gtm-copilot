-- Health panel: read-only view of the scheduled jobs (state, last run, last result).
create or replace function cp_cron_health()
returns table (jobname text, active boolean, schedule text, last_start timestamptz, last_status text, last_message text)
language sql
security definer
set search_path = ''
as $$
  select j.jobname::text, j.active, j.schedule::text, d.start_time, d.status::text, left(d.return_message, 200)
  from cron.job j
  left join lateral (
    select start_time, status, return_message from cron.job_run_details r
    where r.jobid = j.jobid order by start_time desc limit 1
  ) d on true
$$;

revoke all on function cp_cron_health() from public, anon, authenticated;
grant execute on function cp_cron_health() to service_role;
