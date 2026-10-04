-- Account Copilot core schema. All access goes through Edge Functions using the service role,
-- so RLS is enabled with no client policies.

create extension if not exists pgcrypto;

create table cp_accounts (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique,
  name text not null,
  segment text,
  employees int,
  stage text,
  country text,
  source text not null default 'fixture',
  icp_score int check (icp_score between 0 and 100),
  priority_score int check (priority_score between 0 and 100),
  why_now text,
  status text not null default 'new'
    check (status in ('new', 'queued', 'approved', 'rejected', 'pushed')),
  hubspot_company_id text,
  last_scanned_at timestamptz,
  created_at timestamptz not null default now()
);

create table cp_signals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references cp_accounts(id) on delete cascade,
  kind text not null check (kind in ('hiring', 'news', 'hn', 'tech', 'site')),
  title text not null,
  url text,
  detail jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  unique (account_id, kind, title)
);
create index cp_signals_account_idx on cp_signals(account_id, detected_at desc);

create table cp_dossiers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references cp_accounts(id) on delete cascade,
  content jsonb not null,
  model text,
  created_at timestamptz not null default now()
);
create index cp_dossiers_account_idx on cp_dossiers(account_id, created_at desc);

create table cp_outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references cp_accounts(id) on delete cascade,
  persona text,
  subject text not null,
  body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'drafted')),
  gmail_draft_id text,
  created_at timestamptz not null default now()
);

create table cp_meetings (
  id uuid primary key default gen_random_uuid(),
  calendar_event_id text not null unique,
  title text,
  starts_at timestamptz,
  attendee_email text,
  attendee_domain text,
  account_id uuid references cp_accounts(id) on delete set null,
  brief text,
  status text not null default 'seen'
    check (status in ('seen', 'briefed', 'skipped', 'failed')),
  created_at timestamptz not null default now()
);

create table cp_ai_usage (
  id bigint generated always as identity primary key,
  feature text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now()
);

create view cp_ai_spend_today as
  select coalesce(sum(cost_usd), 0) as usd, count(*) as calls
  from cp_ai_usage
  where created_at >= date_trunc('day', now());

alter table cp_accounts enable row level security;
alter table cp_signals enable row level security;
alter table cp_dossiers enable row level security;
alter table cp_outreach_drafts enable row level security;
alter table cp_meetings enable row level security;
alter table cp_ai_usage enable row level security;
alter view cp_ai_spend_today set (security_invoker = true);
