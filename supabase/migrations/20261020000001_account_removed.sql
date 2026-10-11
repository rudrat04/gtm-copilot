-- "Remove" hides a company everywhere and blocks it from coming back; Restore clears this.
alter table cp_accounts add column if not exists removed_at timestamptz;
create index if not exists cp_accounts_removed_idx on cp_accounts (removed_at);
