-- =====================================================================
-- Open sign-up: anyone may create an account. Someone not on the team is
-- recorded in access_requests and sees nothing (RLS still needs is_member())
-- until an admin approves them, which adds them to people.
-- =====================================================================
create table public.access_requests (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  created_at  timestamptz not null default now()
);
create unique index access_requests_email_key on public.access_requests (lower(email));

alter table public.access_requests enable row level security;
revoke all on public.access_requests from anon;
create policy access_requests_select on public.access_requests for select to authenticated using (public.is_admin());
create policy access_requests_delete on public.access_requests for delete to authenticated using (public.is_admin());

-- Once someone is on the team (approved, or added by an admin), their request is done.
create or replace function public.people_clear_request() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is not null then
    delete from public.access_requests where lower(email) = lower(new.email);
  end if;
  return new;
end $$;
revoke all on function public.people_clear_request() from public, anon, authenticated;
create trigger people_clear_request after insert or update of email on public.people
  for each row execute function public.people_clear_request();

-- Auth hook "Before User Created": every email may sign up; outsiders are queued for an admin.
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_email text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if v_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     and not exists (select 1 from public.people p where p.active and lower(p.email) = v_email) then
    insert into public.access_requests (email) values (v_email) on conflict do nothing;
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
