-- Weekly scan: Mondays 06:00-06:55 UTC, every 5 minutes. Each run scans up to 6 stale accounts,
-- so 12 runs cover the whole list, and the rest of the week the job finds nothing to do.
-- Accounts count as stale after 6 days (see icp.json -> schedule.staleDays).
select cron.alter_job(
  (select jobid from cron.job where jobname = 'signal-scan'),
  schedule := '*/5 6 * * 1',
  active := true
);

-- Lets the Queue page show whether the scan is active, without exposing the cron schema.
create or replace function cp_scan_schedule()
returns table (active boolean, schedule text)
language sql
security definer
set search_path = ''
as $$
  select j.active, j.schedule from cron.job j where j.jobname = 'signal-scan'
$$;

revoke all on function cp_scan_schedule() from public, anon, authenticated;
grant execute on function cp_scan_schedule() to service_role;
