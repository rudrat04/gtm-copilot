-- After the meeting: when it ended, whether the debrief email went out, what happened, the AI recap,
-- and what was written to HubSpot. Plus the deal we created for an account, so we only ever touch our own.
alter table cp_meetings add column if not exists ends_at timestamptz;
alter table cp_meetings add column if not exists debrief_sent_at timestamptz;
alter table cp_meetings add column if not exists outcome text check (outcome in ('went_well', 'follow_up', 'no_show', 'not_fit'));
alter table cp_meetings add column if not exists debriefed_at timestamptz;
alter table cp_meetings add column if not exists notes text;
alter table cp_meetings add column if not exists recap jsonb;
alter table cp_meetings add column if not exists crm_sync jsonb;
alter table cp_accounts add column if not exists hubspot_deal_id text;

alter table cp_outcomes drop constraint if exists cp_outcomes_kind_check;
alter table cp_outcomes add constraint cp_outcomes_kind_check check (kind in (
  'contacted', 'replied', 'meeting', 'snoozed', 'not_now', 'reopened',
  'debrief_went_well', 'debrief_follow_up', 'debrief_no_show', 'debrief_not_fit'));
