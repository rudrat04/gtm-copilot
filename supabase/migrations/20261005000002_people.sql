-- People found for an account by a data provider (Hunter today; Apollo or others later).
-- Emails are stored when found but only exposed after the owner clicks Enrich.
create table cp_people (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references cp_accounts(id) on delete cascade,
  provider text not null,
  first_name text,
  last_name text,
  title text,
  seniority text,              -- derived from the job title: c_suite, vp, head, director, manager, ic
  department text,
  persona text,                -- which ICP persona the title matches, if any
  relevance int not null default 0,
  linkedin_url text,
  email text,
  email_status text,           -- valid | accept_all | unknown | null
  email_confidence int,
  phone text,
  email_revealed boolean not null default false,
  phone_revealed boolean not null default false,
  enriched_at timestamptz,
  hubspot_contact_id text,
  created_at timestamptz not null default now(),
  unique (account_id, email)
);
create index cp_people_account_idx on cp_people (account_id, relevance desc);
alter table cp_people enable row level security;

-- Credits spent at data providers, so we can enforce a monthly cap and audit usage.
create table cp_provider_usage (
  id bigint generated always as identity primary key,
  provider text not null,
  action text not null,
  credits numeric(8, 2) not null default 0,
  account text,
  created_at timestamptz not null default now()
);
create index cp_provider_usage_idx on cp_provider_usage (provider, created_at desc);
alter table cp_provider_usage enable row level security;
