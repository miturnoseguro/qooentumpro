-- ============================================================
-- Qooentum · 03_rls.sql
-- Correr después de 01_schema.sql y 02_functions.sql.
--
-- Filosofía: las escrituras "de negocio" (votar, sumar puntos, crear
-- profile) pasan SIEMPRE por las funciones SECURITY DEFINER de
-- 02_functions.sql, que ya validan auth.uid()/email. Por eso las
-- policies de las tablas son deliberadamente restrictivas: solo
-- lectura pública donde corresponde, y ninguna escritura directa
-- desde anon/authenticated. El import script usa la service_role
-- key, que ignora RLS por completo, así que no necesita policy.
-- ============================================================

alter table public.places   enable row level security;
alter table public.profiles enable row level security;
alter table public.reports  enable row level security;
alter table public.prizes   enable row level security;

-- ---- places: lectura pública (el mapa se muestra sin login) ----
drop policy if exists places_select_all on public.places;
create policy places_select_all
  on public.places for select
  to anon, authenticated
  using (true);
-- Sin policies de insert/update/delete para anon/authenticated:
-- solo entran por submit_vote() (SECURITY DEFINER) o por el import
-- script (service_role).

-- ---- profiles: cada usuario ve/edita solo su propia fila ----
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);
-- No hay policy de insert/update directa: se hace vía get_profile()
-- y submit_vote() (SECURITY DEFINER). get_ranking() también es
-- SECURITY DEFINER, así que puede leer todas las filas para armar
-- el leaderboard aunque acá esté restringido a "own row".

-- ---- reports: cada usuario ve su propio historial ----
drop policy if exists reports_select_own on public.reports;
create policy reports_select_own
  on public.reports for select
  to authenticated
  using (auth.uid() = user_id);
-- Insert solo vía submit_vote() (SECURITY DEFINER).

-- ---- prizes: catálogo público, solo activos ----
drop policy if exists prizes_select_active on public.prizes;
create policy prizes_select_active
  on public.prizes for select
  to anon, authenticated
  using (active = true);
