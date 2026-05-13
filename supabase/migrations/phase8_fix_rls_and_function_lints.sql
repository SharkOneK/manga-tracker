-- Phase 8 hardening: resolve Supabase advisor warnings for the Manga Tracker
-- JSONB sync table.

create or replace function public.set_manga_tracker_databases_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at is distinct from old.updated_at then
    return new;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop policy if exists "Users can read their own Manga Tracker database"
  on public.manga_tracker_databases;
create policy "Users can read their own Manga Tracker database"
on public.manga_tracker_databases
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own Manga Tracker database"
  on public.manga_tracker_databases;
create policy "Users can insert their own Manga Tracker database"
on public.manga_tracker_databases
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own Manga Tracker database"
  on public.manga_tracker_databases;
create policy "Users can update their own Manga Tracker database"
on public.manga_tracker_databases
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own Manga Tracker database"
  on public.manga_tracker_databases;
create policy "Users can delete their own Manga Tracker database"
on public.manga_tracker_databases
for delete
to authenticated
using ((select auth.uid()) = user_id);
