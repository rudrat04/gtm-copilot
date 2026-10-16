-- Permanently deletes companies and everything stored about them. The domain is kept in cp_discovered (hidden) so discovery and imports never bring it back.
create or replace function cp_purge_accounts(ids uuid[]) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into cp_discovered (domain, name, status, reason, source, hidden_at, found_at)
    select a.domain, a.name, 'rejected', 'Removed by you', 'removed', now(), now() from cp_accounts a where a.id = any(ids)
    on conflict (domain) do update set status = 'rejected', reason = 'Removed by you', hidden_at = now(), account_id = null;
  delete from cp_person_notes where person_id in (select id from cp_people where account_id = any(ids));
  delete from cp_watch_events where account_id = any(ids) or person_id in (select id from cp_people where account_id = any(ids));
  delete from cp_ai_scores where ref_id = any(ids) or ref_id in (select id from cp_people where account_id = any(ids));
  delete from cp_alerts where account_id = any(ids);
  update cp_discovered set account_id = null where account_id = any(ids);
  delete from cp_dossiers where account_id = any(ids);
  delete from cp_flags where account_id = any(ids);
  delete from cp_leads where account_id = any(ids);
  delete from cp_meetings where account_id = any(ids);
  delete from cp_outcomes where account_id = any(ids);
  delete from cp_outreach_drafts where account_id = any(ids);
  delete from cp_signals where account_id = any(ids);
  delete from cp_tasks where account_id = any(ids);
  delete from cp_why_today where account_id = any(ids);
  delete from cp_people where account_id = any(ids);
  delete from cp_accounts where id = any(ids);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function cp_purge_accounts(uuid[]) from public, anon, authenticated;
