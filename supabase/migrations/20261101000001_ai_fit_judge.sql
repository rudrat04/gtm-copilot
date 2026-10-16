alter table cp_accounts
  add column if not exists fit_ai text,
  add column if not exists fit_ai_conf numeric,
  add column if not exists fit_ai_reason text,
  add column if not exists fit_ai_ver text,
  add column if not exists fit_ai_at timestamptz,
  add column if not exists fit_override text,
  add column if not exists fit_override_note text;
