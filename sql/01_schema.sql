-- ============================================================
-- Qooentum · 01_schema.sql
-- Correr primero, en el SQL Editor de Supabase (o vía CLI/migrations).
-- Después: 02_functions.sql → 03_rls.sql → 04_realtime.sql
--
-- Mapeo con el frontend (src/app.js / src/lib/supabase-api.js):
--   places   → placeStore / nearbyPlaces / cercaAllPlaces (mapa y lista "Cerca")
--   profiles → currentUser + userPts (1 fila por usuario autenticado)
--   reports  → cada tap de "reportar estado" (submit_vote), fuente del ranking
--   prizes   → catálogo de canje (buildPrizes)
-- ============================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists postgis;    -- distancias/radio en sync_places

-- ---------------------------------------------------------------
-- places
-- id = 'osm-node-123' / 'osm-way-456' (import-places.js) o generado
-- a mano para comercios sponsor. status/reporters/report_ts los
-- actualiza SOLO submit_vote(); todo lo demás lo actualiza el import.
-- ---------------------------------------------------------------
create table if not exists public.places (
  id          text primary key,
  name        text not null,
  type        text not null,               -- "Restaurante", "Farmacia", etc. (osmToMeta().tipo)
  logo        text default '🏪',           -- emoji (osmToMeta().emoji)
  cat         text not null default 'other', -- food | health | bank | supermarket | government | shopping | other
  addr        text default '',
  lat         double precision not null,
  lng         double precision not null,
  geog        geography(Point, 4326)
              generated always as (
                geography(st_setsrid(st_makepoint(lng, lat), 4326))
              ) stored,                    -- usado por sync_places (radio en metros)

  rating      numeric(2,1) default 3.5,
  reviews_n   integer default 0,
  verified    boolean default false,
  open        boolean default true,
  source      text default 'osm',          -- 'osm' | 'manual' | 'sponsor'

  -- estado en vivo (lo escribe submit_vote, se lee con sync_places)
  status      smallint default 0,          -- 0 Poca gente · 1 Bastante · 2 Mucha · 3 Colapsado
  reporters   integer default 0,           -- reportes acumulados del día en curso
  report_ts   bigint,                      -- epoch ms del último reporte (para expirar a medianoche)

  -- sponsor opcional: { tier, logo_url, badge_color, badge_text, promo, website, photo_url }
  sponsor     jsonb,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists places_geog_idx on public.places using gist (geog);
create index if not exists places_cat_idx  on public.places (cat);

-- ---------------------------------------------------------------
-- profiles
-- 1 fila por usuario de Supabase Auth (auth.uid()). Se crea sola en
-- el primer get_profile()/submit_vote() de cada usuario (ver 02_functions.sql).
-- ---------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  name        text,
  picture     text,
  points      integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- reports
-- Historial de reportes: 1 fila por voto. Es la fuente de verdad
-- para el ranking (get_ranking) y para el cooldown de 24h por
-- usuario+lugar (submit_vote la consulta antes de insertar).
-- ---------------------------------------------------------------
create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  place_id    text not null references public.places(id) on delete cascade,
  status      smallint not null,           -- mismo enum 0-3 que places.status
  points      integer not null,            -- puntos otorgados por este reporte (VOTE_PTS[status])
  created_at  timestamptz not null default now()
);

create index if not exists reports_user_idx  on public.reports (user_id, created_at desc);
create index if not exists reports_place_idx on public.reports (place_id, created_at desc);
-- Cooldown: 1 reporte por usuario+lugar por día natural.
create unique index if not exists reports_user_place_day_idx
  on public.reports (user_id, place_id, (created_at::date));

-- ---------------------------------------------------------------
-- prizes
-- Catálogo de canje (buildPrizes). "active"/"sort_order" los maneja
-- quien administre el catálogo (por ahora, a mano desde el SQL editor
-- o el Table editor de Supabase).
-- ---------------------------------------------------------------
create table if not exists public.prizes (
  id          text primary key,            -- 'p1', 'p2', ... (o slug propio)
  emoji       text not null default '🎁',
  name        text not null,
  pts         integer not null,
  cat         text not null,               -- "Gastronomía", "Entretenimiento", etc.
  partner     text not null,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Seed opcional con el catálogo demo que hoy vive hardcodeado en
-- SEED_PRIZES (app.js) — correr una sola vez si querés arrancar con
-- estos datos ya en la tabla. Si preferís no clonarlos, borrá este bloque.
insert into public.prizes (id, emoji, name, pts, cat, partner, sort_order) values
  ('p1', '☕', 'Café gratis',                200, 'Gastronomía',    'Starbucks',  1),
  ('p2', '🎬', 'Entrada de cine',            400, 'Entretenimiento','Cinemark',   2),
  ('p3', '🛒', 'Descuento 20% Carrefour',    600, 'Supermercado',   'Carrefour',  3),
  ('p4', '🍕', 'Pizza para 2 personas',      800, 'Gastronomía',    'Ugi''s',     4),
  ('p5', '🚌', 'Carga SUBE $2000',          1000, 'Transporte',     'SUBE',       5),
  ('p6', '🎮', 'Streaming 1 mes',           1200, 'Digital',        'Netflix',    6),
  ('p7', '🛍️', 'Gift card $5000',          2500, 'Compras',        'Naranja X',  7),
  ('p8', '✈️', 'Voucher de viaje',          5000, 'Turismo',        'Despegar',   8)
on conflict (id) do nothing;

-- updated_at automático en places y profiles
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists places_set_updated_at on public.places;
create trigger places_set_updated_at
  before update on public.places
  for each row execute function public.set_updated_at();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();
