-- What HubSpot already holds about a company we may not have created: its id and how many contacts it has there (read-only knowledge, never used to write).
alter table cp_accounts add column if not exists hs_seen_id text;
alter table cp_accounts add column if not exists hs_contacts int;
alter table cp_accounts add column if not exists hs_checked_at timestamptz;
