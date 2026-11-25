-- =====================================================================
-- Redcon Tender Planning – tables, helper functions, triggers
-- =====================================================================

-- Arabic/English normalisation. MUST match normalizeArabic() in
-- functions/_shared/arabic.ts (same steps, same order).
create or replace function public.ar_norm(t text) returns text
language sql immutable parallel safe
as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        translate(lower(coalesce(t, '')),
          'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹²³',
          'اااايهوي0123456789012345678923'),
        '[ً-ٰٟـ]', '', 'g'),
      '[^0-9a-zء-ي[:space:]]', ' ', 'g'),
    '[[:space:]]+', ' ', 'g'))
$$;

-- ---------- people: the planning team (allow-list for sign-in) ----------
create table public.people (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) > 0),
  email        text,
  role         text not null default 'engineer' check (role in ('admin', 'engineer')),
  color        text not null default '#111111',
  board_order  integer not null default 0,
  has_column   boolean not null default true,
  active       boolean not null default true,
  prefs        jsonb not null default '{"push": true, "email": true}'::jsonb,
  created_at   timestamptz not null default now(),
  constraint people_email_format check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);
create unique index people_email_key on public.people (lower(email)) where email is not null;
create index people_order_idx on public.people (board_order);

-- ---------- identity helpers (used by RLS and triggers) ----------
create or replace function public.current_email() returns text
language sql stable set search_path = ''
as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.current_email() <> '' and exists (
    select 1 from public.people p
    where p.active and p.email is not null and lower(p.email) = public.current_email())
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.current_email() <> '' and exists (
    select 1 from public.people p
    where p.active and p.role = 'admin' and p.email is not null and lower(p.email) = public.current_email())
$$;

create or replace function public.current_person_id() returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.id from public.people p
  where p.active and p.email is not null and lower(p.email) = public.current_email()
  limit 1
$$;

create or replace function public.current_person_name() returns text
language sql stable security definer set search_path = ''
as $$
  select p.name from public.people p
  where p.active and p.email is not null and lower(p.email) = public.current_email()
  limit 1
$$;

revoke all on function public.current_email() from public;
revoke all on function public.is_member() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.current_person_id() from public;
revoke all on function public.current_person_name() from public;
grant execute on function public.current_email() to authenticated, service_role;
grant execute on function public.is_member() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.current_person_id() to authenticated, service_role;
grant execute on function public.current_person_name() to authenticated, service_role;

-- ---------- tender team (study supervisors; Arabic names used to read emails) ----------
create table public.tender_team (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(btrim(name)) > 0),
  name_ar     text not null default '',
  type        text not null default 'public' check (type in ('public', 'private')),
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------- tags ----------
create table public.tags (
  id          text primary key default gen_random_uuid()::text,
  name        text not null check (length(btrim(name)) > 0),
  color       text not null default '#5B5B57',
  sort        integer not null default 100,
  system      boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------- projects ----------
create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(btrim(title)) > 0),
  client       text not null default '',
  ref          text not null default '',
  tender_type  text not null default 'public' check (tender_type in ('public', 'private')),
  tender_id    uuid references public.tender_team (id) on delete set null,
  supervisor   text,
  assignee_id  uuid references public.people (id) on delete set null,
  position     integer,
  status       text not null default '',
  received_on  date default current_date,
  due_on       date,
  folder_url   text not null default '' check (folder_url = '' or folder_url ~* '^https?://'),
  source       text not null default 'manual' check (source in ('manual', 'email')),
  sub_open     boolean not null default true,
  archived     boolean not null default false,
  updated_at   timestamptz not null default now(),
  updated_by   text not null default '',
  created_at   timestamptz not null default now(),
  search_norm  text generated always as (public.ar_norm(title || ' ' || client || ' ' || coalesce(supervisor, ''))) stored
);
create index projects_assignee_idx on public.projects (assignee_id, position);
create index projects_due_idx on public.projects (due_on) where not archived;
create index projects_search_trgm on public.projects using gin (search_norm extensions.gin_trgm_ops);

create table public.project_tags (
  project_id  uuid not null references public.projects (id) on delete cascade,
  tag_id      text not null references public.tags (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (project_id, tag_id)
);

create table public.subtasks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  text        text not null default '',
  done        boolean not null default false,
  note        text not null default '',
  due_on      date,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);
create index subtasks_project_idx on public.subtasks (project_id, position);

-- one row per email that changed a project = the card's update log
create table public.mail_events (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  message_id       text not null unique,
  folder           text not null check (folder in ('inbox', 'sent')),
  direction        text not null check (direction in ('received', 'sent')),
  kind             text not null check (kind in ('new_project', 'update', 'postponed', 'queries_answers',
                     'queries_sent', 'offer_submitted', 'extension_requested', 'reply_or_follow_up')),
  summary          text not null default '',
  subject          text not null default '',
  from_address     text,
  received_at      timestamptz not null,
  web_link         text,
  conversation_id  text,
  links_count      integer not null default 0,
  ai_form          jsonb,
  match_reason     text,
  confidence       jsonb,
  created_at       timestamptz not null default now()
);
create index mail_events_project_idx on public.mail_events (project_id, created_at desc);
create index mail_events_conversation_idx on public.mail_events (conversation_id) where conversation_id is not null;

create table public.links (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  title          text not null default '',
  url            text not null check (url ~* '^https?://'),
  source         text not null default 'manual' check (source in ('manual', 'email')),
  mail_event_id  uuid references public.mail_events (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (project_id, url)
);

create table public.comments (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  author_id    uuid references public.people (id) on delete set null,
  author_name  text not null,
  body         text not null check (length(btrim(body)) > 0),
  system       boolean not null default false,
  created_at   timestamptz not null default now()
);
create index comments_project_idx on public.comments (project_id, created_at desc);

create table public.date_changes (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  from_date      date,
  to_date        date,
  changed_by     text not null,            -- 'email' or the person's name
  person_id      uuid references public.people (id) on delete set null,
  mail_event_id  uuid references public.mail_events (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index date_changes_project_idx on public.date_changes (project_id, created_at desc);

-- per-person "seen" time of a card's email log (unread count)
create table public.project_seen (
  person_id   uuid not null references public.people (id) on delete cascade,
  project_id  uuid not null references public.projects (id) on delete cascade,
  seen_at     timestamptz not null default now(),
  primary key (person_id, project_id)
);

-- ---------- email pipeline ----------
create table public.review_queue (
  id           uuid primary key default gen_random_uuid(),
  message_id   text not null unique,
  folder       text not null check (folder in ('inbox', 'sent')),
  message      jsonb not null,                 -- StoredMessage (types.ts)
  ai_form      jsonb,                          -- AiForm or null
  validated    jsonb,                          -- ValidatedForm or null
  candidates   jsonb not null default '[]'::jsonb,  -- ReviewCandidate[]
  reasons      text[] not null default '{}',
  status       text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_by  text,
  resolved_at  timestamptz,
  resolution   jsonb,
  created_at   timestamptz not null default now()
);
create index review_queue_open_idx on public.review_queue (created_at desc) where status = 'open';

create table public.processed_messages (
  message_id        text primary key,
  folder            text not null check (folder in ('inbox', 'sent')),
  subject           text not null default '',
  from_address      text,
  received_at       timestamptz,
  outcome           text not null check (outcome in ('prefiltered', 'ignored', 'applied', 'review', 'error')),
  attempts          integer not null default 0,
  last_error        text,
  prefilter_reason  text,
  project_id        uuid references public.projects (id) on delete set null,
  mail_event_id     uuid references public.mail_events (id) on delete set null,
  review_id         uuid references public.review_queue (id) on delete set null,
  processed_at      timestamptz not null default now()
);
create index processed_messages_recent_idx on public.processed_messages (processed_at desc);

create table public.match_examples (
  id             uuid primary key default gen_random_uuid(),
  review_id      uuid references public.review_queue (id) on delete set null,
  subject        text not null default '',
  excerpt        text not null default '',
  chosen         text not null check (chosen in ('existing', 'new')),
  chosen_title   text,
  ai_suggestion  text,
  created_by     text not null default '',
  created_at     timestamptz not null default now()
);
create index match_examples_recent_idx on public.match_examples (created_at desc);

create table public.mail_runs (
  id           uuid primary key default gen_random_uuid(),
  trigger      text not null check (trigger in ('cron', 'manual')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  summary      jsonb,
  error        text
);
create index mail_runs_started_idx on public.mail_runs (started_at desc);

-- ---------- reminders ----------
create table public.reminders (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects (id) on delete cascade,   -- null = general reminder
  message     text not null check (length(btrim(message)) > 0),
  at          timestamptz not null,
  repeat      text not null default 'none' check (repeat in ('none', 'hourly', 'daily', 'weekly')),
  recipients  text[] not null default '{all}',   -- 'all' | 'assignee' | people.id as text
  email       boolean not null default true,
  fired       boolean not null default false,
  created_by  uuid references public.people (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index reminders_due_idx on public.reminders (at) where not fired;

create table public.reminder_deliveries (
  id               uuid primary key default gen_random_uuid(),
  reminder_id      uuid references public.reminders (id) on delete set null,
  project_id       uuid references public.projects (id) on delete set null,
  auto_kind        text check (auto_kind in ('due3', 'due1')),
  due_on           date,
  message          text not null,
  recipient_names  text[] not null default '{}',
  push_count       integer not null default 0,
  email_count      integer not null default 0,
  sent_at          timestamptz not null default now()
);
create unique index reminder_deliveries_auto_key on public.reminder_deliveries (project_id, auto_kind, due_on) where auto_kind is not null;
create index reminder_deliveries_recent_idx on public.reminder_deliveries (sent_at desc);

create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.people (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text not null default '',
  created_at  timestamptz not null default now()
);

-- ---------- settings (key/value) ----------
create table public.settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text not null default ''
);

-- ---------- triggers ----------
-- projects: default position (top of its column), updated_at / updated_by
create or replace function public.projects_before_write() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.position is null)
     or (tg_op = 'UPDATE' and new.assignee_id is distinct from old.assignee_id
         and new.position is not distinct from old.position) then
    select coalesce(min(p.position), 0) - 1 into new.position
    from public.projects p
    where p.assignee_id is not distinct from new.assignee_id and p.id <> new.id;
    if new.position is null then new.position := 0; end if;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(public.current_person_name(), nullif(new.updated_by, ''), 'email');
  return new;
end $$;
create trigger projects_before_write before insert or update on public.projects
  for each row execute function public.projects_before_write();

-- child rows touch their project (so "Updated 2m ago" is right)
create or replace function public.touch_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_pid uuid;
begin
  v_pid := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  if v_pid is not null then
    update public.projects set updated_at = now() where id = v_pid;
  end if;
  return null;
end $$;
create trigger subtasks_touch after insert or update or delete on public.subtasks
  for each row execute function public.touch_project();
create trigger links_touch after insert or update or delete on public.links
  for each row execute function public.touch_project();
create trigger comments_touch after insert on public.comments
  for each row execute function public.touch_project();
create trigger project_tags_touch after insert or delete on public.project_tags
  for each row execute function public.touch_project();

-- non-admins may edit their own name, colour and notification prefs only
create or replace function public.people_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if public.current_email() <> '' and not public.is_admin() then
    if new.email is distinct from old.email or new.role is distinct from old.role
       or new.board_order is distinct from old.board_order or new.has_column is distinct from old.has_column
       or new.active is distinct from old.active then
      raise exception 'Only an admin can change email, access, board order or columns' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger people_guard before update on public.people
  for each row execute function public.people_guard();

-- changing a tender engineer's public/private type updates their projects
create or replace function public.tender_team_type_sync() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.projects set tender_type = new.type where tender_id = new.id;
  return null;
end $$;
create trigger tender_team_type_sync after update of type on public.tender_team
  for each row when (old.type is distinct from new.type) execute function public.tender_team_type_sync();
