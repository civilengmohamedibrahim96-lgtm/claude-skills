-- =====================================================================
-- RPCs called by the web app (security invoker → RLS applies) and by
-- edge functions (service role).
-- =====================================================================

-- Drag & drop / "Assigned to": move a project to a column and renumber that column.
-- p_order = ids of the target column in their new order (including p_project).
create or replace function public.rpc_move_project(p_project uuid, p_assignee uuid, p_order uuid[])
returns void language plpgsql security invoker set search_path = ''
as $$
declare v_prev uuid; v_name text;
begin
  if not public.is_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  select assignee_id into v_prev from public.projects where id = p_project for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  update public.projects set assignee_id = p_assignee where id = p_project;
  update public.projects p set position = o.ord - 1
    from unnest(coalesce(p_order, '{}'::uuid[])) with ordinality as o(pid, ord)
    where p.id = o.pid and p.assignee_id is not distinct from p_assignee;
  if v_prev is distinct from p_assignee then
    if p_assignee is null then
      insert into public.project_tags (project_id, tag_id) values (p_project, 'un') on conflict do nothing;
      insert into public.comments (project_id, author_id, author_name, body, system)
        values (p_project, public.current_person_id(), 'System', 'Moved back to unassigned', true);
    else
      delete from public.project_tags where project_id = p_project and tag_id = 'un';
      select name into v_name from public.people where id = p_assignee;
      insert into public.comments (project_id, author_id, author_name, body, system)
        values (p_project, public.current_person_id(), 'System', 'Assigned to ' || coalesce(v_name, 'engineer'), true);
    end if;
  end if;
end $$;

-- Change the submission date by hand; records history + system comment. Returns false if unchanged.
create or replace function public.rpc_set_due_date(p_project uuid, p_due date)
returns boolean language plpgsql security invoker set search_path = ''
as $$
declare v_old date;
begin
  if not public.is_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  select due_on into v_old from public.projects where id = p_project for update;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if v_old is not distinct from p_due then return false; end if;
  insert into public.date_changes (project_id, from_date, to_date, changed_by, person_id)
    values (p_project, v_old, p_due, coalesce(public.current_person_name(), 'unknown'), public.current_person_id());
  update public.projects set due_on = p_due where id = p_project;
  insert into public.comments (project_id, author_id, author_name, body, system)
    values (p_project, public.current_person_id(), 'System',
      case when p_due is null then 'Submission date cleared'
           when v_old is null then 'Submission date set to ' || to_char(p_due, 'DD Mon YYYY')
           else 'Submission date changed from ' || to_char(v_old, 'DD Mon YYYY') || ' to ' || to_char(p_due, 'DD Mon YYYY')
      end, true);
  return true;
end $$;

-- Team panel: reorder the planning team (board columns follow this order).
create or replace function public.rpc_reorder_people(p_ids uuid[])
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.people p set board_order = o.ord
    from unnest(p_ids) with ordinality as o(pid, ord) where p.id = o.pid;
end $$;

-- Give / remove a board column. Removing moves the person's projects to Unassigned.
create or replace function public.rpc_set_column(p_person uuid, p_on boolean)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.people set has_column = p_on where id = p_person;
  if not p_on then
    insert into public.project_tags (project_id, tag_id)
      select id, 'un' from public.projects where assignee_id = p_person on conflict do nothing;
    update public.projects set assignee_id = null where assignee_id = p_person;
  end if;
end $$;

-- Remove a person from the team (their projects go to Unassigned).
create or replace function public.rpc_remove_person(p_person uuid)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_person = public.current_person_id() then raise exception 'You cannot remove yourself' using errcode = '42501'; end if;
  insert into public.project_tags (project_id, tag_id)
    select id, 'un' from public.projects where assignee_id = p_person on conflict do nothing;
  update public.projects set assignee_id = null where assignee_id = p_person;
  delete from public.people where id = p_person;
end $$;

-- Mail sync lock: returns a new run id, or null when another run started < 10 minutes ago.
create or replace function public.rpc_start_mail_run(p_trigger text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('rendcon_mail_sync'));
  if exists (select 1 from public.mail_runs
             where finished_at is null and started_at > now() - interval '10 minutes') then
    return null;
  end if;
  insert into public.mail_runs (trigger) values (p_trigger) returning id into v_id;
  return v_id;
end $$;

revoke all on function public.rpc_move_project(uuid, uuid, uuid[]) from public, anon;
revoke all on function public.rpc_set_due_date(uuid, date) from public, anon;
revoke all on function public.rpc_reorder_people(uuid[]) from public, anon;
revoke all on function public.rpc_set_column(uuid, boolean) from public, anon;
revoke all on function public.rpc_remove_person(uuid) from public, anon;
revoke all on function public.rpc_start_mail_run(text) from public, anon, authenticated;
grant execute on function public.rpc_move_project(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.rpc_set_due_date(uuid, date) to authenticated;
grant execute on function public.rpc_reorder_people(uuid[]) to authenticated;
grant execute on function public.rpc_set_column(uuid, boolean) to authenticated;
grant execute on function public.rpc_remove_person(uuid) to authenticated;
grant execute on function public.rpc_start_mail_run(text) to service_role;
