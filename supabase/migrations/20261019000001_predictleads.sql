-- When PredictLeads news events were last fetched for an account (the monthly call allowance is small, so we space the checks out).
alter table cp_accounts add column if not exists pl_checked_at timestamptz;
