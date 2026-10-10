-- Inbound speed to lead: a form submit is enriched, scored and routed to the owner within about a minute.
create table if not exists cp_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),          -- when the lead arrived
  name text not null,
  email text not null,
  domain text,                                            -- null for a personal email address
  company text,
  role text,
  message text,
  intent text not null default 'question' check (intent in ('demo', 'pricing', 'question')),
  source text not null default 'website',
  account_id uuid references cp_accounts(id) on delete set null,
  label text check (label in ('hot', 'warm', 'review', 'not_fit')),
  fit text,
  heat text,
  why text,                                               -- one plain-English line for the rep
  facts text,                                             -- "51-250 people · Series A · ..."
  top_signals jsonb not null default '[]'::jsonb,
  hubspot_contact_id text,
  hubspot_task_id text,
  alerted_at timestamptz,
  sla_nudged_at timestamptz,
  first_response_at timestamptz,
  status text not null default 'new' check (status in ('new', 'contacted', 'replied', 'closed')),
  timeline jsonb not null default '[]'::jsonb
);
alter table cp_leads enable row level security;
create index if not exists cp_leads_created_idx on cp_leads (created_at desc);
create index if not exists cp_leads_email_idx on cp_leads (email, created_at desc);
create index if not exists cp_leads_account_idx on cp_leads (account_id);
