-- Let browser sync writes preserve the Manga Tracker database.updatedAt value in
-- updated_at. If updated_at is omitted, the trigger still behaves like a normal
-- automatic timestamp.

create or replace function public.set_manga_tracker_databases_updated_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at is distinct from old.updated_at then
    return new;
  end if;

  new.updated_at = now();
  return new;
end;
$$;
