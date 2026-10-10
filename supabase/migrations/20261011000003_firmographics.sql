-- Real company facts (headcount, funding, HQ) from Hunter's company data, used to enforce the ICP.
-- Existing columns employees, stage and country are now filled; these add the rest.
alter table cp_accounts
  add column if not exists employee_band text,
  add column if not exists raised_usd bigint,
  add column if not exists last_round_date date,
  add column if not exists founded_year int,
  add column if not exists hq_city text,
  add column if not exists firmo_at timestamptz;
