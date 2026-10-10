-- Outreach lifecycle per account, an audit trail of every action, and a cache for the "Why today" line.
alter table cp_accounts
  add column if not exists outreach_status text not null default 'open'
    check (outreach_status in ('open', 'contacted', 'replied', 'meeting', 'snoozed', 'not_now')),
  add column if not exists contacted_at timestamptz,
  add column if not exists touches int not null default 0,
  add column if not exists next_followup_at timestamptz,
  add column if not exists snoozed_until timestamptz;

create index if not exists cp_accounts_outreach_idx on cp_accounts (outreach_status, next_followup_at);

-- Every action a rep takes, with a snapshot of the scores and signals at that moment.
-- This becomes the data for "which signals actually lead to replies".
create table cp_outcomes (
  id bigint generated always as identity primary key,
  account_id uuid not null references cp_accounts(id) on delete cascade,
  kind text not null check (kind in ('contacted', 'replied', 'meeting', 'snoozed', 'not_now', 'reopened')),
  note text,
  priority int,
  tier text,
  signals jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index cp_outcomes_account_idx on cp_outcomes (account_id, created_at desc);
alter table cp_outcomes enable row level security;

-- One AI sentence per account and signal set, so it is only regenerated when signals change.
create table cp_why_today (
  account_id uuid not null references cp_accounts(id) on delete cascade,
  signal_hash text not null,
  text text not null,
  created_at timestamptz not null default now(),
  primary key (account_id, signal_hash)
);
alter table cp_why_today enable row level security;
alter table cp_accounts add column if not exists last_touch_at timestamptz;
