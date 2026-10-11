-- Pipeline watch: things that look off, remembered so each one fires once and clears itself.
create table if not exists cp_flags (
  key text primary key,                       -- kind:account[:extra], one row per problem
  kind text not null,
  account_id uuid references cp_accounts(id) on delete cascade,
  severity text not null default 'normal' check (severity in ('urgent', 'normal')),
  title text not null,
  detail text,
  since timestamptz not null default now(),   -- when the condition began
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved_at timestamptz,
  snoozed_until timestamptz,
  dismissed_at timestamptz,
  hubspot_task_id text
);
create index if not exists cp_flags_open_idx on cp_flags (severity, since) where resolved_at is null;
create index if not exists cp_flags_account_idx on cp_flags (account_id);
alter table cp_flags enable row level security;

-- The urgent pass: every 3 hours.
select cron.schedule('flags-urgent', '0 */3 * * *', $job$
  select net.http_post(
    url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/flags',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from cp_state where key = 'cron_secret')),
    body := '{"mode": "urgent"}'::jsonb, timeout_milliseconds := 60000) $job$);
