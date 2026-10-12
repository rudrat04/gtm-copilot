-- Watchlist v2: people can be followed too, and every movement on a followed company or person (and on a competitor) is stored as an event.
alter table cp_people add column if not exists watched_at timestamptz;
alter table cp_people add column if not exists watch_checked_at timestamptz;
alter table cp_people add column if not exists watch_notify text not null default 'instant' check (watch_notify in ('instant','daily','off'));
alter table cp_accounts add column if not exists watch_notify text not null default 'instant' check (watch_notify in ('instant','daily','off'));
create table if not exists cp_watch_events (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  kind text not null,
  importance text not null default 'small' check (importance in ('big','small')),
  account_id uuid references cp_accounts(id) on delete cascade,
  person_id uuid references cp_people(id) on delete cascade,
  subject text,
  title text not null,
  url text,
  detected_at timestamptz not null default now(),
  seen_at timestamptz,
  emailed_at timestamptz
);
create index if not exists cp_watch_events_time_idx on cp_watch_events (detected_at desc);
create index if not exists cp_watch_events_account_idx on cp_watch_events (account_id);
alter table cp_watch_events enable row level security;
