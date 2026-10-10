-- Hot alerts already sent (one per account and set of new signals), and HubSpot tasks already created.
create table cp_alerts (
  account_id uuid not null references cp_accounts(id) on delete cascade,
  signal_hash text not null,
  sent_at timestamptz not null default now(),
  primary key (account_id, signal_hash)
);
alter table cp_alerts enable row level security;

create table cp_tasks (
  key text primary key,                 -- e.g. fu:<account>:<touch>, hot:<account>:<hash>, sum:<date>
  account_id uuid references cp_accounts(id) on delete set null,
  hubspot_task_id text,
  created_at timestamptz not null default now()
);
alter table cp_tasks enable row level security;

-- Daily light check of queued accounts, 01:00 UTC (06:30 India). Only fetches public sources.
select cron.schedule('signal-watch', '0 1 * * *',
  $$select net.http_post(
      url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/signal-scan',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{"mode": "light"}'::jsonb,
      timeout_milliseconds := 140000
  )$$);

-- Morning digest email and HubSpot tasks, 02:30 UTC (08:00 India).
select cron.schedule('daily-digest', '30 2 * * *',
  $$select net.http_post(
      url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/daily-digest',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 140000
  )$$);
