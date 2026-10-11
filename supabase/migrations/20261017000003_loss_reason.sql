-- Ask for a loss reason once per lost deal.
alter table cp_accounts add column if not exists loss_asked_at timestamptz;
