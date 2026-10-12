-- People found for free (Hunter Multi-Domain Search): shortened name, title, department, level, no email until revealed (1 credit).
alter table cp_people add column if not exists preview boolean not null default false;
alter table cp_people add column if not exists reveal_handle text;
alter table cp_people add column if not exists handle_period text;       -- billing month the handle belongs to, 'YYYY-MM'
alter table cp_people add column if not exists decision_maker boolean;
alter table cp_accounts add column if not exists people_previewed_at timestamptz;
create index if not exists cp_people_preview_idx on cp_people (account_id) where preview;
