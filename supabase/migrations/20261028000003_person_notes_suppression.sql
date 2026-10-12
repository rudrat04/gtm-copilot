-- Notes and a short history on each person; a buyer type the owner set by hand; and a suppression list (people who are never listed, revealed or added again).
create table if not exists cp_person_notes (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references cp_people(id) on delete cascade,
  kind text not null default 'note',
  text text not null,
  created_at timestamptz not null default now()
);
alter table cp_person_notes enable row level security;
create index if not exists cp_person_notes_idx on cp_person_notes (person_id, created_at desc);
alter table cp_people add column if not exists persona_manual boolean not null default false;
create table if not exists cp_suppressed (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text,
  reason text,
  created_at timestamptz not null default now()
);
alter table cp_suppressed enable row level security;
