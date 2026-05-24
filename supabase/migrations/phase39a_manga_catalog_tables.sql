-- Phase 39a: Zentraler Manga-Katalog vorbereiten
-- Tabellen, Indexe, updated_at-Trigger, RLS, restriktive Grants.
-- Schreiben ausschliesslich ueber service_role / Edge Functions.
-- Private Sammlung (public.collections) bleibt strikt getrennt.

-- =========================================================================
-- 1. SOURCES
-- =========================================================================
create table public.manga_catalog_sources (
  id                    uuid primary key default gen_random_uuid(),
  source_key            text not null unique,
  display_name          text not null,
  provider_id           text,
  trust_level           smallint not null default 0 check (trust_level between 0 and 5),
  allowed_domains       text[] not null default '{}',
  request_policy        jsonb not null default '{}'::jsonb,
  rate_limit_per_minute integer check (rate_limit_per_minute is null or rate_limit_per_minute > 0),
  enabled               boolean not null default true,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table public.manga_catalog_sources is
  'Phase 39: Zentrale Quellenverwaltung (Trust-Level, Allowed Domains, Rate-Limits, Provider-IDs).';

-- =========================================================================
-- 2. SERIES (optionale Serien-Identitaet)
-- =========================================================================
create table public.manga_catalog_series (
  id                   uuid primary key default gen_random_uuid(),
  series_key           text not null unique,
  title                text not null,
  normalized_title     text not null,
  publisher            text,
  normalized_publisher text,
  ongoing              boolean not null default true,
  genres               text[] not null default '{}',
  aliases              text[] not null default '{}',
  external_ids         jsonb not null default '{}'::jsonb,
  cover_url            text,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.manga_catalog_series is
  'Phase 39: Optionale zentrale Serienidentitaet (Aliases, externe IDs, Publisher-Normalisierung).';

create index manga_catalog_series_normalized_idx
  on public.manga_catalog_series (normalized_title);

-- =========================================================================
-- 3. ENTRIES (final freigegebene Release-Daten)
-- =========================================================================
create table public.manga_catalog_entries (
  id                       uuid primary key default gen_random_uuid(),
  series_id                uuid references public.manga_catalog_series(id) on delete set null,
  source_id                uuid references public.manga_catalog_sources(id) on delete set null,
  series_title             text not null,
  normalized_series_title  text not null,
  publisher                text,
  normalized_publisher     text,
  volume_number            integer not null check (volume_number >= 0),
  release_date             date,
  isbn13                   text check (isbn13 is null or isbn13 ~ '^[0-9Xx]{10,13}$'),
  cover_url                text,
  source_url               text,
  source_name              text,
  provider_id              text,
  confidence               smallint not null default 0 check (confidence between 0 and 100),
  verified                 boolean not null default false,
  verified_at              timestamptz,
  verified_by_hash         text,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Veroeffentlichung erst, wenn explizit verifiziert (kein Auto-Live).
  constraint manga_catalog_entries_verified_consistency
    check (
      (verified = false and verified_at is null)
      or (verified = true and verified_at is not null)
    )
);
comment on table public.manga_catalog_entries is
  'Phase 39: Final freigegebene Katalog-Eintraege. Primaere Quelle fuer release-cache.json Snapshots.';

create unique index manga_catalog_entries_identity_idx
  on public.manga_catalog_entries (
    normalized_series_title,
    coalesce(normalized_publisher, ''),
    volume_number
  );

create index manga_catalog_entries_release_date_idx
  on public.manga_catalog_entries (release_date);

create index manga_catalog_entries_verified_idx
  on public.manga_catalog_entries (verified) where verified = true;

create index manga_catalog_entries_series_idx
  on public.manga_catalog_entries (series_id);

-- =========================================================================
-- 4. CANDIDATES (ungeprueft / im Review)
-- =========================================================================
create table public.manga_catalog_candidates (
  id                       uuid primary key default gen_random_uuid(),
  candidate_key            text not null unique,
  source_id                uuid references public.manga_catalog_sources(id) on delete set null,
  origin                   text not null check (origin in (
    'browser','pending-queue','coverage-gap','watchlist','provider','manual','intake'
  )),
  series_title             text not null,
  normalized_series_title  text not null,
  publisher                text,
  normalized_publisher     text,
  volume_number            integer check (volume_number is null or volume_number >= 0),
  release_date             date,
  isbn13                   text check (isbn13 is null or isbn13 ~ '^[0-9Xx]{10,13}$'),
  cover_url                text,
  source_url               text,
  source_name              text,
  provider_id              text,
  confidence               smallint not null default 0 check (confidence between 0 and 100),
  status                   text not null default 'pending'
    check (status in ('pending','reviewing','verified','rejected','blocked','duplicate')),
  blocked_reason           text,
  duplicate_of             uuid references public.manga_catalog_entries(id) on delete set null,
  promoted_entry_id        uuid references public.manga_catalog_entries(id) on delete set null,
  submitted_by_hash        text,
  metadata                 jsonb not null default '{}'::jsonb,
  first_seen_at            timestamptz not null default now(),
  last_seen_at             timestamptz not null default now(),
  seen_count               integer not null default 1 check (seen_count >= 1),
  reviewed_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
comment on table public.manga_catalog_candidates is
  'Phase 39: Katalog-Kandidaten aus Intake/Coverage/Watchlist/Provider. KEIN public read.';

create index manga_catalog_candidates_status_idx
  on public.manga_catalog_candidates (status);

create index manga_catalog_candidates_origin_idx
  on public.manga_catalog_candidates (origin);

-- =========================================================================
-- 5. AUDIT-LOG (append-only)
-- =========================================================================
create table public.manga_catalog_audit_log (
  id            bigserial primary key,
  occurred_at   timestamptz not null default now(),
  actor_role    text not null check (actor_role in (
    'system','reviewer','intake','ci','snapshot','service'
  )),
  actor_hash    text,
  action        text not null,
  entity_table  text not null check (entity_table in (
    'manga_catalog_entries','manga_catalog_candidates',
    'manga_catalog_series','manga_catalog_sources'
  )),
  entity_id     uuid,
  reason        text,
  diff          jsonb not null default '{}'::jsonb
);
comment on table public.manga_catalog_audit_log is
  'Phase 39: Append-only Audit-Log aller Katalog-Aenderungen. KEIN public read, kein UPDATE/DELETE durch app roles.';

create index manga_catalog_audit_entity_idx
  on public.manga_catalog_audit_log (entity_table, entity_id);

create index manga_catalog_audit_time_idx
  on public.manga_catalog_audit_log (occurred_at desc);

-- =========================================================================
-- updated_at trigger
-- =========================================================================
create or replace function public.tg_manga_catalog_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
comment on function public.tg_manga_catalog_set_updated_at() is
  'Phase 39: setzt updated_at auf now() bei UPDATE der manga_catalog_* Tabellen.';

create trigger trg_manga_catalog_sources_updated_at
  before update on public.manga_catalog_sources
  for each row execute function public.tg_manga_catalog_set_updated_at();

create trigger trg_manga_catalog_series_updated_at
  before update on public.manga_catalog_series
  for each row execute function public.tg_manga_catalog_set_updated_at();

create trigger trg_manga_catalog_entries_updated_at
  before update on public.manga_catalog_entries
  for each row execute function public.tg_manga_catalog_set_updated_at();

create trigger trg_manga_catalog_candidates_updated_at
  before update on public.manga_catalog_candidates
  for each row execute function public.tg_manga_catalog_set_updated_at();

-- =========================================================================
-- RLS aktivieren (default-deny fuer anon/authenticated)
-- =========================================================================
alter table public.manga_catalog_sources    enable row level security;
alter table public.manga_catalog_series     enable row level security;
alter table public.manga_catalog_entries    enable row level security;
alter table public.manga_catalog_candidates enable row level security;
alter table public.manga_catalog_audit_log  enable row level security;

-- Public-Read NUR auf verifizierte Entries.
-- Keine INSERT/UPDATE/DELETE-Policies -> schreiben nur ueber service_role.
create policy "catalog_entries_public_read_verified"
  on public.manga_catalog_entries
  for select
  to anon, authenticated
  using (verified = true);

-- =========================================================================
-- Grants minimieren (service_role bleibt full access ueber Supabase default)
-- =========================================================================
revoke all on public.manga_catalog_sources    from anon, authenticated;
revoke all on public.manga_catalog_series     from anon, authenticated;
revoke all on public.manga_catalog_entries    from anon, authenticated;
revoke all on public.manga_catalog_candidates from anon, authenticated;
revoke all on public.manga_catalog_audit_log  from anon, authenticated;

grant select on public.manga_catalog_entries to anon, authenticated;

-- =========================================================================
-- Seed: bekannte Quellen aus Phase-39-Note
-- =========================================================================
insert into public.manga_catalog_sources
  (source_key, display_name, trust_level, allowed_domains, enabled, notes)
values
  ('manga-passion', 'Manga Passion', 4, array['manga-passion.de','www.manga-passion.de'], true,
   'Phase 39 Seed: hohe Vertrauensstufe, primaere Release-Quelle DE.'),
  ('carlsen',       'Carlsen Manga', 4, array['carlsen.de','www.carlsen.de'], true,
   'Phase 39 Seed: Verlags-Direktquelle.'),
  ('manga-cult',    'Manga Cult',    4, array['manga-cult.de','www.manga-cult.de'], true,
   'Phase 39 Seed: Verlags-Direktquelle.'),
  ('egmont',        'Egmont Manga',  4, array['egmont-manga.de','www.egmont-manga.de'], true,
   'Phase 39 Seed: Verlags-Direktquelle.'),
  ('anilist',       'AniList',       2, array['anilist.co','graphql.anilist.co'], true,
   'Phase 39 Seed: Sekundaere Quelle, niedrigeres Vertrauen fuer DE-Release-Daten.')
on conflict (source_key) do nothing;
