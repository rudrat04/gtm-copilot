-- Where an inbound lead came from, so the rep gets context with the alert.
alter table cp_leads add column if not exists utm_source text;
alter table cp_leads add column if not exists utm_medium text;
alter table cp_leads add column if not exists utm_campaign text;
alter table cp_leads add column if not exists referrer_host text;
alter table cp_leads add column if not exists landing_path text;
