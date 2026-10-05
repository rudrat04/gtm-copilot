-- Structured logs for every Edge Function run. Never store secrets or email addresses here.
create table cp_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  run_id uuid,                -- one id per function invocation, so a whole run can be replayed
  fn text not null,           -- research-account | signal-scan | queue | ...
  level text not null check (level in ('info', 'warn', 'error')),
  event text not null,        -- machine-friendly name, e.g. account_scanned, fetch_failed
  account text,               -- company domain, when relevant
  message text,
  detail jsonb not null default '{}'::jsonb,
  ms int                      -- duration, when relevant
);
create index cp_logs_time_idx on cp_logs (created_at desc);
create index cp_logs_run_idx on cp_logs (run_id);
create index cp_logs_problem_idx on cp_logs (created_at desc) where level <> 'info';

alter table cp_logs enable row level security;

create view cp_recent_problems with (security_invoker = true) as
  select created_at, fn, level, event, account, message, detail, run_id
  from cp_logs where level <> 'info' order by created_at desc limit 200;

create view cp_log_summary with (security_invoker = true) as
  select fn, level, event, count(*) as n, max(created_at) as last_seen
  from cp_logs where created_at > now() - interval '24 hours'
  group by fn, level, event order by n desc;

-- Keep 30 days of logs.
select cron.schedule('cp-logs-cleanup', '17 3 * * *',
  $$delete from cp_logs where created_at < now() - interval '30 days'$$);

-- PAUSED during development to avoid spending AI credits.
-- Resume before demos:  select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan'), active := true);
-- Pause again:          select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan'), active := false);
select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan'), active := false);
