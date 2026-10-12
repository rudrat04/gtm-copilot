-- Remember when a company was searched for people (and by whom), and mark alerts that were held back for the daily email.
alter table cp_accounts add column if not exists people_searched_at timestamptz;
alter table cp_accounts add column if not exists people_search_source text; -- 'auto' or 'manual'
alter table cp_alerts add column if not exists deferred boolean not null default false;
update cp_accounts a set people_searched_at = (select min(p.created_at) from cp_people p where p.account_id = a.id), people_search_source = 'manual'
 where people_searched_at is null and exists (select 1 from cp_people p where p.account_id = a.id);
