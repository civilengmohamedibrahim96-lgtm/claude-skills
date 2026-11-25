-- Extensions used by Redcon Tender Planning.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
-- @supabase-only begin
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
-- @supabase-only end
