-- A person found by researching a company only joins the People list once the owner adds them.
alter table cp_people add column if not exists kept_at timestamptz;
