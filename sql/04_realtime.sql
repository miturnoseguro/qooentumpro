-- ============================================================
-- Qooentum · 04_realtime.sql
-- Necesario para que startRealtimeSync() en supabase-api.js reciba
-- los eventos UPDATE de la tabla places por WebSocket.
-- ============================================================

-- REPLICA IDENTITY FULL: sin esto, payload.new en un UPDATE puede no
-- traer todas las columnas (dependiendo de la PK/índices), y
-- supabase-api.js lee payload.new.status y payload.new.reporters.
alter table public.places replica identity full;

-- Agrega la tabla a la publicación que usa Supabase Realtime.
alter publication supabase_realtime add table public.places;
