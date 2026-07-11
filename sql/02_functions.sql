-- ============================================================
-- Qooentum · 02_functions.sql
-- Correr después de 01_schema.sql.
--
-- Las 4 funciones que llama src/lib/supabase-api.js vía supabase.rpc():
--   sync_places(p_lat, p_lng, p_radius, p_status_only) → apiGet('sync_places')
--   get_profile(p_email)                               → apiGet('me') / login
--   get_ranking(p_email)                                → apiGet('ranking')
--   submit_vote(p_email, p_place, p_status)             → apiPost('vote')
--
-- Todas son SECURITY DEFINER: corren con permisos del dueño (no del
-- caller), así pueden escribir en profiles/reports/places aunque las
-- RLS policies (03_rls.sql) bloqueen la escritura directa desde
-- anon/authenticated. La validación de identidad la hace cada función
-- leyendo auth.uid()/auth.email() — nunca confían en el email que
-- manda el cliente para decidir QUÉ fila tocar, solo lo usan como dato
-- a guardar la primera vez.
-- ============================================================

-- Mismos puntos por status que VOTE_PTS en app.js: [10,10,15,20]
create or replace function public._vote_points(p_status smallint)
returns integer language sql immutable as $$
  select (array[10,10,15,20])[greatest(1, least(4, p_status + 1))];
$$;

-- ---------------------------------------------------------------
-- sync_places
-- p_status_only = true  → solo id/status/reporters (polling liviano,
--                          cada 15s desde syncOccupancy()).
-- p_status_only = false → filas completas para pintar el mapa/lista
--                          (fetchPlacesForTile / cercaLoadPlaces).
-- p_radius en metros (default 600, igual que el llamado sin radio
-- explícito en app.js).
-- ---------------------------------------------------------------
create or replace function public.sync_places(
  p_lat double precision,
  p_lng double precision,
  p_radius double precision default 600,
  p_status_only boolean default false
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case when p_status_only then
    (
      select coalesce(jsonb_build_object('places', jsonb_agg(
        jsonb_build_object('id', id, 'status', status, 'reporters', reporters)
      )), jsonb_build_object('places', '[]'::jsonb))
      from public.places
      where geog is not null
        and st_dwithin(geog, geography(st_setsrid(st_makepoint(p_lng, p_lat), 4326)), p_radius)
    )
  else
    (
      select coalesce(jsonb_build_object('places', jsonb_agg(
        jsonb_build_object(
          'id', id, 'name', name, 'type', type, 'logo', logo, 'cat', cat,
          'addr', addr, 'lat', lat, 'lng', lng,
          'rating', rating, 'reviewsN', reviews_n,
          'verified', verified, 'open', open, 'source', source,
          'status', status, 'reporters', reporters, 'sponsor', sponsor
        )
      )), jsonb_build_object('places', '[]'::jsonb))
      from public.places
      where geog is not null
        and st_dwithin(geog, geography(st_setsrid(st_makepoint(p_lng, p_lat), 4326)), p_radius)
    )
  end;
$$;

grant execute on function public.sync_places(double precision, double precision, double precision, boolean)
  to anon, authenticated;

-- ---------------------------------------------------------------
-- get_profile
-- Crea la fila de profiles la primera vez que un usuario logueado
-- la pide (idempotente). Requiere sesión (auth.uid() no nulo);
-- p_email queda solo como dato de respaldo para el insert inicial.
-- ---------------------------------------------------------------
create or replace function public.get_profile(p_email text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles;
begin
  if v_uid is null then
    return null; -- sin sesión: el cliente no debería llamar esto (apiGet ya lo cubre con try/catch)
  end if;

  insert into public.profiles (id, email, name, picture)
  values (v_uid, coalesce(auth.email(), p_email), null, null)
  on conflict (id) do nothing;

  select * into v_row from public.profiles where id = v_uid;

  return jsonb_build_object(
    'id', v_row.id, 'email', v_row.email, 'name', v_row.name,
    'picture', v_row.picture, 'points', v_row.points,
    'currentStreak', v_row.current_streak, 'longestStreak', v_row.longest_streak
  );
end;
$$;

grant execute on function public.get_profile(text) to authenticated;

-- ---------------------------------------------------------------
-- get_ranking
-- Top 50 por puntos. "reports" = reportes del usuario en el mes
-- calendario en curso (coincide con "reportes este mes" del texto
-- en buildRanking). isMe se calcula contra auth.uid(), no contra
-- p_email (más confiable), pero se deja el parámetro por
-- compatibilidad con la firma que ya usa supabase-api.js.
-- ---------------------------------------------------------------
create or replace function public.get_ranking(p_email text default null)
returns table (
  pts     integer,
  name    text,
  init    text,
  bg      text,
  fg      text,
  reports integer,
  "isMe"  boolean
)
language sql
security definer
set search_path = public
as $$
  with palette_bg as (
    select array['#00C48C','#6366F1','#F59E0B','#EF4444','#A855F7','#F97316','#22D3EE','#009E72']::text[] as c
  ),
  palette_fg as (
    select array['#fff','#fff','#fff','#fff','#fff','#fff','#0F172A','#fff']::text[] as c
  ),
  ranked as (
    select
      p.id, p.points, coalesce(p.name, p.email) as name,
      row_number() over (order by p.points desc, p.id) as rn
    from public.profiles p
    where p.points > 0
    order by p.points desc
    limit 50
  )
  select
    r.points as pts,
    r.name,
    upper(left(r.name, 1)) as init,
    (select c[((r.rn - 1) % 8) + 1] from palette_bg) as bg,
    (select c[((r.rn - 1) % 8) + 1] from palette_fg) as fg,
    coalesce((
      select count(*)::int from public.reports rp
      where rp.user_id = r.id
        and rp.created_at >= date_trunc('month', now())
    ), 0) as reports,
    (r.id = auth.uid()) as "isMe"
  from ranked r
  order by r.points desc;
$$;

grant execute on function public.get_ranking(text) to anon, authenticated;

-- ---------------------------------------------------------------
-- submit_vote
-- 1) Requiere sesión.
-- 2) Upsert del lugar con los datos que manda el cliente (por si es
--    un lugar recién descubierto que todavía no pasó por el import).
-- 3) Si ya reportó ESE lugar HOY → devuelve {cooldown:true} sin sumar
--    puntos (la unique index reports_user_place_day_idx es la
--    barrera real; acá solo evitamos el error de constraint).
-- 4) Si el último reporte del lugar es de un día anterior, resetea
--    reporters/status antes de sumar el nuevo (mismo comportamiento
--    que el reset horario en app.js, pero server-side).
-- 5) Inserta el report, suma puntos al profile, actualiza el place.
-- ---------------------------------------------------------------
create or replace function public.submit_vote(
  p_email text,
  p_place jsonb,
  p_status smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_place_id text := p_place->>'id';
  v_points integer := public._vote_points(p_status);
  v_already boolean;
  v_last_report_ts bigint;
  v_total_points integer;
  -- racha: día calendario UTC de hoy vs. el último día en que el usuario
  -- reportó algo (cualquier lugar), guardado en profiles.last_report_day.
  v_today date := public._report_day(now());
  v_cur_streak integer;
  v_last_day date;
  v_new_streak integer;
  v_out_streak integer;
  v_out_longest integer;
  v_streak_increased boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if v_place_id is null or p_status is null or p_status < 0 or p_status > 3 then
    raise exception 'invalid vote payload';
  end if;

  -- asegura que el profile exista (mismo efecto que get_profile)
  insert into public.profiles (id, email)
  values (v_uid, coalesce(auth.email(), p_email))
  on conflict (id) do nothing;

  -- upsert del lugar: solo datos "de catálogo", nunca status/reporters/report_ts
  insert into public.places (id, name, type, addr, lat, lng, logo, rating, reviews_n, verified, open, source)
  values (
    v_place_id, p_place->>'name', p_place->>'type', p_place->>'addr',
    (p_place->>'lat')::double precision, (p_place->>'lng')::double precision,
    coalesce(p_place->>'logo', '🏪'),
    coalesce((p_place->>'rating')::numeric, 3.5),
    coalesce((p_place->>'reviewsN')::integer, 0),
    coalesce((p_place->>'verified')::boolean, false),
    coalesce((p_place->>'open')::boolean, true),
    'osm'
  )
  on conflict (id) do update set
    name = excluded.name, type = excluded.type, addr = excluded.addr,
    lat = excluded.lat, lng = excluded.lng, logo = excluded.logo;

  select report_ts into v_last_report_ts from public.places where id = v_place_id;

  -- reset diario: si el último reporte fue antes de "hoy 00:00", en
  -- vez de sumar sobre un contador viejo, arranca de cero.
  if v_last_report_ts is not null
     and to_timestamp(v_last_report_ts / 1000.0) < date_trunc('day', now()) then
    update public.places set reporters = 0, status = 0 where id = v_place_id;
  end if;

select exists(
    select 1 from public.reports
    where user_id = v_uid and place_id = v_place_id
      and public._report_day(created_at) = public._report_day(now())
  ) into v_already;

  if v_already then
    return jsonb_build_object('cooldown', true);
  end if;

  insert into public.reports (user_id, place_id, status, points)
  values (v_uid, v_place_id, p_status, v_points);

  update public.places
    set status = p_status,
        reporters = reporters + 1,
        report_ts = (extract(epoch from now()) * 1000)::bigint
    where id = v_place_id;

  -- Racha: se evalúa UNA vez por día natural (UTC), sin importar cuántos
  -- lugares distintos reporte el usuario ese día (eso lo permite el
  -- cooldown, que es por lugar, no por día). Reglas:
  --   · last_report_day = hoy        → ya venía contando hoy, no cambia.
  --   · last_report_day = ayer       → sigue la racha, +1.
  --   · last_report_day < ayer / null → se cortó (o es la primera vez), arranca en 1.
  select current_streak, last_report_day into v_cur_streak, v_last_day
    from public.profiles where id = v_uid;

  if v_last_day = v_today then
    v_new_streak := v_cur_streak;
  elsif v_last_day = v_today - 1 then
    v_new_streak := v_cur_streak + 1;
  else
    v_new_streak := 1;
  end if;
  v_streak_increased := v_new_streak > coalesce(v_cur_streak, 0);

  update public.profiles
    set points = points + v_points,
        current_streak = v_new_streak,
        longest_streak = greatest(longest_streak, v_new_streak),
        last_report_day = v_today
    where id = v_uid
    returning points, current_streak, longest_streak
    into v_total_points, v_out_streak, v_out_longest;

  return jsonb_build_object(
    'points', v_total_points, 'cooldown', false,
    'currentStreak', v_out_streak, 'longestStreak', v_out_longest,
    'streakIncreased', v_streak_increased
  );
end;
$$;

grant execute on function public.submit_vote(text, jsonb, smallint) to authenticated;
