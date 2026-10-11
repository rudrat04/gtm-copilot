-- Never cold-contact someone who is already known, opted out, or bounced in HubSpot.
alter table cp_people add column if not exists hs_status text check (hs_status in ('known', 'opted_out', 'bounced'));
alter table cp_people add column if not exists hs_note text;
alter table cp_people add column if not exists hs_checked_at timestamptz;
