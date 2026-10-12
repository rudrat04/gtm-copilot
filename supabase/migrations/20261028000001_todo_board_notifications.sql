-- To-do board: a person can be pinned to it or dismissed from it. Notification centre: things worth knowing, told once, with read state.
alter table cp_people add column if not exists todo_state text check (todo_state in ('pinned','dismissed'));
alter table cp_people add column if not exists todo_at timestamptz;
create table if not exists cp_notifications (
  id uuid primary key default gen_random_uuid(),
  key text unique,
  kind text not null,
  title text not null,
  body text,
  route text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
alter table cp_notifications enable row level security;
create index if not exists cp_notifications_created_idx on cp_notifications (created_at desc);
