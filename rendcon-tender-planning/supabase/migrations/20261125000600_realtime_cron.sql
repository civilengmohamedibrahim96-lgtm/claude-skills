-- @supabase-only begin
-- Live updates between users (Supabase Realtime, postgres_changes; RLS applies)
alter publication supabase_realtime add table
  public.projects, public.project_tags, public.subtasks, public.links, public.comments,
  public.date_changes, public.mail_events, public.reminders, public.people, public.tender_team,
  public.tags, public.review_queue, public.processed_messages, public.mail_runs, public.settings,
  public.reminder_deliveries;

-- Scheduler. The function URL and the shared secret are read from Supabase Vault at run time
-- (vault secrets 'rendcon_functions_url' and 'rendcon_cron_secret' are created at go-live).
select cron.schedule('rendcon-mail-sync', '7 * * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'rendcon_functions_url') || '/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'rendcon_cron_secret')),
    body := '{"source": "cron"}'::jsonb,
    timeout_milliseconds := 150000);
$cron$);

select cron.schedule('rendcon-reminders', '*/5 * * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'rendcon_functions_url') || '/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'rendcon_cron_secret')),
    body := '{"mode": "due"}'::jsonb,
    timeout_milliseconds := 60000);
$cron$);
-- @supabase-only end
