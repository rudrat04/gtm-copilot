-- AI judgement of how hot a company or a person is (cached by what it was judged on), the tools seen on a company's website
-- (to spot changes), and an industry read from the website.
create table if not exists cp_ai_scores (
  kind text not null check (kind in ('company','person')),
  ref_id uuid not null,
  hash text not null,
  label text not null check (label in ('hot','warm','cold')),
  score int not null,
  reasons jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (kind, ref_id)
);
alter table cp_ai_scores enable row level security;
alter table cp_accounts add column if not exists site_tools text[];
alter table cp_accounts add column if not exists site_tools_at timestamptz;
alter table cp_accounts add column if not exists industry_ai text;
alter table cp_accounts add column if not exists industry_ai_at timestamptz;
