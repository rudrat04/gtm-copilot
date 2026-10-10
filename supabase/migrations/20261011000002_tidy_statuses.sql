-- Outreach progress now lives in outreach_status. cp_accounts.status only tracks the pipeline stage.
alter table cp_accounts drop constraint if exists cp_accounts_status_check;
alter table cp_accounts add constraint cp_accounts_status_check check (status in ('new', 'queued', 'pushed'));
