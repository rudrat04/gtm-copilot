-- Phase 2: richer company facts for fit (all optional; empty means "not looked up yet").
alter table cp_accounts add column if not exists industry text;            -- Hunter category: sector / industry group / industry
alter table cp_accounts add column if not exists tags text[];              -- Hunter tags
alter table cp_accounts add column if not exists tech text[];              -- tools the company uses (Hunter tech list, lowercase)
alter table cp_accounts add column if not exists blurb text;               -- one-line description (first 300 characters)
alter table cp_accounts add column if not exists linkedin_handle text;
alter table cp_accounts add column if not exists facts2_at timestamptz;    -- when industry and tech were stored
alter table cp_accounts add column if not exists sales_motion text check (sales_motion in ('sales_led', 'self_serve', 'both'));
alter table cp_accounts add column if not exists known_as text check (known_as in ('customer'));  -- already known in HubSpot, so not a prospect
alter table cp_accounts add column if not exists not_fit_reason text;
alter table cp_accounts add column if not exists not_fit_at timestamptz;
