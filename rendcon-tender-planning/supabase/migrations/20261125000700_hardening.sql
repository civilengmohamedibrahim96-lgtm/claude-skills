-- Hardening: colours are injected into style attributes in the UI, so only 6-digit hex is allowed.
alter table public.people add constraint people_color_hex check (color ~ '^#[0-9A-Fa-f]{6}$');
alter table public.tags add constraint tags_color_hex check (color ~ '^#[0-9A-Fa-f]{6}$');

-- The sign-up hook (hook_before_user_created) runs as supabase_auth_admin and needs to see the schema.
grant usage on schema public to supabase_auth_admin;
