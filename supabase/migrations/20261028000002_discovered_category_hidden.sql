-- Skipped companies get a plain-language category, and can be hidden from the list (the row stays, so the company is not looked at again).
alter table cp_discovered add column if not exists category text;
alter table cp_discovered add column if not exists hidden_at timestamptz;
update cp_discovered set category = case
  when reason ilike 'Below the fit bar%' then 'Outside your size or stage'
  when reason ilike '%did not load%' then 'Website did not load'
  when reason ~* '(agency|consult|staffing|systems integrator|service provider|services firm|custom software for clients|builds software for clients|reseller)' then 'Services or agency'
  when reason ~* '(consumer|B2C|personal learning)' then 'Consumer product'
  when reason ~* '(hardware|manufactur|materials|insurance|brokerage|exchange|marketplace|non-?profit|universit|research-stage|biotech|robot)' then 'Not a software company'
  else 'Not a fit for what you sell' end
where status = 'rejected' and category is null;
