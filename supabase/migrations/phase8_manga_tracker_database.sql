-- Phase 8: Optional Supabase cloud sync for the static Manga Tracker app.
-- The app keeps localStorage as the offline-first source and stores one JSONB
-- database document per authenticated Supabase user.

create table if not exists public.manga_tracker_databases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  schema_version integer not null,
  database jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint manga_tracker_databases_user_id_key unique (user_id),
  constraint manga_tracker_databases_database_shape_check check (
    jsonb_typeof(database) = 'object'
    and jsonb_typeof(database -> 'series') = 'array'
    and jsonb_typeof(database -> 'volumes') = 'array'
  )
);

comment on table public.manga_tracker_databases is
  'One offline-first Manga Tracker database JSON document per authenticated Supabase user.';
comment on column public.manga_tracker_databases.user_id is
  'Owner. RLS restricts every row to auth.uid().';
comment on column public.manga_tracker_databases.database is
  'Complete Manga Tracker database payload with at least series and volumes arrays.';

create or replace function public.set_manga_tracker_databases_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_manga_tracker_databases_updated_at
  on public.manga_tracker_databases;

create trigger set_manga_tracker_databases_updated_at
before update on public.manga_tracker_databases
for each row
execute function public.set_manga_tracker_databases_updated_at();

alter table public.manga_tracker_databases enable row level security;

drop policy if exists "Users can read their own Manga Tracker database"
  on public.manga_tracker_databases;
create policy "Users can read their own Manga Tracker database"
on public.manga_tracker_databases
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert their own Manga Tracker database"
  on public.manga_tracker_databases;
create policy "Users can insert their own Manga Tracker database"
on public.manga_tracker_databases
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update their own Manga Tracker database"
  on public.manga_tracker_databases;
create policy "Users can update their own Manga Tracker database"
on public.manga_tracker_databases
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own Manga Tracker database"
  on public.manga_tracker_databases;
create policy "Users can delete their own Manga Tracker database"
on public.manga_tracker_databases
for delete
to authenticated
using (auth.uid() = user_id);

-- Make Data API exposure explicit. RLS policies above still decide row access.
-- Revoke first because some Supabase projects still auto-grant broad defaults
-- for tables created in the public schema.
revoke all on table public.manga_tracker_databases from anon;
revoke all on table public.manga_tracker_databases from authenticated;
grant select, insert, update, delete on table public.manga_tracker_databases to authenticated;
grant select, insert, update, delete on table public.manga_tracker_databases to service_role;

-- The trigger function is not used by clients directly.
revoke all on function public.set_manga_tracker_databases_updated_at() from public;
revoke all on function public.set_manga_tracker_databases_updated_at() from anon;
revoke all on function public.set_manga_tracker_databases_updated_at() from authenticated;
grant execute on function public.set_manga_tracker_databases_updated_at() to service_role;
