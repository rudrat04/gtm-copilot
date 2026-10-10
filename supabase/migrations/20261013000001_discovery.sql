-- Auto-discovery: companies found in public sources, what we decided, and why.
create table if not exists cp_discovered (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique,
  name text not null,
  source text not null,              -- hn_hiring
  source_url text,                   -- the public post it came from
  snippet text,                      -- short excerpt: what they said about the roles
  status text not null default 'found' check (status in ('found', 'added', 'rejected')),
  reason text,                       -- why it was added or rejected, in plain English
  account_id uuid references cp_accounts(id) on delete set null,
  found_at timestamptz not null default now()
);
alter table cp_discovered enable row level security;
create index if not exists cp_discovered_account_idx on cp_discovered (account_id);
create index if not exists cp_discovered_found_idx on cp_discovered (found_at desc);

-- Weekly, before the signal scan (Mondays 05:00 UTC), so new companies are scored the same morning.
select cron.schedule('discover', '0 5 * * 1', $job$
  select net.http_post(
    url := 'https://tecgblsoylrshcqneevf.supabase.co/functions/v1/discover',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from cp_state where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 140000) $job$);
