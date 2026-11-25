-- =====================================================================
-- Row level security: only signed-in users whose email is in `people`.
-- Admin-only writes for people, tender_team, settings.
-- Edge functions use the service role (bypasses RLS).
-- =====================================================================
alter table public.people              enable row level security;
alter table public.tender_team         enable row level security;
alter table public.tags                enable row level security;
alter table public.projects            enable row level security;
alter table public.project_tags        enable row level security;
alter table public.subtasks            enable row level security;
alter table public.mail_events         enable row level security;
alter table public.links               enable row level security;
alter table public.comments            enable row level security;
alter table public.date_changes        enable row level security;
alter table public.project_seen        enable row level security;
alter table public.review_queue        enable row level security;
alter table public.processed_messages  enable row level security;
alter table public.match_examples      enable row level security;
alter table public.mail_runs           enable row level security;
alter table public.reminders           enable row level security;
alter table public.reminder_deliveries enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.settings            enable row level security;

-- the anonymous role gets nothing at all
revoke all on all tables in schema public from anon;

-- people: members read; admin writes; a person may update their own row (guarded by trigger)
create policy people_select on public.people for select to authenticated using (public.is_member());
create policy people_insert on public.people for insert to authenticated with check (public.is_admin());
create policy people_update on public.people for update to authenticated
  using (public.is_admin() or id = public.current_person_id())
  with check (public.is_admin() or id = public.current_person_id());
create policy people_delete on public.people for delete to authenticated using (public.is_admin());

-- tender_team: members read; admin writes
create policy tender_team_select on public.tender_team for select to authenticated using (public.is_member());
create policy tender_team_insert on public.tender_team for insert to authenticated with check (public.is_admin());
create policy tender_team_update on public.tender_team for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy tender_team_delete on public.tender_team for delete to authenticated using (public.is_admin());

-- settings: members read; admin writes
create policy settings_select on public.settings for select to authenticated using (public.is_member());
create policy settings_insert on public.settings for insert to authenticated with check (public.is_admin());
create policy settings_update on public.settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy settings_delete on public.settings for delete to authenticated using (public.is_admin());

-- shared board data: every member reads and writes
create policy tags_all         on public.tags         for all to authenticated using (public.is_member()) with check (public.is_member());
create policy projects_all     on public.projects     for all to authenticated using (public.is_member()) with check (public.is_member());
create policy project_tags_all on public.project_tags for all to authenticated using (public.is_member()) with check (public.is_member());
create policy subtasks_all     on public.subtasks     for all to authenticated using (public.is_member()) with check (public.is_member());
create policy links_all        on public.links        for all to authenticated using (public.is_member()) with check (public.is_member());
create policy comments_all     on public.comments     for all to authenticated using (public.is_member()) with check (public.is_member());
create policy date_changes_all on public.date_changes for all to authenticated using (public.is_member()) with check (public.is_member());
create policy reminders_all    on public.reminders    for all to authenticated using (public.is_member()) with check (public.is_member());

-- own rows only
create policy project_seen_own on public.project_seen for all to authenticated
  using (public.is_member() and person_id = public.current_person_id())
  with check (public.is_member() and person_id = public.current_person_id());
create policy push_subscriptions_own on public.push_subscriptions for all to authenticated
  using (public.is_member() and person_id = public.current_person_id())
  with check (public.is_member() and person_id = public.current_person_id());

-- written only by edge functions (service role); members read
create policy mail_events_select         on public.mail_events         for select to authenticated using (public.is_member());
create policy review_queue_select        on public.review_queue        for select to authenticated using (public.is_member());
create policy processed_messages_select  on public.processed_messages  for select to authenticated using (public.is_member());
create policy match_examples_select      on public.match_examples      for select to authenticated using (public.is_member());
create policy mail_runs_select           on public.mail_runs           for select to authenticated using (public.is_member());
create policy reminder_deliveries_select on public.reminder_deliveries for select to authenticated using (public.is_member());

-- Auth hook "Before User Created": only emails on the team may create an account.
-- Enable it in Dashboard → Authentication → Hooks (go-live step).
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_email text := lower(coalesce(event -> 'user' ->> 'email', ''));
begin
  if v_email <> '' and exists (select 1 from public.people p where p.active and lower(p.email) = v_email) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This email is not on the Redcon planning team. Ask your admin to add you.'));
end $$;
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
