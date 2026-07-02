/* Qooentum — Service Worker v9 (migración a Vite + Supabase) */
const CACHE_NAME = 'qooentum-v9';
const TILE_CACHE_NAME = 'qooentum-tiles-v1'; // ← cache del mapa offline. NUNCA se borra al actualizar la app.
const PRECACHE_URLS = [
  './',
  './index.html',
  './bright_patched.json',
];

/* ─── Dominios que NUNCA interceptamos ──────────────────────
   Para estos dominios NO llamamos event.respondWith() en absoluto.
   El browser los maneja directamente con CORS nativo completo.
   ─────────────────────────────────────────────────────────── */
const NEVER_INTERCEPT_DOMAINS = [
  'supabase.co',                 // ← NUEVO: REST/Auth/Storage de Supabase (sync_places, get_ranking,
                                  //   prizes, sesión). Sin esto, la regla 5 (stale-while-revalidate)
                                  //   cacheaba estas respuestas por ser GET cross-origin, sirviendo
                                  //   ranking/premios/sesión viejos. El realtime (WebSocket) no pasa
                                  //   por 'fetch' de todas formas, pero el REST sí.
  'api.geoapify.com',            // ← NUEVO: Places API (fuente complementaria a Overpass). La URL
                                  //   lleva la API key como query param; no queremos que quede
                                  //   pisando la cache del SW (app.js ya cachea esto en memoria).
  'places.googleapis.com',       // Legacy — ya no se usa (Google Places directo), se deja sin daño.
  'maps.googleapis.com',
  'googleapis.com',
  'accounts.google.com',         // Redirect de OAuth (ahora vía Supabase Auth, no GSI manual).
  'script.google.com',           // Legacy — backend viejo de Apps Script, reemplazado por Supabase.
  'overpass-api.de',             // Overpass (lugares OSM en vivo)
  'overpass.kumi.systems',
  'overpass.private.coffee',
];

/* ─── Dominios del mapa base (OpenFreeMap) → cache-first PURO ──
   Tiles, sprites y glyphs son inmutables en la práctica: una vez
   descargados (por el botón "Descargar mi zona" o de a poco mientras
   se navega), se sirven SIEMPRE desde el celular, sin red. ─────── */
const MAP_TILE_DOMAINS = ['tiles.openfreemap.org'];

function hostMatches(hostname, list) {
  return list.some((d) => hostname === d || hostname.endsWith('.' + d));
}

/* ─── INSTALL — precacheo tolerante a errores ──────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`SW: no se pudo pre-cachear ${url}:`, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

/* ─── ACTIVATE — limpiar cachés viejas del SHELL únicamente.
       La cache de tiles del mapa (TILE_CACHE_NAME) se preserva
       siempre, aunque la app se actualice de versión. ─────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== TILE_CACHE_NAME)
            .map((k) => {
              console.log(`SW: eliminando caché vieja: ${k}`);
              return caches.delete(k);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ─── FETCH ────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo interceptamos GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* 1. Dominios críticos → NO interceptar en absoluto. */
  if (hostMatches(url.hostname, NEVER_INTERCEPT_DOMAINS)) return;

  /* 2. Mapa base (OpenFreeMap: tiles vectoriales, sprites, glyphs)
        → cache-first puro, sin revalidar. Si ya está descargado
        (por el botón "Descargar mi zona" o por uso normal), nunca
        se vuelve a pedir a internet. */
  if (hostMatches(url.hostname, MAP_TILE_DOMAINS)) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return new Response('Offline', { status: 503 });
        }
      })
    );
    return;
  }

  /* 3. Navegación / HTML de mismo origen → network-first */
  if (
    req.mode === 'navigate' ||
    (url.origin === self.location.origin &&
      req.headers.get('accept')?.includes('text/html'))
  ) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match('./index.html'))
        )
    );
    return;
  }

  /* 4. Assets estáticos de mismo origen → cache-first
        (incluye los JS/CSS con hash que genera el build de Vite en
        /assets — se cachean igual que antes, sin necesidad de listarlos
        a mano en PRECACHE_URLS). */
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        }).catch(() => new Response('Offline', { status: 503 }));
      })
    );
    return;
  }

  /* 5. Cross-origin restante (fonts de Google, CDN de React/MapLibre) →
        stale-while-revalidate, porque esos SÍ pueden actualizar versión. */
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => cached || new Response('Offline', { status: 503 }));
      return cached || fetchPromise;
    })
  );
});

/* ─── SKIP WAITING (actualización inmediata desde la app) ─── */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('✅ SW v9 activo — Supabase bypass + mapa offline persistente');
