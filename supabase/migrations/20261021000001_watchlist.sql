-- Companies the owner chose to follow: they skip the fit bar and get their own alerts.
alter table cp_accounts add column if not exists watched_at timestamptz;
create index if not exists cp_accounts_watched_idx on cp_accounts (watched_at) where watched_at is not null;
