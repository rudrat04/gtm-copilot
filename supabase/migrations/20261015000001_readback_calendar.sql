-- Reading HubSpot back (completed to-dos, deal stages, closed-lost deals) and calendar changes (cancelled, moved).
alter table cp_tasks add column if not exists done_at timestamptz;
alter table cp_accounts add column if not exists deal_stage text;
alter table cp_accounts add column if not exists lost_at timestamptz;
alter table cp_accounts add column if not exists lost_reason text;
alter table cp_accounts add column if not exists won_at timestamptz;

alter table cp_meetings add column if not exists cancelled_at timestamptz;
alter table cp_meetings add column if not exists rescheduled_from timestamptz;
alter table cp_meetings add column if not exists reschedule_count int not null default 0;
alter table cp_meetings drop constraint if exists cp_meetings_status_check;
alter table cp_meetings add constraint cp_meetings_status_check check (status in ('seen', 'briefed', 'skipped', 'failed', 'cancelled'));

-- Every 30 minutes: read HubSpot back. Returns quickly when nothing changed.
select cron.schedule('crm-sync', '*/30 * * * *', $job$
  select net.http_post(
    url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/crm-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from cp_state where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000) $job$);
