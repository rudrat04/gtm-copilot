-- Meeting briefs: extra columns, plus a tiny key/value table for the Calendar poll cursor.
alter table cp_meetings add column if not exists attendee_name text;
alter table cp_meetings add column if not exists error text;
alter table cp_meetings add column if not exists emailed_at timestamptz;
alter table cp_meetings add column if not exists attempts int not null default 0;

create table if not exists cp_state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table cp_state enable row level security;

-- Poll Calendar every minute. The function returns immediately when nothing changed.
select cron.schedule(
  'meeting-brief',
  '* * * * *',
  $$select net.http_post(
      url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/meeting-brief',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
  )$$
);
-- Created paused; switched on after the first manual test with:
select cron.alter_job((select jobid from cron.job where jobname = 'meeting-brief'), active := false);
