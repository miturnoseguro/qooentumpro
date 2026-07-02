// ============================================================
// supabase-api.js
// ------------------------------------------------------------
// Reemplaza apiGet/apiPost (que le pegaban a Google Apps Script) por
// llamadas a Supabase. Misma firma, mismo nombre de acciones — así
// el resto de app.js casi no necesita tocarse.
//
// También expone startRealtimeSync(), que reemplaza el polling de
// 15s (syncOccupancy/setInterval) por un websocket: los cambios de
// status llegan al instante en vez de esperar hasta 15s.
// ============================================================
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const BACKEND_READY = !!import.meta.env.VITE_SUPABASE_URL;

// ---- apiGet: mismas acciones que antes (sync_places, me, ranking, prizes) ----
export const apiGet = async (action, params = {}) => {
  if (!BACKEND_READY) return null;
  try {
    switch (action) {
      case 'sync_places': {
        const { data, error } = await supabase.rpc('sync_places', {
          p_lat: params.lat, p_lng: params.lng,
          p_radius: params.radius ?? 600,
          p_status_only: !!params.status_only,
        });
        if (error) throw error;
        return data; // ya viene como { places: [...] }
      }
      case 'me': {
        const { data, error } = await supabase.rpc('get_profile', { p_email: params.email });
        if (error) throw error;
        return data;
      }
      case 'ranking': {
        const { data, error } = await supabase.rpc('get_ranking', { p_email: params.email ?? null });
        if (error) throw error;
        return { ranking: data };
      }
      case 'prizes': {
        const { data, error } = await supabase.from('prizes').select('*').eq('active', true).order('sort_order');
        if (error) throw error;
        return { prizes: data };
      }
      default:
        console.warn('[supabase-api] acción GET no mapeada:', action);
        return null;
    }
  } catch (e) {
    console.warn('apiGet', action, e);
    return null;
  }
};

// ---- apiPost: vote y login ----
export const apiPost = async (action, payload = {}) => {
  if (!BACKEND_READY) return null;
  try {
    switch (action) {
      case 'vote': {
        const { data, error } = await supabase.rpc('submit_vote', {
          p_email: payload.email, p_place: payload.place, p_status: payload.status,
        });
        if (error) throw error;
        return data; // { points, cooldown }
      }
      case 'login': {
        // Con Supabase Auth el login real pasa por signInWithGoogle() (ver abajo).
        // Esto queda solo por compatibilidad si todavía usás el flujo GSI manual.
        const { data, error } = await supabase.rpc('get_profile', { p_email: payload.email });
        if (error) throw error;
        return data;
      }
      default:
        console.warn('[supabase-api] acción POST no mapeada:', action);
        return null;
    }
  } catch (e) {
    console.warn('apiPost', action, e);
    return null;
  }
};

// ---- Auth con Google (reemplaza el flujo manual de accounts.google.com/gsi) ----
export const signInWithGoogle = () =>
  supabase.auth.signInWithOAuth({ provider: 'google' });

export const signOut = () => supabase.auth.signOut();

export const getSession = () => supabase.auth.getSession();

export const onAuthChange = (cb) =>
  supabase.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));

// ---- Realtime: reemplaza el polling de syncOccupancy cada 15s ----
// onChange recibe { id, status, reporters } cada vez que un lugar cambia.
let _channel = null;
export const startRealtimeSync = (onChange) => {
  if (_channel) return _channel;
  _channel = supabase
    .channel('places-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'places' }, (payload) => {
      onChange({
        id: payload.new.id,
        status: payload.new.status,
        reporters: payload.new.reporters,
      });
    })
    .subscribe();
  return _channel;
};
export const stopRealtimeSync = () => {
  if (_channel) { supabase.removeChannel(_channel); _channel = null; }
};

export default supabase;
