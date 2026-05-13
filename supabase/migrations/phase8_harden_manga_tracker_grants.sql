-- Corrective hardening for projects whose public schema defaults grant broad
-- table privileges to browser roles.

revoke all on table public.manga_tracker_databases from anon;
revoke all on table public.manga_tracker_databases from authenticated;
grant select, insert, update, delete on table public.manga_tracker_databases to authenticated;
