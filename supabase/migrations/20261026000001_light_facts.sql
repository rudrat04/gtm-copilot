-- Size that came for free with a discovered company (a Hunter size bucket or a Y Combinator team size), so it needs no paid lookup.
alter table cp_accounts add column if not exists light_source text; -- 'hunter' or 'yc'
