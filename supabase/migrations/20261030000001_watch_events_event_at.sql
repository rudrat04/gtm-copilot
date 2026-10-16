-- The day an event happened (not the day we found it), so old news is not shown as new.
alter table cp_watch_events add column if not exists event_at timestamptz;
create index if not exists cp_watch_events_event_idx on cp_watch_events (event_at desc nulls last);
