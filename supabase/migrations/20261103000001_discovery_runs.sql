-- One row per discovery run, so each run can be opened later: what it added and what it skipped.
create table if not exists cp_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  trigger text not null default 'manual',          -- manual, weekly or profile change
  summary jsonb not null default '{}'::jsonb        -- counts: collected, checked, added, skipped, people listed, judged
);
alter table cp_discovery_runs enable row level security;
alter table cp_discovered add column if not exists run_id uuid references cp_discovery_runs(id) on delete set null;
create index if not exists cp_discovered_run_idx on cp_discovered (run_id);

-- Earlier runs: one run per day, from what was recorded.
with days as (
  select date_trunc('day', found_at) d, count(*) filter (where status = 'added') added, count(*) filter (where status = 'rejected') skipped
  from cp_discovered group by 1
), ins as (
  insert into cp_discovery_runs (started_at, trigger, summary)
  select d + interval '12 hours', 'earlier', jsonb_build_object('added', added, 'skipped_n', skipped, 'checked', added + skipped) from days returning id, started_at
)
update cp_discovered x set run_id = ins.id from ins where date_trunc('day', x.found_at) + interval '12 hours' = ins.started_at;
