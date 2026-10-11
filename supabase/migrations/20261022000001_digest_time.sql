-- The owner picks when the daily email arrives. The signal check runs 90 minutes earlier so the email is fresh.
create or replace function cp_digest_time()
returns text
language sql
security definer
set search_path = ''
as $$
  select lpad(split_part(split_part(schedule, ' ', 2), ',', 1), 2, '0') || ':' || lpad(split_part(schedule, ' ', 1), 2, '0')
  from cron.job where jobname = 'daily-digest'
$$;

create or replace function cp_set_digest_time(h int, m int)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  total int := h * 60 + m;
  early int := ((total - 90) % 1440 + 1440) % 1440;
begin
  if h < 0 or h > 23 or m < 0 or m > 59 then raise exception 'bad time'; end if;
  perform cron.alter_job((select jobid from cron.job where jobname = 'daily-digest'), schedule := m || ' ' || h || ' * * *');
  perform cron.alter_job((select jobid from cron.job where jobname = 'signal-watch'), schedule := (early % 60) || ' ' || (early / 60) || ' * * *');
  return lpad(h::text, 2, '0') || ':' || lpad(m::text, 2, '0');
end
$$;

revoke all on function cp_digest_time() from public, anon, authenticated;
revoke all on function cp_set_digest_time(int, int) from public, anon, authenticated;
grant execute on function cp_digest_time() to service_role;
grant execute on function cp_set_digest_time(int, int) to service_role;
