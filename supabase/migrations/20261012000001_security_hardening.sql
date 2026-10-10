-- 1) A secret that only the database and the Edge Functions know. Scheduled jobs send it, the jobs' endpoints
--    check it, so nobody else can trigger them. It is generated here and never leaves the database.
insert into cp_state (key, value)
values ('cron_secret', encode(gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- Point every scheduled job at its endpoint with the secret attached.
select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan'), command := $job$
  select net.http_post(
    url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/signal-scan',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from cp_state where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000) $job$);
select cron.alter_job((select jobid from cron.job where jobname = 'signal-watch'), command := $job$
  select net.http_post(
    url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/signal-scan',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from cp_state where key = 'cron_secret')),
    body := '{"mode": "light"}'::jsonb, timeout_milliseconds := 140000) $job$);
select cron.alter_job((select jobid from cron.job where jobname = 'daily-digest'), command := $job$
  select net.http_post(
    url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from cp_state where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 140000) $job$);
select cron.alter_job((select jobid from cron.job where jobname = 'meeting-brief'), command := $job$
  select net.http_post(
    url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/meeting-brief',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from cp_state where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 55000) $job$);

-- 2) Simple rate limiting for the public endpoint that can spend AI credits.
create table if not exists cp_rate (
  bucket text not null,
  window_start timestamptz not null,
  n int not null default 0,
  primary key (bucket, window_start)
);
alter table cp_rate enable row level security;

-- 3) Cover the foreign keys the advisor flagged.
create index if not exists cp_meetings_account_idx on cp_meetings (account_id);
create index if not exists cp_outreach_drafts_account_idx on cp_outreach_drafts (account_id);
create index if not exists cp_tasks_account_idx on cp_tasks (account_id);
