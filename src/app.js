// ============================================================
// BACKEND (Supabase) — reemplaza Google Apps Script
// ============================================================
import {
  apiGet, apiPost, BACKEND_READY,
  signInWithGoogle, signOut, getSession, onAuthChange,
  startRealtimeSync, stopRealtimeSync,
} from './lib/supabase-api.js';

// ============================================================
// CONFIGURACIÓN
// ============================================================
const CONFIG = {
  // Key gratis de https://myprojects.geoapify.com (free tier: 3000 req/día). Se usa como fuente
  // complementaria a Overpass para traer más establecimientos y más rápido. Si la dejás en
  // 'PEGAR_AQUI', la app sigue funcionando solo con Overpass.
  GEOAPIFY_API_KEY: '631ee415c3eb4b87b4d5a0c59503af58',
  DEFAULT_CENTER: { lat: -34.6083, lng: -58.3896 },
  REPORT_RADIUS_M: 50,
  GPS_ZOOM: 19,
  FOLLOW_ZOOM: 18,
  CHECKIN_RADIUS_M: 150,
  SPONSOR_PIN_RADIUS_M: 100, // radio para "pinnear" la card de un sponsor Black arriba a la izquierda
  // Antes 0.0025 (~278m): cada ~280m de movimiento disparaba un ciclo completo
  // de fetch a Supabase + rebuild de markers. Con ~670m el mismo ciclo se
  // dispara con mucha menos frecuencia al caminar/arrastrar el mapa, sin
  // perder cobertura (rebuildNearby usa este mismo valor para el radio de
  // "cerca").
  TILE_DEG: 0.006,
  BBOX_PAD: 0.0012,
  PLACE_CACHE_TTL_MS: 24 * 60 * 60 * 1000,
  VOTE_COOLDOWN_MS: 24 * 60 * 60 * 1000,
  GPS_TIMEOUT_MS: 5000,  // 5 segundos (valor razonable)

  // ── Mapa offline ──
  OFFLINE_TILEJSON_URL: 'https://tiles.openfreemap.org/planet',
  OFFLINE_SPRITE_BASE: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
  OFFLINE_GLYPHS_TPL: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  OFFLINE_RASTER_TPL: 'https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png',
  OFFLINE_RASTER_MAXZOOM: 6,
  OFFLINE_FONTSTACKS: ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'],
  OFFLINE_GLYPH_RANGES: ['0-255', '256-511'], // cubre español/portugués/inglés y la mayoría de idiomas latinos
  OFFLINE_DEFAULT_RADIUS_KM: 10,
  OFFLINE_MAX_ZOOM_CAP: 14,   // los tiles vectoriales no suelen pasar de 14; el mapa hace "over-zoom" del mismo dato hasta z17+
  OFFLINE_CONCURRENCY: 6,     // descargas en paralelo (no saturar el servidor gratuito de OpenFreeMap)
  TILE_CACHE_NAME: 'qooentum-tiles-v1', // debe coincidir con TILE_CACHE_NAME en sw.js
};

// BACKEND_READY viene ahora de supabase-api.js (importado al tope del archivo)
const GEOAPIFY_READY = !CONFIG.GEOAPIFY_API_KEY.startsWith('PEGAR_AQUI');

const SESSION_KEY = 'qooentum_user';
const DEVICE_KEY = 'qooentum_device_email';
const COOLDOWN_KEY = 'qooentum_cooldowns';
const CACHE_KEY = 'qooentum_place_cache_v2';
const LAST_LOCATION_KEY = 'qooentum_last_location';

const STATUS_CFG = [
  { label: 'Poca gente', sub: 'Entrá tranquilo', color: '#00C48C' },
  { label: 'Bastante gente', sub: 'Algo de espera', color: '#F59E0B' },
  { label: 'Mucha gente', sub: 'Fila larga', color: '#F97316' },
  { label: 'Colapsado', sub: '¡No vengas ahora!', color: '#EF4444' },
];
const NO_REPORT = { label: 'Sin reportes hoy', sub: 'Sé el primero', color: '#94A3B8' };
const NO_REPORT_SPONSOR = { label: 'Sin reportes hoy', sub: 'Sé el primero', color: '#A39357' };
// Devuelve el status a mostrar (color/label) para un lugar, usando el tono especial de "sin reportes" cuando es sponsor premium
const getStatus = p => {
  if (!p.reporters || p.reporters===0) return (p.sponsor?.tier === 'premium' || p.sponsor?.tier === 'black') ? NO_REPORT_SPONSOR : NO_REPORT;
  return STATUS_CFG[p.status];
};
const WAIT  = ['Sin espera','~5 min','~15 min','+30 min'];
const TREND = ['↘ Baja','→ Estable','↗ Sube','↗ Sube'];
// Tono gold fijo para sponsors premium (no depende del badge_color que traiga el comercio) — la marca (verde) se reserva solo para login y link al sitio
const SPONSOR_GOLD = '#D4AF37';
// Tier "Black": nivel superior a premium — onyx con hairline dorado en vez de dorado sólido.
const SPONSOR_BLACK = '#0A0A0C';
const SPONSOR_BLACK_ACCENT = '#D4AF37';
const BRAND_GREEN = '#00C48C';
const VOTE_PTS = [10,10,15,20];
const LEVEL_TITLES = ['Novato','Explorador','Cazador de Filas','Maestro del Mapa','Leyenda Urbana'];
const XP_PER_LEVEL = 150;

const SEED_PRIZES = [
  { id:'p1', emoji:'☕', name:'Café gratis', pts:200, cat:'Gastronomía', partner:'Starbucks' },
  { id:'p2', emoji:'🎬', name:'Entrada de cine', pts:400, cat:'Entretenimiento', partner:'Cinemark' },
  { id:'p3', emoji:'🛒', name:'Descuento 20% Carrefour', pts:600, cat:'Supermercado', partner:'Carrefour' },
  { id:'p4', emoji:'🍕', name:'Pizza para 2 personas', pts:800, cat:'Gastronomía', partner:"Ugi's" },
  { id:'p5', emoji:'🚌', name:'Carga SUBE $2000', pts:1000, cat:'Transporte', partner:'SUBE' },
  { id:'p6', emoji:'🎮', name:'Streaming 1 mes', pts:1200, cat:'Digital', partner:'Netflix' },
  { id:'p7', emoji:'🛍️', name:'Gift card $5000', pts:2500, cat:'Compras', partner:'Naranja X' },
  { id:'p8', emoji:'✈️', name:'Voucher de viaje', pts:5000, cat:'Turismo', partner:'Despegar' },
];

// ============================================================
// UTILIDADES Y ESTADO GLOBAL
// ============================================================
const dist = (lat1,lng1,lat2,lng2) => {
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
};
const validCoord = (lat,lng) => typeof lat==='number' && typeof lng==='number' && !isNaN(lat) && !isNaN(lng) && lat>=-90 && lat<=90 && lng>=-180 && lng<=180;
const getLevel = pts => ({ level: Math.floor(pts/XP_PER_LEVEL)+1, xp: pts%XP_PER_LEVEL, pct: Math.round(((pts%XP_PER_LEVEL)/XP_PER_LEVEL)*100) });
const today = () => new Date().toISOString().slice(0,10);
const fmtDist = m => m<1000 ? m+'m' : (m/1000).toFixed(1)+'km';
const normTxt = s => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

// ── Indicador de carga de comercios/cards ──
const _placesLoadingHideTimers = {};
const showPlacesLoading = (text, pillId = 'places-loading-pill', textId = 'places-loading-text') => {
  clearTimeout(_placesLoadingHideTimers[pillId]);
  const pill = document.getElementById(pillId);
  const lbl = document.getElementById(textId);
  if (!pill || !lbl) return;
  lbl.textContent = text;
  pill.classList.add('show');
};
const hidePlacesLoading = (delay = 250, pillId = 'places-loading-pill') => {
  clearTimeout(_placesLoadingHideTimers[pillId]);
  _placesLoadingHideTimers[pillId] = setTimeout(() => {
    const pill = document.getElementById(pillId);
    if (pill) pill.classList.remove('show');
  }, delay);
};
const fmtCooldown = ms => { const m=Math.ceil(ms/60000); const h=Math.floor(m/60); const r=m%60; return h? (r?h+'h '+r+'min':h+'h') : r+'min'; };

let userPts = 0, currentUser = null, isLoggedIn = false;
let placeStore = {}, tileCache = {}, nearbyPlaces = [];
let userLat = null, userLng = null, gpsEverReceived = false, followMode = true;
let mlMap = null, mlReady = false, mlMarkers = {}, mlClusterMarkers = [], mlUserMarker = null;
let gpsWatchId = null, placeCooldowns = {};
let currentPopupPlace = null;
let cercaAllPlaces = [], cercaFiltered = [], cercaRadius=1000, cercaCat='all', cercaSearchQ='', cercaSortMode='distance', cercaSortIdx=0, cercaLoading=false;
let cercaLoaded = false;
let cercaReqId = 0; // usado para descartar respuestas de cargas viejas (evita el parpadeo al cambiar de radio rápido)
let cercaCache = {}; // cache de resultados por radio, para no repetir el flash de datos demo al volver a un radio ya visitado
let rankingData = [], prizesData = SEED_PRIZES.map(p=>({...p}));
let _markerBatchToken = 0, _buildMarkersTimer = null;
// Sponsor "Black" actualmente pinneado arriba a la izquierda (o null si no hay ninguno cerca)
let pinnedSponsorPlace = null;
let pinnedSponsorEl = null;
// Varios espejos públicos de Overpass: se pide a todos en paralelo y se usa
// el primero que responda. Reparte la carga entre servidores en vez de
// depender de uno solo, así se evita el 429 y se espera mucho menos.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
let _overpassMirrorLastReq = {}; // último request por espejo, para no abusar de cada uno individualmente
const OVERPASS_MIN_INTERVAL_PER_MIRROR = 4000; // antes: 12s a UN solo server. Ahora: 4s por espejo, 3 en paralelo.
const OVERPASS_CACHE = new Map();
const OVERPASS_CACHE_TTL = 2*60*60*1000;
const GEOAPIFY_CACHE = new Map();
const GEOAPIFY_CACHE_TTL = 2*60*60*1000;
let _syncInterval = null;
let pickModeActive = false;
let _toastActionTimer = null;
let _gpsTimeout = null;
let mapInitialized = false;

// ============================================================
// FUNCIONES PRINCIPALES
// ============================================================
function vibrate(ms=10) { if (navigator.vibrate) navigator.vibrate(ms); }

// Cache
const tileKey = (lat,lng) => `${Math.floor(lat/CONFIG.TILE_DEG)}:${Math.floor(lng/CONFIG.TILE_DEG)}`;
const isCached = k => tileCache[k] && (Date.now()-tileCache[k].ts) < CONFIG.PLACE_CACHE_TTL_MS;
const persistCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ tiles:tileCache, places:placeStore, savedAt:Date.now() })); } catch(e) {} };
const loadCache = () => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data?.tiles) return;
    tileCache = data.tiles;
    placeStore = data.places || {};
    const todayMs = Date.now() - (Date.now() % 86400000);
    Object.values(placeStore).forEach(p => { if (p.report_ts && p.report_ts < todayMs) { p.reporters=0; p.status=0; p.report_ts=null; } });
  } catch(e) {}
};
const pruneTiles = () => {
  const now = Date.now();
  Object.keys(tileCache).forEach(k => { if (now - tileCache[k].ts > CONFIG.PLACE_CACHE_TTL_MS) delete tileCache[k]; });
  const all = new Set();
  Object.values(tileCache).forEach(t => (t.placeIds||[]).forEach(id => all.add(id)));
  Object.keys(placeStore).forEach(id => { if (!all.has(id)) delete placeStore[id]; });
};

// ============================================================
// MAPA OFFLINE — descarga del mapa base (tiles, sprite, glyphs)
// para usar sin conexión a partir de la 2da vez.
// Los REPORTES de gente (status_only / sync_places) NUNCA se
// cachean acá: siguen siendo en tiempo real contra el backend.
// ============================================================
const OFFLINE_REGION_KEY = 'qooentum_offline_region';
let offlineDownloadActive = false;
let offlineDownloadAbort = false;

// ── Matemática de tiles (slippy map / XYZ estándar) ──
const lon2tileX = (lon, z) => Math.floor((lon + 180) / 360 * Math.pow(2, z));
const lat2tileY = (lat, z) => {
  const rad = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z));
};
const kmToDegLat = km => km / 110.574;
const kmToDegLng = (km, lat) => km / (111.320 * Math.cos(lat * Math.PI / 180));

// Devuelve la lista de tiles {z,x,y} que cubren un círculo de radioKm
// alrededor de (lat,lng), entre minZoom y maxZoom inclusive.
const tilesForRadius = (lat, lng, radiusKm, minZoom, maxZoom) => {
  const dLat = kmToDegLat(radiusKm);
  const dLng = kmToDegLng(radiusKm, lat);
  const north = Math.min(85, lat + dLat), south = Math.max(-85, lat - dLat);
  const west = lng - dLng, east = lng + dLng;
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = lon2tileX(west, z), xMax = lon2tileX(east, z);
    const yMin = lat2tileY(north, z), yMax = lat2tileY(south, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) tiles.push({ z, x, y });
    }
  }
  return tiles;
};

// ── TileJSON real de OpenFreeMap (trae el template de tiles + maxzoom real) ──
let _tileJsonCache = null;
const getOfflineTileJSON = async () => {
  if (_tileJsonCache) return _tileJsonCache;
  const res = await fetch(CONFIG.OFFLINE_TILEJSON_URL);
  if (!res.ok) throw new Error('No se pudo leer el TileJSON de OpenFreeMap');
  _tileJsonCache = await res.json();
  return _tileJsonCache;
};

const tileUrlFromTemplate = (tpl, z, x, y) =>
  tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

// ── Arma la lista completa de URLs a bajar: tiles vectoriales + raster + sprite + glyphs ──
const buildOfflineUrlList = async (lat, lng, radiusKm) => {
  const tilejson = await getOfflineTileJSON();
  const tileTpl = tilejson.tiles && tilejson.tiles[0];
  if (!tileTpl) throw new Error('TileJSON sin template de tiles');
  const maxZoom = Math.min(tilejson.maxzoom ?? CONFIG.OFFLINE_MAX_ZOOM_CAP, CONFIG.OFFLINE_MAX_ZOOM_CAP);
  const minZoom = tilejson.minzoom ?? 0;

  const vectorTiles = tilesForRadius(lat, lng, radiusKm, minZoom, maxZoom)
    .map(t => tileUrlFromTemplate(tileTpl, t.z, t.x, t.y));

  const rasterTiles = tilesForRadius(lat, lng, radiusKm, 0, CONFIG.OFFLINE_RASTER_MAXZOOM)
    .map(t => tileUrlFromTemplate(CONFIG.OFFLINE_RASTER_TPL, t.z, t.x, t.y));

  const spriteUrls = [
    `${CONFIG.OFFLINE_SPRITE_BASE}.json`, `${CONFIG.OFFLINE_SPRITE_BASE}.png`,
    `${CONFIG.OFFLINE_SPRITE_BASE}@2x.json`, `${CONFIG.OFFLINE_SPRITE_BASE}@2x.png`,
  ];

  const glyphUrls = [];
  CONFIG.OFFLINE_FONTSTACKS.forEach(fs => {
    CONFIG.OFFLINE_GLYPH_RANGES.forEach(range => {
      glyphUrls.push(CONFIG.OFFLINE_GLYPHS_TPL.replace('{fontstack}', encodeURIComponent(fs)).replace('{range}', range));
    });
  });

  return [...spriteUrls, ...glyphUrls, ...vectorTiles, ...rasterTiles];
};

// ── Descarga con concurrencia limitada, guardando directo en la cache del SW ──
const downloadOfflineUrls = async (urls, onProgress) => {
  if (!('caches' in window)) throw new Error('Este navegador no soporta Cache Storage');
  const cache = await caches.open(CONFIG.TILE_CACHE_NAME);
  let done = 0, failed = 0;
  let idx = 0;
  const worker = async () => {
    while (idx < urls.length) {
      if (offlineDownloadAbort) return;
      const url = urls[idx++];
      try {
        const already = await cache.match(url);
        if (!already) {
          const res = await fetch(url, { mode: 'cors' });
          if (res && res.ok) await cache.put(url, res.clone());
          else failed++;
        }
      } catch (e) { failed++; }
      done++;
      onProgress(done, urls.length, failed);
    }
  };
  const workers = Array.from({ length: CONFIG.OFFLINE_CONCURRENCY }, worker);
  await Promise.all(workers);
  return { done, failed, total: urls.length };
};

// ── Estado guardado de la última zona descargada ──
const getOfflineRegion = () => {
  try { return JSON.parse(localStorage.getItem(OFFLINE_REGION_KEY)) || null; } catch (e) { return null; }
};
const saveOfflineRegion = data => {
  try { localStorage.setItem(OFFLINE_REGION_KEY, JSON.stringify(data)); } catch (e) {}
};

// ── Orquesta la descarga completa, actualizando la UI ──
const downloadOfflineCity = async (lat, lng, radiusKm = CONFIG.OFFLINE_DEFAULT_RADIUS_KM) => {
  if (offlineDownloadActive) return;
  offlineDownloadActive = true;
  offlineDownloadAbort = false;
  updateOfflineUI({ phase: 'preparing' });
  try {
    const urls = await buildOfflineUrlList(lat, lng, radiusKm);
    updateOfflineUI({ phase: 'downloading', done: 0, total: urls.length, failed: 0 });
    const result = await downloadOfflineUrls(urls, (done, total, failed) => {
      updateOfflineUI({ phase: 'downloading', done, total, failed });
    });
    if (offlineDownloadAbort) {
      updateOfflineUI({ phase: 'cancelled' });
    } else {
      saveOfflineRegion({ lat, lng, radiusKm, downloadedAt: Date.now(), tileCount: result.total, failed: result.failed });
      updateOfflineUI({ phase: 'done', done: result.done, total: result.total, failed: result.failed });
      showToast(result.failed > 0 ? `✅ Zona descargada (${result.failed} tiles fallaron, no afecta el uso)` : '✅ Tu zona ya está disponible offline');
    }
  } catch (e) {
    console.warn('Offline download error:', e);
    updateOfflineUI({ phase: 'error', error: e.message });
    showToast('⚠️ No se pudo descargar el mapa offline. Probá de nuevo con datos/wifi.');
  } finally {
    offlineDownloadActive = false;
  }
};

const cancelOfflineDownload = () => { offlineDownloadAbort = true; };

// ── UI del panel ──
const fmtKb = n => n > 1024 ? (n/1024).toFixed(1)+' MB' : n+' tiles';
const updateOfflineUI = ({ phase, done = 0, total = 0, failed = 0, error = '' }) => {
  const panel = document.getElementById('offline-panel');
  const icon = document.getElementById('offline-panel-icon');
  const title = document.getElementById('offline-panel-title');
  const sub = document.getElementById('offline-panel-sub');
  const barTrack = document.getElementById('offline-panel-bar-track');
  const barFill = document.getElementById('offline-panel-bar-fill');
  const actions = document.getElementById('offline-panel-actions');
  if (!panel) return;
  panel.classList.add('show');

  if (phase === 'preparing') {
    icon.textContent = '⏳';
    title.textContent = 'Preparando descarga…';
    sub.textContent = 'Calculando el mapa de tu zona';
    barTrack.style.display = 'none';
    actions.innerHTML = `<button class="offline-panel-btn secondary" onclick="closeOfflinePanel()">Ocultar</button>`;
  } else if (phase === 'downloading') {
    const pct = total ? Math.round((done/total)*100) : 0;
    icon.textContent = '⬇️';
    title.textContent = `Descargando tu zona… ${pct}%`;
    sub.textContent = `${done}/${total} archivos${failed ? ` · ${failed} con error` : ''}`;
    barTrack.style.display = 'block';
    barFill.style.width = pct + '%';
    actions.innerHTML = `<button class="offline-panel-btn secondary" onclick="cancelOfflineDownload()">Cancelar</button>`;
  } else if (phase === 'done') {
    icon.textContent = '✅';
    title.textContent = 'Zona disponible offline';
    sub.textContent = `${done} archivos guardados en tu celular`;
    barTrack.style.display = 'block';
    barFill.style.width = '100%';
    actions.innerHTML = `<button class="offline-panel-btn primary" onclick="closeOfflinePanel()">Listo</button>`;
    setTimeout(() => { if (!offlineDownloadActive) closeOfflinePanel(); }, 4000);
  } else if (phase === 'cancelled') {
    icon.textContent = '⚠️';
    title.textContent = 'Descarga cancelada';
    sub.textContent = 'Podés reintentar cuando quieras';
    actions.innerHTML = `<button class="offline-panel-btn primary" onclick="startOfflineDownloadFromUI()">Reintentar</button>`;
  } else if (phase === 'error') {
    icon.textContent = '⚠️';
    title.textContent = 'No se pudo descargar';
    sub.textContent = error || 'Revisá tu conexión e intentá de nuevo';
    actions.innerHTML = `<button class="offline-panel-btn primary" onclick="startOfflineDownloadFromUI()">Reintentar</button>`;
  }
};

const closeOfflinePanel = () => { document.getElementById('offline-panel')?.classList.remove('show'); };

const startOfflineDownloadFromUI = () => {
  const lat = userLat ?? CONFIG.DEFAULT_CENTER.lat;
  const lng = userLng ?? CONFIG.DEFAULT_CENTER.lng;
  downloadOfflineCity(lat, lng, CONFIG.OFFLINE_DEFAULT_RADIUS_KM);
};

// Botón flotante: si ya hay zona descargada reciente, muestra estado; si no, ofrece descargar.
const onOfflineBtnClick = () => {
  const region = getOfflineRegion();
  const panel = document.getElementById('offline-panel');
  panel.classList.add('show');
  if (offlineDownloadActive) return; // ya hay una descarga en curso, solo mostramos el panel
  if (region) {
    const days = Math.floor((Date.now() - region.downloadedAt) / 86400000);
    updateOfflineUI({ phase: 'done', done: region.tileCount, total: region.tileCount, failed: region.failed || 0 });
    document.getElementById('offline-panel-title').textContent = 'Tu zona ya está offline';
    document.getElementById('offline-panel-sub').textContent = days === 0 ? 'Descargada hoy' : `Descargada hace ${days} día${days===1?'':'s'}`;
    document.getElementById('offline-panel-actions').innerHTML =
      `<button class="offline-panel-btn secondary" onclick="closeOfflinePanel()">Cerrar</button>
       <button class="offline-panel-btn primary" onclick="startOfflineDownloadFromUI()">Actualizar</button>`;
  } else {
   
    document.getElementById('offline-panel-title').textContent = 'Descarga tu zona';
    document.getElementById('offline-panel-sub').textContent = `Vas a poder usar el mapa sin conexión (radio de ${CONFIG.OFFLINE_DEFAULT_RADIUS_KM} km)`;
    document.getElementById('offline-panel-bar-track').style.display = 'none';
    document.getElementById('offline-panel-actions').innerHTML =
      `<button class="offline-panel-btn secondary" onclick="closeOfflinePanel()">Ahora no</button>
       <button class="offline-panel-btn primary" onclick="startOfflineDownloadFromUI()">Descargar ahora</button>`;
  }
};
window.onOfflineBtnClick = onOfflineBtnClick;
window.closeOfflinePanel = closeOfflinePanel;
window.startOfflineDownloadFromUI = startOfflineDownloadFromUI;
window.cancelOfflineDownload = cancelOfflineDownload;

// Descarga la zona offline automáticamente ~3s después del primer GPS fix,
// SIEMPRE que el usuario todavía no tenga una zona guardada — ya no es una sugerencia
// descartable: si no respondía y refrescaba la página, antes se perdía la oportunidad
// (quedaba marcado como "ya sugerido" en sessionStorage aunque nunca se descargara nada).
// Ahora se dispara la descarga real en cada carga hasta que quede guardada con éxito.
const maybeSuggestOfflineDownload = () => {
  if (getOfflineRegion()) return; // ya tiene una zona descargada, no hace falta repetir
  if (offlineDownloadActive) return; // ya se está descargando, no duplicar
  setTimeout(() => {
    if (offlineDownloadActive || getOfflineRegion()) return;
    const lat = userLat ?? CONFIG.DEFAULT_CENTER.lat;
    const lng = userLng ?? CONFIG.DEFAULT_CENTER.lng;
    document.getElementById('offline-panel')?.classList.add('show');
    downloadOfflineCity(lat, lng, CONFIG.OFFLINE_DEFAULT_RADIUS_KM);
  }, 3000);
};

// Última ubicación guardada
const saveLastLocation = (lat,lng) => {
  try { localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ lat, lng, timestamp: Date.now() })); } catch(e) {}
};
const loadLastLocation = () => {
  try {
    const raw = localStorage.getItem(LAST_LOCATION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.lat || !data.lng) return null;
    if (Date.now() - data.timestamp > 3600000) return null;
    return { lat: data.lat, lng: data.lng };
  } catch(e) { return null; }
};

// Overpass
const osmToMeta = tags => {
  const rules = [
    { match:{amenity:'restaurant'}, emoji:'🍽️', tipo:'Restaurante', cat:'food' },
    { match:{amenity:'cafe'}, emoji:'☕', tipo:'Cafetería', cat:'food' },
    { match:{amenity:'fast_food'}, emoji:'🍔', tipo:'Comida rápida', cat:'food' },
    { match:{amenity:'bar'}, emoji:'🍺', tipo:'Bar', cat:'food' },
    { match:{amenity:'bakery'}, emoji:'🥐', tipo:'Panadería', cat:'food' },
    { match:{shop:'bakery'}, emoji:'🥐', tipo:'Panadería', cat:'food' },
    { match:{amenity:'ice_cream'}, emoji:'🍦', tipo:'Heladería', cat:'food' },
    { match:{amenity:'pharmacy'}, emoji:'💊', tipo:'Farmacia', cat:'health' },
    { match:{amenity:'hospital'}, emoji:'🏥', tipo:'Hospital', cat:'health' },
    { match:{amenity:'clinic'}, emoji:'🏥', tipo:'Clínica', cat:'health' },
    { match:{amenity:'dentist'}, emoji:'🦷', tipo:'Dentista', cat:'health' },
    { match:{amenity:'doctors'}, emoji:'👨‍⚕️', tipo:'Médico', cat:'health' },
    { match:{amenity:'bank'}, emoji:'🏦', tipo:'Banco', cat:'bank' },
    { match:{amenity:'atm'}, emoji:'🏧', tipo:'Cajero', cat:'bank' },
    { match:{shop:'money_lender'}, emoji:'💳', tipo:'Pago de servicios', cat:'bank' },
    { match:{shop:'supermarket'}, emoji:'🛒', tipo:'Supermercado', cat:'supermarket' },
    { match:{shop:'convenience'}, emoji:'🏪', tipo:'Almacén', cat:'supermarket' },
    { match:{shop:'greengrocer'}, emoji:'🥦', tipo:'Verdulería', cat:'supermarket' },
    { match:{shop:'butcher'}, emoji:'🥩', tipo:'Carnicería', cat:'supermarket' },
    { match:{amenity:'post_office'}, emoji:'📮', tipo:'Correo', cat:'government' },
    { match:{office:'government'}, emoji:'🏛️', tipo:'Oficina pública', cat:'government' },
    { match:{amenity:'social_facility'}, emoji:'🏛️', tipo:'Oficina pública', cat:'government' },
    { match:{shop:'clothes'}, emoji:'👕', tipo:'Ropa', cat:'shopping' },
    { match:{shop:'shoes'}, emoji:'👟', tipo:'Zapatería', cat:'shopping' },
    { match:{shop:'electronics'}, emoji:'📱', tipo:'Electrónica', cat:'shopping' },
    { match:{shop:'hardware'}, emoji:'🔧', tipo:'Ferretería', cat:'shopping' },
    { match:{shop:'books'}, emoji:'📚', tipo:'Librería', cat:'shopping' },
    { match:{shop:'mobile_phone'}, emoji:'📱', tipo:'Telefonía', cat:'shopping' },
    { match:{shop:'hairdresser'}, emoji:'💈', tipo:'Peluquería', cat:'shopping' },
    { match:{shop:'beauty'}, emoji:'💄', tipo:'Estética', cat:'shopping' },
    { match:{shop:'laundry'}, emoji:'👔', tipo:'Lavandería', cat:'shopping' },
    { match:{amenity:'fuel'}, emoji:'⛽', tipo:'Estación de servicio', cat:'shopping' },
    { match:{amenity:'veterinary'}, emoji:'🐾', tipo:'Veterinaria', cat:'health' },
    { match:{leisure:'fitness_centre'}, emoji:'🏋️', tipo:'Gimnasio', cat:'shopping' },
    { match:{leisure:'sports_centre'}, emoji:'🏋️', tipo:'Centro deportivo', cat:'shopping' },
    { match:{shop:'optician'}, emoji:'👓', tipo:'Óptica', cat:'health' },
    { match:{shop:'pet'}, emoji:'🐾', tipo:'Petshop', cat:'shopping' },
    { match:{shop:'sports'}, emoji:'⚽', tipo:'Deportes', cat:'shopping' },
    { match:{shop:'furniture'}, emoji:'🛋️', tipo:'Mueblería', cat:'shopping' },
    { match:{shop:'stationery'}, emoji:'✏️', tipo:'Librería/Papelería', cat:'shopping' },
    // Reglas genéricas que faltaban acá (sí estaban en scripts/import-places.js):
    // sin esto, organismos públicos (office=government sin amenity), talleres/oficios
    // (craft=*), turismo y oficinas en general quedaban afuera de la búsqueda en vivo.
    { match:{healthcare:true}, emoji:'👨‍⚕️', tipo:'Salud', cat:'health' },
    { match:{craft:true}, emoji:'🔨', tipo:'Taller/Oficio', cat:'shopping' },
    { match:{tourism:true}, emoji:'🧳', tipo:'Turismo', cat:'shopping' },
    { match:{office:true}, emoji:'🏢', tipo:'Oficina', cat:'shopping' },
    { match:{shop:true}, emoji:'🏪', tipo:'Comercio', cat:'shopping' },
    { match:{amenity:true}, emoji:'📍', tipo:'Lugar', cat:'other' },
    { match:{leisure:true}, emoji:'📍', tipo:'Lugar', cat:'other' },
  ];
  for (const r of rules) {
    let ok = true;
    for (const [k,v] of Object.entries(r.match)) {
      if (v === true) { if (!tags[k]) { ok=false; break; } }
      else { if (tags[k] !== v) { ok=false; break; } }
    }
    if (ok) return { emoji:r.emoji, tipo:r.tipo, cat:r.cat };
  }
  return { emoji:'📍', tipo:'Lugar', cat:'other' };
};
// Pide a UN espejo puntual, respetando su propio intervalo mínimo.
// `signal` es opcional: si se pasa (ver cercaLoadPlaces), permite abortar el
// pedido desde afuera cuando el usuario ya cambió de radio/zona, en vez de
// dejarlo corriendo de fondo hasta el timeout de 20s.
const overpassFetchMirror = async (url, query, signal) => {
  const now = Date.now();
  const last = _overpassMirrorLastReq[url] || 0;
  const elapsed = now - last;
  if (elapsed < OVERPASS_MIN_INTERVAL_PER_MIRROR) await new Promise(r => setTimeout(r, OVERPASS_MIN_INTERVAL_PER_MIRROR - elapsed));
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  _overpassMirrorLastReq[url] = Date.now();
  const timeoutSignal = AbortSignal.timeout(20000);
  const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
  const res = await fetch(url, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: combinedSignal,
  });
  if (res.status === 429) { _overpassMirrorLastReq[url] = Date.now() + 30000; throw new Error('429'); }
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};
// Corre todos los espejos en paralelo y devuelve el primero que responda ok.
const overpassRate = async (query, signal) => {
  try {
    return await Promise.any(OVERPASS_MIRRORS.map(url => overpassFetchMirror(url, query, signal)));
  } catch (e) {
    if (signal?.aborted) return null; // cancelado a propósito, no es un error real
    console.warn('[overpass] todos los espejos fallaron', e);
    return null;
  }
};
const overpassSearch = async (lat, lng, radiusM, signal) => {
  // La key ahora incluye el radio: antes un pedido a 1km quedaba cacheado y
  // se reusaba tal cual al pasar a 100m (mismo lat/lng redondeado), mezclando
  // resultados de radios distintos.
  const r = Math.min(radiusM, 10000);
  const key = `${Math.round(lat*400)}_${Math.round(lng*400)}_${r}`;
  const cached = OVERPASS_CACHE.get(key);
  if (cached && Date.now()-cached.ts < OVERPASS_CACHE_TTL) return cached.places;
  // Catch-all igual criterio que scripts/import-places.js: pedimos cualquier
  // node/way con "name" + alguno de estos tags "genéricos", sin filtrar por
  // valor. Antes esto era una whitelist de ~25 valores puntuales de
  // amenity/shop y por eso faltaban organismos públicos (office=government),
  // talleres/oficios (craft=*), turismo, etc. osmToMeta() decide después
  // cómo mostrar cada uno (emoji/tipo/categoría).
  const q = `[out:json][timeout:15];
(
  node["name"]["shop"](around:${r},${lat},${lng});
  node["name"]["amenity"](around:${r},${lat},${lng});
  node["name"]["office"](around:${r},${lat},${lng});
  node["name"]["leisure"](around:${r},${lat},${lng});
  node["name"]["healthcare"](around:${r},${lat},${lng});
  node["name"]["craft"](around:${r},${lat},${lng});
  node["name"]["tourism"](around:${r},${lat},${lng});
  way["name"]["shop"](around:${r},${lat},${lng});
  way["name"]["amenity"](around:${r},${lat},${lng});
  way["name"]["office"](around:${r},${lat},${lng});
  way["name"]["leisure"](around:${r},${lat},${lng});
  way["name"]["healthcare"](around:${r},${lat},${lng});
);
out center 200;`;
  const data = await overpassRate(q, signal);
  if (!data) { const cached2 = OVERPASS_CACHE.get(key); return cached2 ? cached2.places : []; }
  const places = (data.elements||[])
    .map(el => {
      // OJO: estas variables se llamaban antes "lat"/"lng", pisando el lat/lng
      // del parámetro de la función. Eso hacía que dist() se calculara de cada
      // lugar contra sí mismo (siempre 0), rompiendo el orden por cercanía y
      // el filtro de radio de acá abajo. Renombradas para no pisar el scope.
      const elLat = el.lat ?? el.center?.lat ?? null;
      const elLng = el.lon ?? el.center?.lon ?? null;
      if (elLat==null || elLng==null) return null;
      const tags = el.tags || {};
      const name = tags.name || tags['name:es'] || null;
      if (!name) return null;
      const meta = osmToMeta(tags);
      const d = Math.round(dist(lat, lng, parseFloat(elLat), parseFloat(elLng)));
      return {
        id: `osm-${el.type}-${el.id}`,
        name, type: meta.tipo, logo: meta.emoji, cat: meta.cat,
        addr: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || tags.address || '',
        lat: parseFloat(elLat), lng: parseFloat(elLng), dist: d,
        status:0, reporters:0,
        rating: (3.5 + ((el.id%14)*0.1)).toFixed(1),
        reviewsN: 10 + (el.id%190),
        open: true, verified: false, sponsor: null,
      };
    })
    .filter(p => p && p.dist <= radiusM)
    .sort((a,b) => a.dist - b.dist)
    .slice(0, window.innerWidth < 768 ? 150 : 250);
  OVERPASS_CACHE.set(key, { places, ts: Date.now() });
  return places;
};

// ── Geoapify Places: fuente complementaria, corre en paralelo con Overpass ──
// Mapea categorías de Geoapify a la misma estructura {emoji, tipo, cat} que osmToMeta.
const geoapifyToMeta = (categories) => {
  const cats = categories || [];
  const has = pfx => cats.some(c => c.startsWith(pfx));
  if (has('catering.restaurant')) return { emoji:'🍽️', tipo:'Restaurante', cat:'food' };
  if (has('catering.cafe')) return { emoji:'☕', tipo:'Café', cat:'food' };
  if (has('catering.fast_food')) return { emoji:'🍔', tipo:'Comida rápida', cat:'food' };
  if (has('catering.bar') || has('catering.pub')) return { emoji:'🍺', tipo:'Bar', cat:'food' };
  if (has('bakery') || has('catering.bakery')) return { emoji:'🥐', tipo:'Panadería', cat:'food' };
  if (has('catering.ice_cream')) return { emoji:'🍦', tipo:'Heladería', cat:'food' };
  if (has('healthcare.pharmacy')) return { emoji:'💊', tipo:'Farmacia', cat:'health' };
  if (has('healthcare.hospital')) return { emoji:'🏥', tipo:'Hospital', cat:'health' };
  if (has('healthcare.clinic')) return { emoji:'🏥', tipo:'Clínica', cat:'health' };
  if (has('healthcare.dentist')) return { emoji:'🦷', tipo:'Dentista', cat:'health' };
  if (has('healthcare')) return { emoji:'👨‍⚕️', tipo:'Salud', cat:'health' };
  if (has('service.veterinary')) return { emoji:'🐾', tipo:'Veterinaria', cat:'health' };
  if (has('optician')) return { emoji:'👓', tipo:'Óptica', cat:'health' };
  if (has('service.financial.bank')) return { emoji:'🏦', tipo:'Banco', cat:'bank' };
  if (has('atm') || has('service.financial.atm')) return { emoji:'🏧', tipo:'Cajero', cat:'bank' };
  if (has('commercial.supermarket')) return { emoji:'🛒', tipo:'Supermercado', cat:'supermarket' };
  if (has('commercial.convenience')) return { emoji:'🏪', tipo:'Almacén', cat:'supermarket' };
  if (has('commercial.food_and_drink') || has('commercial.marketplace')) return { emoji:'🥦', tipo:'Verdulería', cat:'supermarket' };
  if (has('postal')) return { emoji:'📮', tipo:'Correo', cat:'government' };
  if (has('government')) return { emoji:'🏛️', tipo:'Oficina pública', cat:'government' };
  if (has('commercial.clothing')) return { emoji:'👕', tipo:'Ropa', cat:'shopping' };
  if (has('commercial.shoes')) return { emoji:'👟', tipo:'Zapatería', cat:'shopping' };
  if (has('commercial.electronics')) return { emoji:'📱', tipo:'Electrónica', cat:'shopping' };
  if (has('commercial.hardware') || has('commercial.doityourself')) return { emoji:'🔧', tipo:'Ferretería', cat:'shopping' };
  if (has('commercial.books')) return { emoji:'📚', tipo:'Librería', cat:'shopping' };
  if (has('commercial.hairdresser')) return { emoji:'💈', tipo:'Peluquería', cat:'shopping' };
  if (has('commercial.beauty')) return { emoji:'💄', tipo:'Estética', cat:'shopping' };
  if (has('service.laundry')) return { emoji:'👔', tipo:'Lavandería', cat:'shopping' };
  if (has('service.vehicle') && has('fuel')) return { emoji:'⛽', tipo:'Estación de servicio', cat:'shopping' };
  if (has('leisure.fitness_centre') || has('sport.fitness')) return { emoji:'🏋️', tipo:'Gimnasio', cat:'shopping' };
  if (has('commercial.pet')) return { emoji:'🐾', tipo:'Petshop', cat:'shopping' };
  if (has('commercial.sports')) return { emoji:'⚽', tipo:'Deportes', cat:'shopping' };
  if (has('commercial.furniture')) return { emoji:'🛋️', tipo:'Mueblería', cat:'shopping' };
  if (has('commercial.stationery')) return { emoji:'✏️', tipo:'Librería/Papelería', cat:'shopping' };
  if (has('commercial')) return { emoji:'🏪', tipo:'Comercio', cat:'shopping' };
  return { emoji:'📍', tipo:'Lugar', cat:'other' };
};
const GEOAPIFY_CATEGORIES = [
  'catering.restaurant','catering.cafe','catering.fast_food','catering.bar','catering.pub',
  'catering.bakery','catering.ice_cream','healthcare.pharmacy','healthcare.hospital',
  'healthcare.clinic','healthcare.dentist','service.veterinary','service.financial.bank',
  'service.financial.atm','commercial.supermarket','commercial.convenience',
  'commercial.clothing','commercial.shoes','commercial.electronics','commercial.hardware',
  'commercial.books','commercial.hairdresser','commercial.beauty','service.laundry',
  'leisure.fitness_centre','commercial.pet','commercial.sports','commercial.furniture',
  'commercial.stationery','postal','optician',
].join(',');
const geoapifySearch = async (lat, lng, radiusM) => {
  if (!GEOAPIFY_READY) return [];
  const key = `${Math.round(lat*400)}_${Math.round(lng*400)}`;
  const cached = GEOAPIFY_CACHE.get(key);
  if (cached && Date.now()-cached.ts < GEOAPIFY_CACHE_TTL) return cached.places;
  const r = Math.min(radiusM, 10000);
  const url = `https://api.geoapify.com/v2/places?categories=${GEOAPIFY_CATEGORIES}&filter=circle:${lng},${lat},${r}&bias=proximity:${lng},${lat}&limit=100&apiKey=${CONFIG.GEOAPIFY_API_KEY}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const places = (data.features||[])
      .map(f => {
        const p = f.properties || {};
        const [flng, flat] = f.geometry?.coordinates || [null,null];
        if (flat==null || flng==null || !p.name) return null;
        const meta = geoapifyToMeta(p.categories);
        return {
          id: `geoapify-${p.place_id || p.osm_id || (flat+'_'+flng)}`,
          name: p.name, type: meta.tipo, logo: meta.emoji, cat: meta.cat,
          addr: p.address_line2 || p.street || '',
          lat: flat, lng: flng, dist: Math.round(dist(lat,lng,flat,flng)),
          status:0, reporters:0,
          rating: (3.5 + ((p.place_id ? p.place_id.length : 5)%14)*0.1).toFixed(1),
          reviewsN: 10 + ((p.place_id ? p.place_id.length : 5)%190),
          open: true, verified: false, sponsor: null,
        };
      })
      .filter(p => p && p.dist <= radiusM)
      .sort((a,b) => a.dist - b.dist);
    GEOAPIFY_CACHE.set(key, { places, ts: Date.now() });
    return places;
  } catch (e) {
    console.warn('[geoapify]', e);
    const cached2 = GEOAPIFY_CACHE.get(key);
    return cached2 ? cached2.places : [];
  }
};

// ── Fuente combinada: Overpass + Geoapify en paralelo ──
// Corre ambas búsquedas al mismo tiempo (no una después de la otra) y mergea
// sin duplicar: si un lugar de Geoapify está muy cerca (<25m) de uno que ya
// trajo Overpass con nombre parecido, se descarta el duplicado.
const mergeSources = (primary, secondary) => {
  const isDup = (a,b) => dist(a.lat,a.lng,b.lat,b.lng) < 25 && normTxt(a.name) === normTxt(b.name);
  const extra = secondary.filter(s => !primary.some(p => isDup(p,s)));
  return [...primary, ...extra].sort((a,b) => a.dist - b.dist);
};
const searchPlaces = async (lat, lng, radiusM) => {
  const [osm, geo] = await Promise.allSettled([
    overpassSearch(lat, lng, radiusM),
    geoapifySearch(lat, lng, radiusM),
  ]);
  const osmPlaces = osm.status === 'fulfilled' ? osm.value : [];
  const geoPlaces = geo.status === 'fulfilled' ? geo.value : [];
  return mergeSources(osmPlaces, geoPlaces);
};

// Backend
// (apiGet/apiPost ahora vienen de supabase-api.js, importado arriba de
// este archivo — misma firma que antes, así todo lo de abajo sigue igual)

// Cooldowns
const saveCooldowns = () => {
  try {
    const now = Date.now();
    const toSave = { _day: today() };
    Object.keys(placeCooldowns).forEach(pid => {
      const ts = placeCooldowns[pid] instanceof Date ? placeCooldowns[pid].getTime() : 0;
      if (ts > now) toSave[pid] = ts;
    });
    localStorage.setItem(COOLDOWN_KEY, JSON.stringify(toSave));
  } catch(e) {}
};
const loadCooldowns = () => {
  try {
    const raw = localStorage.getItem(COOLDOWN_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data._day !== today()) { localStorage.removeItem(COOLDOWN_KEY); return; }
    Object.keys(data).forEach(pid => {
      if (pid === '_day') return;
      const ts = data[pid];
      if (ts && ts > Date.now()) placeCooldowns[pid] = new Date(ts);
    });
  } catch(e) {}
};
const applyCooldown = pid => {
  const midnight = new Date(); midnight.setDate(midnight.getDate()+1); midnight.setHours(0,0,0,0);
  placeCooldowns[pid] = midnight;
  saveCooldowns();
};
const getCooldown = pid => { const n = placeCooldowns[pid]; return n ? Math.max(0, n.getTime()-Date.now()) : 0; };

// Carga de lugares
let _loadTimer = null, _loadPending = null;
const ensurePlaces = async (lat,lng) => {
  _loadPending = {lat,lng};
  if (_loadTimer) clearTimeout(_loadTimer);
  const key = tileKey(lat,lng);
  const delay = isCached(key) ? 0 : 400;
  return new Promise(resolve => {
    _loadTimer = setTimeout(() => {
      _loadTimer = null;
      const {lat:l, lng:g} = _loadPending || {lat,lng};
      _loadPlaces(l,g).then(resolve).catch(resolve);
    }, delay);
  });
};
const _loadPlaces = async (lat,lng) => {
  const key = tileKey(lat,lng);
  if (isCached(key)) {
    rebuildNearby(lat,lng);
    buildMapMarkers(nearbyPlaces);
    syncBackend(lat,lng);
    return;
  }
  showPlacesLoading('Buscando comercios cercanos…');
  try {
    // Supabase primero (una sola query PostGIS, rápida). Solo si devuelve
    // pocos resultados —zona todavía sin importar via import-places.js—
    // vamos también a Overpass/Geoapify en vivo, que es la parte lenta.
    const MIN_BACKEND_RESULTS = 5;
    const backend = BACKEND_READY ? await apiGet('sync_places', {lat,lng,radius:600}) : null;
    const backendPlaces = backend?.places || [];
    const osms = backendPlaces.length < MIN_BACKEND_RESULTS ? await searchPlaces(lat,lng,600) : [];
    const bm = new Map(backendPlaces.map(p=>[p.id,p]));
    const merged = osms.map(p => { const bp = bm.get(p.id); return bp ? {...p,...bp} : p; });
    const onlyBackend = backendPlaces.filter(p => !osms.find(o=>o.id===p.id));
    const all = [...merged, ...onlyBackend];
    const ids = [];
    all.forEach(p => { placeStore[p.id] = p; ids.push(p.id); });
    tileCache[key] = { ts: Date.now(), placeIds: ids };
    persistCache();
    rebuildNearby(lat,lng);
    applySeed(lat,lng);
    buildMapMarkers(nearbyPlaces);
  } catch (e) {
    console.warn('[_loadPlaces]', e);
    hidePlacesLoading(0);
  }
};
const rebuildNearby = (lat,lng) => {
  const maxDist = CONFIG.TILE_DEG * 111320 * 1.2;
  nearbyPlaces = Object.values(placeStore).filter(p => validCoord(p.lat,p.lng) && dist(lat,lng,p.lat,p.lng) <= maxDist);
  applySeed(lat,lng);
};
const syncBackend = async (lat,lng) => {
  if (!BACKEND_READY) return;
  const res = await apiGet('sync_places', {lat,lng,radius:300,status_only:1});
  if (!res?.places) return;
  res.places.forEach(bp => { const p = placeStore[bp.id]; if (p) { p.status = bp.status ?? p.status; p.reporters = bp.reporters ?? p.reporters; } });
  persistCache();
};

// Seed diario
const SEED_KEY = 'qooentum_seed';
const getSeed = () => {
  try { const raw = localStorage.getItem(SEED_KEY); if (!raw) return null; const d=JSON.parse(raw); if (d.date !== today()) { localStorage.removeItem(SEED_KEY); return null; } return d; } catch(e){return null;}
};
const saveSeed = data => { try { localStorage.setItem(SEED_KEY, JSON.stringify({...data, date: today()})); } catch(e) {} };
const applySeed = (lat,lng) => {
  const all = Object.values(placeStore);
  if (!all.length || lat==null) return;
  const near300 = all.filter(p => validCoord(p.lat,p.lng) && dist(lat,lng,p.lat,p.lng) <= 300);
  if (!near300.length) return;
  let seed = getSeed();
  if (!seed || !seed.ids) {
    const dateNum = parseInt(today().replace(/-/g,''));
    const shuffled = [...near300].sort((a,b) => {
      const ha = (a.id.split('').reduce((acc,c,i)=>acc+c.charCodeAt(0)*(i+1),0)+dateNum)%997;
      const hb = (b.id.split('').reduce((acc,c,i)=>acc+c.charCodeAt(0)*(i+1),0)+dateNum)%997;
      return ha-hb;
    }).slice(0,5);
    const statuses = shuffled.map((_,i) => Math.floor(((dateNum*(i+3))%100)/34));
    const reporters = shuffled.map((_,i) => 3 + Math.floor(((dateNum*(i+7))%100)/6));
    seed = { ids: shuffled.map(p=>p.id), statuses, reporters };
    saveSeed(seed);
  }
  seed.ids.forEach((id,i) => {
    const p = placeStore[id];
    if (p && (!p.reporters || p.reporters===0)) {
      p.status = seed.statuses[i] ?? 0;
      p.reporters = seed.reporters[i] ?? 3;
      placeStore[p.id] = p;
      refreshMarker(id);
    }
  });
};

// ============================================================
// MAPLIBRE - INICIO ROBUSTO
// ============================================================
const initMap = (center) => {
  if (mapInitialized) return;
  mapInitialized = true;

  const splash = document.getElementById('splash');
  // Forzar ocultación del splash tras 6 segundos (incluso si falla)
  const forceHide = setTimeout(() => {
    splash.classList.add('hidden');
  }, 6000);

  mlMap = new maplibregl.Map({
    container: 'maplibre-map',
    style: '/bright_patched.json', // vive en /public — Vite lo sirve tal cual en la raíz
    center: center || [CONFIG.DEFAULT_CENTER.lng, CONFIG.DEFAULT_CENTER.lat],
    zoom: 17,
    attributionControl: false,
    trackResize: true,
    maxTileCacheSize: 150,
    fadeDuration: 100,
  });
  mlMap.addControl(new maplibregl.AttributionControl({compact:true}), 'bottom-right');

  // Asegurar que el panel mapa esté visible
  switchTab('map');

  // Evento load (cuando el mapa carga correctamente)
  mlMap.on('load', () => {
    clearTimeout(forceHide);
    mlReady = true;
    mlMap.resize();
    try {
      initSearch();
    } catch (e) {
      // Blindaje: si el buscador falla por cualquier motivo, no debe
      // impedir que el splash se oculte ni que el mapa quede usable.
      console.warn('[initSearch]', e);
    }
    followMode = true;
    updateGpsUI();
    splash.classList.add('hidden');

    if (userLat != null && userLng != null) {
      updateUserMarker(userLat, userLng);
      safeMove(() => mlMap.flyTo({ center:[userLng, userLat], zoom: CONFIG.GPS_ZOOM, duration: 600 }));
    }
    if (navigator.geolocation && gpsWatchId == null) {
      startGpsWatch();
    }
    if (!cercaLoaded) cercaLoadPlaces();
  });

  // Si hay error al cargar el estilo/mapa, ocultar splash
  mlMap.on('error', (e) => {
    console.warn('Map error:', e);
    splash.classList.add('hidden');
  });

  // Eventos de navegación
  // Si el usuario arrastra/hace zoom manualmente (gesto real, no un flyTo/easeTo
  // programático), dejamos de seguir su GPS para que pueda recorrer el mapa
  // libremente. Solo vuelve a seguir si toca el botón de ubicación.
  mlMap.on('movestart', (e) => {
    if (e && e.originalEvent && followMode) {
      followMode = false;
      updateGpsUI();
    }
  });
  mlMap.on('zoomend', () => { if (nearbyPlaces.length) buildMapMarkers(nearbyPlaces); });
  mlMap.on('moveend', () => {
    if (!mlMap) return;
    const c = mlMap.getCenter();
    const key = tileKey(c.lat, c.lng);
    if (key !== window._lastTileKey) {
      window._lastTileKey = key;
      ensurePlaces(c.lat, c.lng);
    }
  });

  new ResizeObserver(() => { if (mlMap) mlMap.resize(); }).observe(document.getElementById('maplibre-map'));
};

// ============================================================
// GPS Y WATCH
// ============================================================
const startGpsWatch = () => {
  if (!navigator.geolocation) {
    if (!window._mapLoaded) { const c=CONFIG.DEFAULT_CENTER; ensurePlaces(c.lat,c.lng); window._mapLoaded=true; }
    return;
  }
  if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = navigator.geolocation.watchPosition(
    pos => onGps(pos),
    err => { console.warn('GPS watch:', err); if (!window._mapLoaded) { const c=CONFIG.DEFAULT_CENTER; ensurePlaces(c.lat,c.lng); window._mapLoaded=true; } },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
};

// Prefetch real de 3km contra Supabase, una sola vez al conseguir el
// primer fix de GPS. En vez de ir armando de a tiles de ~277m (radio
// 600m), esto trae de golpe todo lo que haya en 3km a la redonda —
// mucho más rápido si import-places.js ya corrió para la zona, porque
// es UNA sola query PostGIS en vez de N tiles secuenciales. ensurePlaces()
// sigue corriendo igual después para completar huecos puntuales / status.
let _prefetch3kmDone = false;
const prefetch3km = async (lat, lng) => {
  if (_prefetch3kmDone || !BACKEND_READY) return;
  _prefetch3kmDone = true;
  try {
    const backend = await apiGet('sync_places', { lat, lng, radius: 3000 });
    if (!backend?.places?.length) return;
    backend.places.forEach(p => { placeStore[p.id] = p; });
    persistCache();
    rebuildNearby(lat, lng);
    buildMapMarkers(nearbyPlaces);
  } catch (e) {
    console.warn('[prefetch3km]', e);
  }
};

const onGps = pos => {
  const {latitude:lat, longitude:lng, accuracy} = pos.coords;
  if (!validCoord(lat,lng)) return;
  if (gpsEverReceived && accuracy > 150) return;
  const isFirstFix = !gpsEverReceived;
  userLat = lat; userLng = lng; gpsEverReceived = true;
  saveLastLocation(lat,lng);
  checkPinnedSponsor(lat,lng);
  if (isFirstFix) maybeSuggestOfflineDownload();
  if (mlReady) updateUserMarker(lat,lng);
  if (mlReady && mlMap && validCoord(lat,lng)) {
    if (!window._mapLoaded) {
      // Primer fix de GPS: centrar el mapa en la posición del usuario una sola vez.
      const zoom = window._firstGpsZoom ? CONFIG.GPS_ZOOM : CONFIG.FOLLOW_ZOOM;
      if (!window._firstGpsZoom) window._firstGpsZoom = true;
      safeMove(() => mlMap.flyTo({ center:[lng,lat], zoom, duration:800 }));
    } else if (followMode) {
      // Solo se recentra automáticamente si el usuario está en modo "seguir"
      // (lo activa tocando el ícono de GPS). Si arrastró el mapa, followMode
      // se desactiva y el mapa lo deja recorrer libremente.
      safeMove(() => mlMap.easeTo({ center:[lng,lat], duration:600 }));
    }
  }
  if (!window._mapLoaded) {
    window._mapLoaded = true;
    window._lastTileKey = tileKey(lat,lng);
    prefetch3km(lat,lng);
    ensurePlaces(lat,lng).then(() => maybeCheckin(lat,lng));
    updateGpsUI();
    cercaLoaded = false;
    cercaLoadPlaces();
  } else {
    const key = tileKey(lat,lng);
    if (key !== window._lastTileKey) { window._lastTileKey = key; ensurePlaces(lat,lng).then(() => maybeCheckin(lat,lng)); }
    else maybeCheckin(lat,lng);
  }
  document.getElementById('splash').classList.add('hidden');
};

// ============================================================
// SPONSOR "BLACK" — card fija arriba a la izquierda mientras el
// usuario esté a ≤SPONSOR_PIN_RADIUS_M de un comercio de ese tier.
// Al alejarse, la card vuelve a comportarse como un marker normal
// en su lat/lng (se restaura la visibilidad del marker en el mapa).
// ============================================================
const ensurePinnedSponsorEl = () => {
  if (pinnedSponsorEl) return pinnedSponsorEl;
  const el = document.createElement('div');
  el.id = 'pinned-sponsor-card';
  el.style.cssText = `
    position:fixed; top:14px; left:14px; z-index:9500;
    width:230px; border-radius:16px; overflow:hidden;
    background:linear-gradient(180deg,#1a1a1d 0%, #0a0a0c 100%);
    border:1px solid rgba(212,175,55,0.45);
    box-shadow:0 12px 34px rgba(0,0,0,.45), 0 0 0 1px rgba(212,175,55,.15);
    opacity:0; transform:translateY(-10px);
    pointer-events:none;
    transition:opacity .32s ease, transform .32s cubic-bezier(.34,1.56,.64,1);
    cursor:pointer; font-family:inherit;
  `;
  document.body.appendChild(el);
  pinnedSponsorEl = el;
  return el;
};
const renderPinnedSponsorCard = (place) => {
  const el = ensurePinnedSponsorEl();
  const logoInner = place.sponsor?.logo_url
    ? `<img src="${place.sponsor.logo_url}" style="width:100%;height:100%;object-fit:contain;">`
    : (place.logo || '🏪');
  el.innerHTML = `
    <div style="position:relative;height:76px;background:#111;">
      ${place.sponsor?.photo_url ? `<img src="${place.sponsor.photo_url}" style="width:100%;height:100%;object-fit:cover;opacity:.55;">` : ''}
      <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.15),rgba(0,0,0,.8));"></div>
      <div style="position:absolute;top:8px;left:8px;background:${SPONSOR_BLACK_ACCENT};color:#0A0A0C;font-size:9px;font-weight:900;letter-spacing:.6px;padding:2px 8px;border-radius:20px;">BLACK</div>
      <div style="position:absolute;bottom:8px;left:10px;right:10px;display:flex;align-items:center;gap:8px;">
        <div style="width:32px;height:32px;border-radius:9px;background:#151517;border:1px solid rgba(212,175,55,.4);display:flex;align-items:center;justify-content:center;font-size:16px;overflow:hidden;flex-shrink:0;">${logoInner}</div>
        <div style="min-width:0;">
          <div style="font-size:12.5px;font-weight:800;color:#F5F0E6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${place.name}</div>
          <div style="font-size:10px;color:#C9C2B4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${place.type||''}</div>
        </div>
      </div>
    </div>
    ${place.sponsor?.promo ? `<div style="padding:8px 10px;font-size:11px;font-weight:700;color:${SPONSOR_BLACK_ACCENT};">🎁 ${place.sponsor.promo}</div>` : ''}
  `;
  el.onclick = () => openPopup(place);
  el.style.pointerEvents = 'auto';
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  const mk = mlMarkers[place.id];
  if (mk) mk.el.style.visibility = 'hidden';
};
const hidePinnedSponsorCard = () => {
  const prev = pinnedSponsorPlace;
  pinnedSponsorPlace = null;
  if (prev) { const mk = mlMarkers[prev.id]; if (mk) mk.el.style.visibility = ''; }
  if (!pinnedSponsorEl) return;
  pinnedSponsorEl.style.opacity = '0';
  pinnedSponsorEl.style.transform = 'translateY(-10px)';
  pinnedSponsorEl.style.pointerEvents = 'none';
};
const checkPinnedSponsor = (lat,lng) => {
  const blackSponsors = Object.values(placeStore).filter(p => p.sponsor?.tier === 'black' && validCoord(p.lat,p.lng));
  if (!blackSponsors.length) { if (pinnedSponsorPlace) hidePinnedSponsorCard(); return; }
  let closest = null, closestD = Infinity;
  blackSponsors.forEach(p => { const d = dist(lat,lng,p.lat,p.lng); if (d < closestD) { closestD = d; closest = p; } });
  if (closest && closestD <= CONFIG.SPONSOR_PIN_RADIUS_M) {
    if (!pinnedSponsorPlace || pinnedSponsorPlace.id !== closest.id) {
      if (pinnedSponsorPlace) hidePinnedSponsorCard();
      pinnedSponsorPlace = closest;
      renderPinnedSponsorCard(closest);
    }
  } else if (pinnedSponsorPlace) {
    hidePinnedSponsorCard();
  }
};

// ============================================================
// OBTENER UBICACIÓN ANTES DEL MAPA (con fallback)
// ============================================================
const requestGpsBeforeMap = () => {
  const last = loadLastLocation();
  if (last && validCoord(last.lat, last.lng)) {
    userLat = last.lat;
    userLng = last.lng;
    gpsEverReceived = true;
    initMap([last.lng, last.lat]);
    if (navigator.geolocation) {
      const btn = document.getElementById('gps-btn');
      if (btn) btn.classList.add('pulsing');
      navigator.geolocation.getCurrentPosition(
        pos => { if (btn) btn.classList.remove('pulsing'); onGps(pos); startGpsWatch(); },
        err => { if (btn) btn.classList.remove('pulsing'); handleGpsErr(err); },
        { enableHighAccuracy: true, timeout: CONFIG.GPS_TIMEOUT_MS, maximumAge: 5000 }
      );
    } else {
      startGpsWatch();
    }
    return;
  }

  if (navigator.geolocation) {
    const splashText = document.getElementById('splash-text');
    splashText.textContent = 'Obteniendo tu ubicación…';
    const btn = document.getElementById('gps-btn');
    if (btn) btn.classList.add('pulsing');
    _gpsTimeout = setTimeout(() => {
      if (!gpsEverReceived) {
        splashText.textContent = 'Usando ubicación predeterminada';
        setTimeout(() => {
          initMap([CONFIG.DEFAULT_CENTER.lng, CONFIG.DEFAULT_CENTER.lat]);
          document.getElementById('splash').classList.add('hidden');
        }, 400);
      }
    }, CONFIG.GPS_TIMEOUT_MS);

    navigator.geolocation.getCurrentPosition(
      pos => {
        if (_gpsTimeout) clearTimeout(_gpsTimeout);
        if (btn) btn.classList.remove('pulsing');
        onGps(pos);
        if (!mapInitialized) {
          initMap([pos.coords.longitude, pos.coords.latitude]);
        }
        startGpsWatch();
      },
      err => {
        if (_gpsTimeout) clearTimeout(_gpsTimeout);
        if (btn) btn.classList.remove('pulsing');
        handleGpsErr(err);
        if (!mapInitialized) {
          initMap([CONFIG.DEFAULT_CENTER.lng, CONFIG.DEFAULT_CENTER.lat]);
          document.getElementById('splash').classList.add('hidden');
        }
      },
      { enableHighAccuracy: true, timeout: CONFIG.GPS_TIMEOUT_MS }
    );
  } else {
    initMap([CONFIG.DEFAULT_CENTER.lng, CONFIG.DEFAULT_CENTER.lat]);
    document.getElementById('splash').classList.add('hidden');
    startGpsWatch();
  }
};

const handleGpsErr = err => {
  const banner = document.getElementById('gps-blocked-banner');
  const sub = document.getElementById('gps-blocked-sub');
  if (banner && sub) {
    if (err.code===1) sub.textContent = 'Permiso denegado — activalo en Configuración > Privacidad > Ubicación';
    else if (err.code===2) sub.textContent = 'No se pudo obtener tu ubicación. Chequeá que el GPS esté activado.';
    else if (err.code===3) sub.textContent = 'El GPS tardó demasiado. Intentando de nuevo…';
    banner.classList.add('show');
  }
  followMode = false;
  updateGpsUI();
  if (!window._mapLoaded) {
    const c = CONFIG.DEFAULT_CENTER;
    safeMove(() => mlMap.flyTo({ center:[c.lng,c.lat], zoom:13, duration:600 }));
    ensurePlaces(c.lat,c.lng);
    window._mapLoaded = true;
  }
  if (!cercaLoaded) cercaLoadPlaces();
  document.getElementById('splash').classList.add('hidden');
};

const safeMove = fn => { try { fn(); } catch(e) { console.warn('[Map]', e.message); } };
const updateGpsUI = () => {
  const btn = document.getElementById('gps-btn'), pill = document.getElementById('follow-pill');
  if (!btn) return;
  btn.classList.remove('pulsing','active','following');
  if (followMode && userLat != null) {
    btn.classList.add('following');
    if (pill) pill.classList.add('show');
  } else if (userLat != null) {
    btn.classList.add('active');
    if (pill) pill.classList.remove('show');
  } else {
    if (pill) pill.classList.remove('show');
  }
};
const onGpsBtnClick = () => {
  vibrate(8);
  if (followMode && userLat != null) {
    if (mlMap && validCoord(userLat,userLng)) safeMove(() => mlMap.flyTo({ center:[userLng,userLat], zoom:CONFIG.FOLLOW_ZOOM, duration:500 }));
    showToast('📍 Mostrando tu ubicación');
    return;
  }
  if (userLat != null) {
    followMode = true; updateGpsUI();
    if (mlMap && validCoord(userLat,userLng)) safeMove(() => mlMap.flyTo({ center:[userLng,userLat], zoom:CONFIG.FOLLOW_ZOOM, duration:500 }));
    showToast('📍 Siguiendo tu posición');
    return;
  }
  const btn = document.getElementById('gps-btn');
  if (!navigator.geolocation) { showToast('⚠️ GPS no disponible'); return; }
  btn.classList.add('pulsing');
  navigator.geolocation.getCurrentPosition(
    pos => { btn.classList.remove('pulsing'); followMode = true; onGps(pos); startGpsWatch(); },
    err => { btn.classList.remove('pulsing'); handleGpsErr(err); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};
const onZoomIn = () => { if (mlMap) { vibrate(5); mlMap.zoomIn({duration:300}); } };
const onZoomOut = () => { if (mlMap) { vibrate(5); mlMap.zoomOut({duration:300}); } };

// ============================================================
// MARKERS (resumido - igual que antes)
// ============================================================
const clusterGrid = z => {
  if (z>=18) return 0.003;
  if (z>=17) return 0.005;
  if (z>=16) return 0.008;
  if (z>=15) return 0.012;
  if (z>=14) return 0.022;
  if (z>=13) return 0.045;
  if (z>=12) return 0.090;
  if (z>=11) return 0.180;
  return 0.35;
};
const density = count => count<=5 ? 'density-low' : count<=15 ? 'density-med' : count<=40 ? 'density-high' : 'density-max';
const buildMapMarkers = (places) => {
  if (_buildMarkersTimer) clearTimeout(_buildMarkersTimer);
  _buildMarkersTimer = setTimeout(() => _buildMarkers(places), 80);
};
const _buildMarkers = (placesToShow) => {
  if (!mlMap || !mlReady) return;
  placesToShow = placesToShow || nearbyPlaces;
  placesToShow = placesToShow.filter(p => validCoord(p.lat,p.lng));
  // Ya no agrupamos en clusters: siempre se muestran las cards individuales,
  // en cualquier nivel de zoom.
  clearClusterMarkers();
  if (!placesToShow.length) { clearPlaceMarkers(); hidePlacesLoading(0); return; }
  const isMobile = window.innerWidth < 768;
  const MAX = isMobile ? 60 : 150;
  const center = mlMap.getCenter();
  const byDist = (a,b) => ((a.lat-center.lat)**2+(a.lng-center.lng)**2) - ((b.lat-center.lat)**2+(b.lng-center.lng)**2);

  // Antes se ordenaba TODO por distancia al centro y se cortaban los N más
  // cercanos: cualquier micro-movimiento cambiaba quién quedaba justo en el
  // borde del corte, así que markers se destruían y volvían a crear todo el
  // tiempo → eso era el titileo al moverse/zoomear.
  //
  // Ahora: se filtra por los bounds reales del viewport + un margen de
  // buffer (25%) alrededor, y los markers que YA están en el mapa se
  // priorizan para seguir estando (no se recalculan por distancia), así que
  // solo entran/salen markers cuando de verdad quedan fuera del área visible
  // + buffer, no por un empate de distancia.
  const bounds = mlMap.getBounds();
  const padLng = (bounds.getEast() - bounds.getWest()) * 0.25;
  const padLat = (bounds.getNorth() - bounds.getSouth()) * 0.25;
  const west = bounds.getWest() - padLng, east = bounds.getEast() + padLng;
  const south = bounds.getSouth() - padLat, north = bounds.getNorth() + padLat;
  const inView = placesToShow.filter(p => p.lng >= west && p.lng <= east && p.lat >= south && p.lat <= north);

  const already = inView.filter(p => mlMarkers[p.id]);
  const rest = inView.filter(p => !mlMarkers[p.id]);
  let toRender;
  if (already.length >= MAX) {
    toRender = [...already].sort(byDist).slice(0, MAX);
  } else {
    const restSorted = [...rest].sort(byDist).slice(0, MAX - already.length);
    toRender = [...already, ...restSorted];
  }
  const renderIds = new Set(toRender.map(p => p.id));

  // Sacamos del mapa solo las cards que ya no corresponden (lugares que
  // quedaron fuera de rango). Las que siguen vigentes NO se tocan, así se
  // evita el destruir-y-recrear que causaba el titileo al hacer zoom.
  Object.keys(mlMarkers).forEach(id => {
    if (!renderIds.has(id)) { mlMarkers[id].marker.remove(); delete mlMarkers[id]; }
  });

  const token = ++_markerBatchToken;
  const BATCH = isMobile ? 8 : 20;
  const half = Math.ceil(toRender.length / 2);
  const pending = toRender.filter(p => !mlMarkers[p.id]).length;
  let renderedNew = 0;
  if (pending > 0) showPlacesLoading(`Cargando cards de establecimientos… 0%`);
  else hidePlacesLoading(0);
  const add = i => {
    if (_markerBatchToken !== token) return;
    const chunk = toRender.slice(i, i+BATCH);
    chunk.forEach(p => {
      if (mlMarkers[p.id]) {
        const m = mlMarkers[p.id];
        if (m._lastStatus !== p.status || m._lastReporters !== p.reporters) {
          const s = getStatus(p);
          const el = m.el.querySelector('.fc-card-status');
          if (el) { el.style.background = s.color; const lbl = el.querySelector('.s-label-sm'); if (lbl) lbl.textContent = s.label; }
          m._lastStatus = p.status; m._lastReporters = p.reporters;
        }
        // Si este lugar es el sponsor "black" pinneado actualmente, su marker
        // sigue oculto (la card fija de arriba a la izquierda lo reemplaza).
        if (pinnedSponsorPlace && pinnedSponsorPlace.id === p.id) m.el.style.visibility = 'hidden';
        return;
      }
      const el = makeMarker(p);
      el.classList.add('fc-entering');
      el.addEventListener('click', () => { vibrate(10); selectPlaceInUI(p.id); if (pickModeActive) { exitPickMode(); openPopup(p); } else openPopup(p); });
      const marker = new maplibregl.Marker({ element:el, anchor:'bottom' }).setLngLat([p.lng,p.lat]).addTo(mlMap);
      mlMarkers[p.id] = { marker, el, _lastStatus:p.status, _lastReporters:p.reporters };
      if (pinnedSponsorPlace && pinnedSponsorPlace.id === p.id) el.style.visibility = 'hidden';
      // Fade-in en vez de aparecer de golpe (ver .fc-entering en styles.css)
      requestAnimationFrame(() => el.classList.remove('fc-entering'));
      renderedNew++;
    });
    if (pending > 0) {
      const pct = Math.min(100, Math.round((renderedNew/pending)*100));
      showPlacesLoading(`Cargando cards de establecimientos… ${pct}%`);
    }
    if (i + BATCH < toRender.length) {
      const delay = i >= half ? 500 : 100;
      setTimeout(() => add(i+BATCH), delay);
    } else {
      hidePlacesLoading();
    }
  };
  requestAnimationFrame(() => add(0));
};
const computeClusters = (places, gridDeg) => {
  if (!gridDeg || gridDeg<=0) return [];
  const cells = {};
  places.forEach(p => {
    if (!validCoord(p.lat,p.lng)) return;
    const cx = Math.floor(p.lat/gridDeg), cy = Math.floor(p.lng/gridDeg), key = `${cx}:${cy}`;
    if (!cells[key]) cells[key] = { places: [] };
    cells[key].places.push(p);
  });
  return Object.values(cells).map(c => {
    const n = c.places.length;
    const avgLat = c.places.reduce((s,p) => s+p.lat, 0)/n;
    const avgLng = c.places.reduce((s,p) => s+p.lng, 0)/n;
    const total = c.places.reduce((s,p) => s+(p.reporters||0), 0);
    return { lat:avgLat, lng:avgLng, count:n, places:c.places, totalReporters:total };
  }).filter(c => validCoord(c.lat,c.lng));
};
const makeMarker = p => {
  const s = getStatus(p);
  const logo = (p.sponsor?.logo_url) ? `<img src="${p.sponsor.logo_url}" alt="${p.name}">` : (p.logo || '🏪');
  const ver = p.verified ? `<div class="fc-card-verified">✓</div>` : '';
  const isPremium = p.sponsor?.tier === 'premium';
  const isBlack = p.sponsor?.tier === 'black';
  const el = document.createElement('div');
  el.className = 'fc-card-wrap' + (isPremium ? ' is-sponsor' : '') + (isBlack ? ' is-sponsor is-sponsor-black' : '');
  if (isBlack) {
    el.style.setProperty('--sponsor-color', SPONSOR_BLACK_ACCENT);
    el.style.setProperty('--sponsor-bg', SPONSOR_BLACK);
    // Fallback inline por si el CSS global todavía no tiene la clase .is-sponsor-black definida:
    el.style.filter = 'drop-shadow(0 2px 10px rgba(212,175,55,.35))';
  } else if (isPremium) el.style.setProperty('--sponsor-color', SPONSOR_GOLD);
  else if (p.sponsor?.badge_color) el.style.setProperty('--sponsor-color', p.sponsor.badge_color);
  el.innerHTML = `
    <div class="fc-card"${isBlack ? ' style="background:linear-gradient(180deg,#1a1a1d,#0a0a0c);border-color:rgba(212,175,55,.45);"' : ''}>
      <div class="fc-card-head">
        <div class="fc-card-logo">${logo}${ver}</div>
        <div class="fc-card-info"><div class="fc-card-name"${isBlack ? ' style="color:#F5F0E6;"' : ''}>${p.name}</div><div class="fc-card-type"${isBlack ? ' style="color:#9A9384;"' : ''}>${p.type}</div></div>
        <span class="fc-card-open ${p.open?'open':'closed'}">${p.open?'Abierto':'Cerrado'}</span>
      </div>
      <div class="fc-card-status" style="background:${s.color}"><div class="s-dot-sm"></div><div class="s-label-sm">${s.label}</div></div>
    </div>
    <div class="fc-tail"></div><div class="fc-base"></div>
  `;
  return el;
};
const makeCluster = c => {
  const dc = density(c.count);
  const label = c.count === 1 ? '1 lugar' : `${c.count} lugares`;
  const sub = c.totalReporters > 0 ? `${c.totalReporters} reportes activos` : 'Sin reportes aún';
  const el = document.createElement('div');
  el.className = 'cluster-card';
  el.innerHTML = `
    <div class="cluster-bubble ${dc}"><div class="cluster-count">${c.count}</div><div class="cluster-label"><strong>${label}</strong>${sub}</div></div>
    <div class="cluster-tail"></div><div class="cluster-base"></div>
  `;
  return el;
};
const clearClusterMarkers = () => { mlClusterMarkers.forEach(m=>m.remove()); mlClusterMarkers=[]; };
const clearPlaceMarkers = () => { Object.values(mlMarkers).forEach(({marker}) => marker.remove()); mlMarkers={}; };
const refreshMarker = id => {
  const p = placeStore[id]; if (!p || !mlMarkers[id]) return;
  const m = mlMarkers[id];
  const s = getStatus(p);
  const el = m.el.querySelector('.fc-card-status');
  if (el) { el.style.background = s.color; const lbl = el.querySelector('.s-label-sm'); if (lbl) lbl.textContent = s.label; }
  m._lastStatus = p.status; m._lastReporters = p.reporters;
};
const updateUserMarker = (lat,lng) => {
  if (!mlMap || !mlReady || !validCoord(lat,lng)) return;
  if (mlUserMarker) { safeMove(() => mlUserMarker.setLngLat([lng,lat])); }
  else {
    const el = document.createElement('div');
    el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#6366F1;border:3px solid #fff;box-shadow:0 0 0 4px rgba(99,102,241,.35);';
    mlUserMarker = new maplibregl.Marker({ element:el, pitchAlignment:'map' }).setLngLat([lng,lat]).addTo(mlMap);
  }
};

// ============================================================
// BUSCADOR (compartido entre el mapa y la lista "Cerca" — mismo componente y misma lógica)
// ============================================================
const SEARCH_INSTANCES = [
  { inputId:'map-search-input', dropdownId:'search-results-dropdown', wrapId:'map-search-wrap', clearId:'map-search-clear', pool:'map' },
  { inputId:'cerca-search-input', dropdownId:'cerca-search-results-dropdown', wrapId:'cerca-search-wrap', clearId:'cerca-search-clear', pool:'cerca' },
];
const initSearch = () => {
  SEARCH_INSTANCES.forEach(cfg => {
    const input = document.getElementById(cfg.inputId);
    const dropdown = document.getElementById(cfg.dropdownId);
    const wrap = document.getElementById(cfg.wrapId);
    if (!input || !dropdown || !wrap) {
      console.warn('[initSearch] Elementos del buscador no encontrados, se omite inicialización', cfg.inputId);
      return;
    }
    input.addEventListener('input', e => onSearch(e, cfg));
    input.addEventListener('focus', () => { if (input.value.length>1) dropdown.classList.add('open'); });
    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) dropdown.classList.remove('open');
    });
  });
};
let _searchTimer = null;
const onSearch = (e, cfg) => {
  const val = e.target.value.trim();
  const clearBtn = document.getElementById(cfg.clearId);
  if (clearBtn) clearBtn.classList.toggle('visible', val.length>0);
  // La lista "Cerca" además re-filtra el listado agrupado de abajo con el mismo texto
  if (cfg.inputId === 'cerca-search-input') { cercaSearchQ = val; cercaApplyFilters(); }
  const dropdown = document.getElementById(cfg.dropdownId);
  if (!dropdown) return;
  if (val.length < 2) { dropdown.classList.remove('open'); return; }
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => runSearch(val, cfg), 380);
};
const runSearch = async (q, cfg) => {
  const drop = document.getElementById(cfg.dropdownId);
  if (!drop) return;
  try {
    drop.innerHTML = `<div class="search-loading"><div class="search-spinner"></div>Buscando lugares…</div>`;
    drop.classList.add('open');

    const nq = normTxt(q);
    // La lista "Cerca" ya tiene su propia fuente resuelta (cercaAllPlaces) — se usa esa primero
    // para no depender de que el mapa haya cargado placeStore todavía.
    let pool = (cfg.pool === 'cerca' && cercaAllPlaces.length) ? cercaAllPlaces : Object.values(placeStore);

    const results = pool.filter(p => normTxt(p.name).includes(nq) || normTxt(p.type).includes(nq)).slice(0,8);
    if (!results.length) { drop.innerHTML = `<div class="search-empty">😕 No encontramos "${q}" cerca.</div>`; return; }
    drop.innerHTML = results.map((p,i) => {
      const d = userLat != null ? fmtDist(dist(userLat,userLng,p.lat,p.lng)) : '';
      const s = getStatus(p);
      return `<div class="search-result-item" data-idx="${i}"><div class="search-result-logo">${p.logo||'🏪'}</div><div class="search-result-info"><div class="search-result-name">${p.name}</div><div class="search-result-sub">${p.type}${d ? ' · '+d : ''}</div></div><div class="search-result-status" style="background:${s.color}">${s.label}</div></div>`;
    }).join('');
    drop.querySelectorAll('.search-result-item').forEach((el,i) => {
      el.addEventListener('click', () => {
        vibrate(10);
        drop.classList.remove('open');
        const input = document.getElementById(cfg.inputId);
        if (input) input.blur();
        const p = results[i];
        if (p) openPopup(p);
        if (p && mlMap && validCoord(p.lat,p.lng)) safeMove(() => mlMap.flyTo({ center:[p.lng,p.lat], zoom:18, duration:500 }));
      });
    });
  } catch (e) {
    console.warn('[runSearch]', e);
    drop.innerHTML = `<div class="search-empty">😕 No encontramos "${q}" cerca.</div>`;
  }
};

// ============================================================
// REACT POPUP (resumido - igual que antes)
// ============================================================
const PHOTOS = {
  default: 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=400&q=70&fm=webp',
  Supermercado: 'https://images.unsplash.com/photo-1604719312566-8912e9c8a213?w=400&q=70&fm=webp',
  Farmacia: 'https://images.unsplash.com/photo-1631549916768-4119b2e5f926?w=400&q=70&fm=webp',
  Banco: 'https://images.unsplash.com/photo-1601597111158-2fceff292cdc?w=400&q=70&fm=webp',
  Panadería: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&q=70&fm=webp',
  'Comida rápida': 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=70&fm=webp',
  Restaurante: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=400&q=70&fm=webp',
  Hospital: 'https://images.unsplash.com/photo-1587351021759-3e566b6af7cc?w=400&q=70&fm=webp',
};
const getPhoto = p => p.sponsor?.photo_url || p.photo || PHOTOS[p.type] || PHOTOS.default;
const getLogoHtml = p => p.sponsor?.logo_url
  ? `<img src="${escAttr(p.sponsor.logo_url)}" alt="${escAttr(p.name)}" style="width:100%;height:100%;object-fit:contain;border-radius:10px;">`
  : escHtml(p.logo || '🏪');
const canReportPlace = p => userLat!=null && userLng!=null && dist(userLat,userLng,p.lat,p.lng) <= CONFIG.REPORT_RADIUS_M;
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const escAttr = escHtml;

// ============================================================
// POPUP DE REPORTE (vanilla JS — antes era un componente React;
// se reescribió a mano para no depender de React/ReactDOM por CDN,
// que solo se usaban para este popup y pesaban ~130KB sin necesidad).
//
// Estado del popup vive en `pp` (una sola instancia a la vez). El
// overlay y la card son nodos DOM persistentes durante la vida del
// popup (se crean una sola vez en ppOpen) para que las transiciones
// CSS de fade/scale animen correctamente; el header (con la foto) y
// el body (stats/botones) se re-renderizan por separado para que un
// tick del cooldown (cada 1s) no reconstruya la imagen y la haga
// parpadear.
// ============================================================
let pp = null; // { place, visible, cardVisible, selected, submitted, cooldownMs, imgLoaded, cooldownTimer }

const ppComputed = () => {
  const place = pp.place;
  const s = getStatus(place);
  const sponsor = place.sponsor || null;
  const isPremium = sponsor?.tier === 'premium';
  const isBlack = sponsor?.tier === 'black';
  const sponsorColor = isBlack ? SPONSOR_BLACK_ACCENT : (isPremium ? SPONSOR_GOLD : (sponsor?.badge_color || '#6366F1'));
  const badgeText = sponsor?.badge_text || (isBlack ? 'Black' : null);
  const promo = sponsor?.promo || null;
  const website = sponsor?.website || null;
  const T = isBlack ? {
    cardBg: `linear-gradient(180deg, #1a1a1d 0%, #0a0a0c 55%)`,
    statBg: `rgba(212,175,55,0.08)`, statBorder: `1px solid rgba(212,175,55,0.35)`,
    text: '#F5F0E6', text2: '#C9C2B4', text3: '#9A9384',
    btnBg: '#151517', btnBorder: 'rgba(212,175,55,0.4)', pad: '13px 14px 16px',
  } : isPremium ? {
    cardBg: `linear-gradient(180deg, color-mix(in srgb, ${sponsorColor} 14%, #fff) 0%, rgba(29,29,29) 48%)`,
    statBg: `#0F0F11`, statBorder: `1px solid rgba(255,255,255,0.08)`,
    text: '#fff', text2: '#475569', text3: '#64748B',
    btnBg: '#fff', btnBorder: '#E2E8F0', pad: '13px 14px 16px',
  } : null;
  const onCooldown = pp.cooldownMs > 0 && !pp.submitted;
  const nearby = canReportPlace(place);
  const hasGps = userLat != null && userLng != null;
  const distTo = hasGps ? Math.round(dist(userLat, userLng, place.lat, place.lng)) : null;
  return { place, s, sponsor, isPremium, isBlack, sponsorColor, badgeText, promo, website, T, onCooldown, nearby, hasGps, distTo };
};

const ppRenderHeader = () => {
  const { place, s, isBlack, sponsorColor, badgeText } = ppComputed();
  const photo = getPhoto(place);
  const header = document.getElementById('pp-header');
  if (!header) return;
  header.innerHTML = `
    <div style="position:relative;height:200px;flex-shrink:0;background:#E2E8F0;">
      <img id="pp-img" src="${escAttr(photo)}" alt="${escAttr(place.name)}" loading="lazy"
        style="width:100%;height:100%;object-fit:cover;display:block;opacity:${pp.imgLoaded?1:0};transition:opacity 0.4s ease;">
      ${badgeText ? `<div style="position:absolute;top:12px;right:52px;background:${isBlack ? 'linear-gradient(135deg,#0A0A0C,#1c1c20)' : sponsorColor};border:${isBlack ? `1px solid ${SPONSOR_BLACK_ACCENT}` : 'none'};border-radius:40px;padding:3px 9px;display:flex;align-items:center;gap:4px;box-shadow:0 2px 8px rgba(0,0,0,.25);">
        <span style="font-size:10px;font-weight:800;color:${isBlack ? SPONSOR_BLACK_ACCENT : '#fff'};letter-spacing:${isBlack?'.4px':'normal'};">${escHtml(badgeText)}</span>
      </div>` : ''}
      <div style="position:absolute;inset:0;background:linear-gradient(to bottom, rgba(0,0,0,0) 30%, rgba(0,0,0,0.68) 100%);"></div>
      <button id="pp-close-btn" style="position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:50%;background:rgba(0,0,0,0.42);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;line-height:1;backdrop-filter:blur(8px);">✕</button>
      <div style="position:absolute;top:12px;left:12px;background:${s.color};border-radius:40px;padding:3px 9px;display:flex;align-items:center;gap:4px;">
        <span style="width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,0.55);display:inline-block;flex-shrink:0;"></span>
        <span style="font-size:10px;font-weight:800;color:#fff;">${escHtml(s.label)}</span>
      </div>
      <div style="position:absolute;bottom:12px;left:12px;right:12px;display:flex;align-items:flex-end;gap:10px;">
        <div style="position:relative;flex-shrink:0;">
          <div style="width:44px;height:44px;border-radius:14px;background:#fff;border:2.5px solid rgba(255,255,255,0.9);display:flex;align-items:center;justify-content:center;font-size:22px;overflow:hidden;">${getLogoHtml(place)}</div>
          ${place.verified ? `<div style="position:absolute;bottom:-3px;right:-3px;width:16px;height:16px;background:linear-gradient(135deg, ${sponsorColor}, color-mix(in srgb, ${sponsorColor} 55%, #fff));border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:7px;color:#fff;font-weight:900;">✓</div>` : ''}
        </div>
        <div style="flex:1;min-width:0;">
          <p style="margin:0;font-size:15px;font-weight:800;color:#fff;line-height:1.2;text-shadow:0 1px 6px rgba(0,0,0,0.5);">${escHtml(place.name)}</p>
          <p style="margin:2px 0 0;font-size:11px;color:rgba(255,255,255,0.82);text-shadow:0 1px 4px rgba(0,0,0,0.4);">${escHtml(place.type)} · ${escHtml(place.addr)}</p>
        </div>
        <div style="display:flex;align-items:center;gap:3px;background:rgba(255,255,255,0.18);backdrop-filter:blur(8px);border:0.5px solid rgba(255,255,255,0.3);border-radius:40px;padding:3px 8px;flex-shrink:0;">
          <span style="color:#F59E0B;font-size:11px;">★</span>
          <span style="font-size:11px;font-weight:800;color:#fff;">${place.rating}</span>
          <span style="font-size:10px;color:rgba(255,255,255,0.7);"> · ${place.reviewsN}</span>
        </div>
      </div>
    </div>`;
  const img = document.getElementById('pp-img');
  if (img) {
    img.addEventListener('load', () => { pp.imgLoaded = true; img.style.opacity = 1; }, { once: true });
    img.addEventListener('error', e => { const fb = PHOTOS[place.type] || PHOTOS.default; if (e.target.src !== fb) e.target.src = fb; }, { once: true });
  }
  const closeBtn = document.getElementById('pp-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', ppClose);
};

const ppRenderBody = () => {
  const { place, sponsor, isBlack, sponsorColor, promo, website, T, onCooldown, nearby, hasGps, distTo } = ppComputed();
  const { selected, submitted, cooldownMs } = pp;
  const body = document.getElementById('pp-body');
  if (!body) return;

  const notLogHtml = (!isLoggedIn && !onCooldown) ? `
    <div style="display:flex;align-items:center;gap:10px;background:#F0FDF9;border:1px solid #A8EDD8;border-radius:12px;padding:10px 12px;margin-bottom:12px;">
      <span style="font-size:20px;flex-shrink:0;">🔑</span>
      <div style="flex:1;">
        <p style="margin:0;font-size:13px;font-weight:800;color:#007A59;">Iniciá sesión para reportar</p>
        <p style="margin:2px 0 0;font-size:12px;color:#047857;">Ganás puntos por cada reporte.</p>
      </div>
      <button id="pp-login-btn" style="background:linear-gradient(135deg,#00C48C,#009E72);color:#fff;border:none;border-radius:40px;padding:6px 12px;font-size:12px;font-weight:800;cursor:pointer;white-space:nowrap;font-family:inherit;">Ingresar</button>
    </div>` : '';

  const tooFarHtml = (hasGps && !nearby && !onCooldown) ? `
    <div style="display:flex;align-items:center;gap:10px;background:${T ? '#151517' : '#F1F5F9'};border:${T ? '1px solid rgba(212,175,55,.25)' : '1px solid #E2E8F0'};border-radius:12px;padding:10px 12px;margin-bottom:12px;">
      <span style="font-size:20px;flex-shrink:0;">📍</span>
      <div>
        <p style="margin:0;font-size:13px;font-weight:800;color:${T ? T.text : '#'};">Estás a ${distTo}m de este comercio</p>
        <p style="margin:2px 0 0;font-size:12px;color:${T ? T.text3 : '#64748B'};">Necesitás estar a menos de ${CONFIG.REPORT_RADIUS_M}m para reportar.</p>
      </div>
    </div>` : '';

  const noGpsHtml = (!hasGps && !onCooldown) ? `
    <div style="display:flex;align-items:center;gap:10px;background:#EEF2FF;border:1px solid #C7D2FE;border-radius:12px;padding:10px 12px;margin-bottom:12px;">
      <span style="font-size:20px;flex-shrink:0;">🛰️</span>
      <div>
        <p style="margin:0;font-size:13px;font-weight:800;color:#3730A3;">Activá tu ubicación para reportar</p>
        <p style="margin:2px 0 0;font-size:12px;color:#4338CA;">Solo podés reportar si estás físicamente dentro del comercio.</p>
      </div>
    </div>` : '';

  const nearOkHtml = (isLoggedIn && nearby && !onCooldown) ? `
    <div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;padding:7px 10px;background:#E8FBF5;border-radius:10px;border:1px solid #A8EDD8;">
      <span style="font-size:14px;">✅</span>
      <span style="font-size:12px;font-weight:700;color:#007A59;">Estás a ${distTo ?? '?'}m · podés reportar</span>
    </div>` : '';

  const cooldownHtml = onCooldown ? `
    <div style="display:flex;align-items:center;gap:10px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;padding:10px 12px;margin-bottom:10px;">
      <span style="font-size:20px;flex-shrink:0;">⏳</span>
      <div>
        <p style="margin:0;font-size:13px;font-weight:800;color:#92400E;">Ya reportaste ${escHtml(place.name)} hace poco</p>
        <p style="margin:2px 0 0;font-size:12px;color:#92400E;">Podés volver a reportar en ${fmtCooldown(cooldownMs)}</p>
      </div>
    </div>` : '';

  const voteOptions = [
    { idx: 0, label: 'Poca gente', pts: '+10', color: '#00C48C' },
    { idx: 1, label: 'Bastante', pts: '+10', color: '#F59E0B' },
    { idx: 2, label: 'Mucha gente', pts: '+15', color: '#F97316' },
    { idx: 3, label: 'Colapsado', pts: '+20', color: '#EF4444' },
  ];
  const votesHtml = (!submitted && isLoggedIn && nearby && !onCooldown) ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;">
      ${voteOptions.map(({idx,label,pts,color}) => {
        const isSel = selected === idx;
        return `<button class="pp-vote-btn" data-idx="${idx}" style="border:${isSel ? `2px solid ${color}` : (T ? `1.5px solid ${T.btnBorder}` : '1.5px solid #E2E8F0')};border-radius:10px;background:${isSel ? color : (T ? T.btnBg : '#fff')};padding:9px 8px;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:${isSel ? '#fff' : (T ? T.text : '#000')};text-align:left;font-family:inherit;transition:all 0.18s cubic-bezier(0.34,1.56,0.64,1);transform:${isSel ? 'translateY(-1px)' : 'none'};box-shadow:${isSel ? `0 4px 12px ${color}44` : 'none'};">
          <span style="width:8px;height:8px;border-radius:50%;background:${isSel ? 'rgba(255,255,255,0.55)' : color};display:inline-block;flex-shrink:0;"></span>
          ${escHtml(label)}
          <span style="margin-left:auto;font-size:9px;font-weight:800;color:#fff;background:${color};padding:1px 6px;border-radius:40px;">${pts}</span>
        </button>`;
      }).join('')}
    </div>` : '';

  const submittedHtml = submitted ? `
    <div style="display:flex;align-items:center;gap:10px;background:#E8FBF5;border:1px solid #A8EDD8;border-radius:12px;padding:11px 12px;margin-bottom:10px;">
      <span style="font-size:20px;">✅</span>
      <div>
        <p style="margin:0;font-size:13px;font-weight:800;color:#007A59;">¡Reporte enviado!</p>
        <p style="margin:2px 0 0;font-size:11px;color:#047857;">+${VOTE_PTS[selected] || 10} puntos sumados</p>
      </div>
    </div>` : '';

  const submitBtnHtml = (!submitted && isLoggedIn && nearby && !onCooldown) ? `
    <button id="pp-submit-btn" ${selected == null ? 'disabled' : ''} style="width:100%;background:${selected != null ? `linear-gradient(135deg, ${STATUS_CFG[selected].color}, ${STATUS_CFG[selected].color}cc)` : (T ? T.btnBg : '#E2E8F0')};color:${selected != null ? '#fff' : (T ? T.text3 : '#94A3B8')};border:none;border-radius:12px;padding:12px;font-size:13px;font-weight:800;cursor:${selected != null ? 'pointer' : 'not-allowed'};display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;transition:all 0.22s;box-shadow:${selected != null ? `0 6px 20px ${STATUS_CFG[selected].color}44` : 'none'};transform:${selected != null ? 'translateY(-1px)' : 'none'};">Reportar estado</button>` : '';

  const websiteHtml = website ? `
    <a href="${escAttr(website)}" target="_blank" rel="noopener noreferrer" style="display:block;margin-top:10px;font-size:11.5px;font-weight:800;color:${isBlack ? SPONSOR_BLACK_ACCENT : BRAND_GREEN};text-align:center;text-decoration:none;border:1.5px solid ${isBlack ? SPONSOR_BLACK_ACCENT : BRAND_GREEN};border-radius:40px;padding:9px 14px;background:${isBlack ? 'rgba(212,175,55,0.08)' : `${BRAND_GREEN}0D`};letter-spacing:.2px;">${escHtml(website.replace(/^https?:\/\//,'').replace(/\/$/,''))}</a>` : '';

  body.innerHTML = `
    <div style="padding:${T ? T.pad : '14px 14px 16px'};">
      <div style="display:flex;gap:6px;margin-bottom:12px;">
        ${[{val:place.reporters,lbl:'Reportes'}, {val:WAIT[place.status],lbl:'Espera'}, {val:TREND[place.status],lbl:'Tendencia'}].map(({val,lbl}) => `
          <div style="flex:1;background:${T ? T.statBg : '#F1F5F9'};border:${T ? T.statBorder : 'none'};border-radius:9px;padding:6px 8px;text-align:center;">
            <p style="margin:0;font-size:13px;font-weight:600;color:${T ? T.text : '#0F172A'};letter-spacing:-0.2px;">${val}</p>
            <p style="margin:1px 0 0;font-size:8px;color:${T ? T.text3 : '#64748B'};text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">${lbl}</p>
          </div>`).join('')}
      </div>
      ${promo ? `<div style="display:flex;align-items:center;gap:8px;background:${T ? `color-mix(in srgb, ${sponsorColor} 14%, transparent)` : `${sponsorColor}14`};border:1px solid ${sponsorColor}44;border-radius:10px;padding:8px 10px;margin-bottom:10px;">
        <span style="font-size:16px;flex-shrink:0;">🎁</span>
        <span style="font-size:12px;font-weight:800;color:${sponsorColor};">${escHtml(promo)}</span>
      </div>` : ''}
      ${notLogHtml}${tooFarHtml}${noGpsHtml}${nearOkHtml}${cooldownHtml}${votesHtml}${submittedHtml}${submitBtnHtml}
      <p style="margin:8px 0 0;font-size:10px;color:${T ? T.text3 : '#94A3B8'};display:flex;align-items:center;gap:4px;font-weight:500;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;flex-shrink:0;">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>
        ${place.reporters} reportes en las últimas 2h
      </p>
      ${websiteHtml}
    </div>`;

  const loginBtn = document.getElementById('pp-login-btn');
  if (loginBtn) loginBtn.addEventListener('click', () => doGoogleLogin(document.getElementById('login-topbar-btn')));
  body.querySelectorAll('.pp-vote-btn').forEach(btn => {
    btn.addEventListener('click', () => ppHandleVote(parseInt(btn.dataset.idx, 10)));
  });
  const submitBtn = document.getElementById('pp-submit-btn');
  if (submitBtn) submitBtn.addEventListener('click', ppHandleSubmit);
};

const ppHandleVote = idx => {
  const { onCooldown, nearby } = ppComputed();
  if (pp.submitted || onCooldown || !nearby) return;
  if (!isLoggedIn) { showToastAction('🔑 Iniciá sesión para reportar'); return; }
  vibrate(8);
  pp.selected = idx;
  ppRenderBody();
};

const ppHandleSubmit = async () => {
  const { onCooldown, nearby } = ppComputed();
  if (pp.selected == null || pp.submitted || onCooldown || !nearby) return;
  if (!isLoggedIn) { showToastAction('🔑 Iniciá sesión para reportar'); return; }
  const place = pp.place;
  pp.submitted = true;
  ppRenderBody();
  vibrate(15);
  applyCooldown(place.id);
  place.status = pp.selected;
  place.reporters = (place.reporters || 0) + 1;
  place.report_ts = Date.now();
  placeStore[place.id] = place;
  refreshMarker(place.id);
  if (currentPopupPlace && currentPopupPlace.id === place.id) Object.assign(currentPopupPlace, place);
  if (document.getElementById('panel-cerca').classList.contains('visible')) cercaApplyFilters();

  const ok = await submitVote(place, pp.selected);
  if (ok) {
    flashPoints();
    pp.cooldownMs = getCooldown(place.id);
    ppStartCooldownTimer();
    ppRenderBody();
  }
  setTimeout(ppClose, 900);
};

const ppStartCooldownTimer = () => {
  if (pp.cooldownTimer) clearInterval(pp.cooldownTimer);
  if (pp.cooldownMs <= 0) return;
  pp.cooldownTimer = setInterval(() => {
    if (!pp) return;
    pp.cooldownMs = Math.max(0, pp.cooldownMs - 1000);
    ppRenderBody();
    if (pp.cooldownMs <= 0) { clearInterval(pp.cooldownTimer); pp.cooldownTimer = null; }
  }, 1000);
};

const openPopup = place => {
  currentPopupPlace = place;
  pp = { place, visible: false, cardVisible: false, selected: null, submitted: false, cooldownMs: getCooldown(place.id), imgLoaded: false, cooldownTimer: null };

  const container = document.getElementById('react-popup-root');
  container.classList.add('active');
  container.innerHTML = `
    <div id="pp-overlay" style="position:fixed;inset:0;background:rgba(15,23,42,0);backdrop-filter:blur(0px);-webkit-backdrop-filter:blur(0px);display:flex;align-items:center;justify-content:center;transition:background 0.3s ease, backdrop-filter 0.3s ease;z-index:10000;padding:20px;">
      <div id="pp-card" style="width:100%;max-width:370px;border-radius:22px;overflow:hidden;transform:translateY(40px) scale(0.93);opacity:0;transition:transform 0.38s cubic-bezier(0.34,1.56,0.64,1), opacity 0.28s ease;max-height:calc(100dvh - 40px);display:flex;flex-direction:column;">
        <div style="overflow-y:auto;-ms-overflow-style:none;scrollbar-width:none;">
          <div id="pp-header"></div>
          <div id="pp-body"></div>
        </div>
      </div>
    </div>`;

  ppApplyCardTheme();
  ppRenderHeader();
  ppRenderBody();
  ppStartCooldownTimer();

  const overlay = document.getElementById('pp-overlay');
  overlay.addEventListener('click', e => { if (e.target === overlay) ppClose(); });

  requestAnimationFrame(() => {
    pp.visible = true;
    overlay.style.background = 'rgba(15,23,42,.62)';
    overlay.style.backdropFilter = 'blur(6px)';
    overlay.style.webkitBackdropFilter = 'blur(6px)';
    setTimeout(() => {
      if (!pp) return;
      pp.cardVisible = true;
      const card = document.getElementById('pp-card');
      if (card) { card.style.transform = 'translateY(0) scale(1)'; card.style.opacity = 1; }
    }, 40);
  });
};

// Aplica el fondo/sombra de la card según el sponsor (esto no cambia
// con el estado del popup, solo con los datos del place).
const ppApplyCardTheme = () => {
  if (!pp) return;
  const { sponsor, isPremium, isBlack, sponsorColor, T } = ppComputed();
  const card = document.getElementById('pp-card');
  if (!card) return;
  card.style.background = T ? T.cardBg : '#fff';
  card.style.boxShadow = (isPremium || isBlack)
  ? '0 24px 64px rgba(0,0,0,0.22)'
  : (sponsor
      ? '0 24px 64px rgba(0,0,0,0.28)'
      : '0 24px 64px rgba(0,0,0,0.28)');
};

const ppClose = () => {
  if (!pp) return;
  if (pp.cooldownTimer) clearInterval(pp.cooldownTimer);
  pp.cardVisible = false; pp.visible = false;
  const overlay = document.getElementById('pp-overlay');
  const card = document.getElementById('pp-card');
  if (card) { card.style.transform = 'translateY(40px) scale(0.93)'; card.style.opacity = 0; }
  if (overlay) { overlay.style.background = 'rgba(15,23,42,0)'; overlay.style.backdropFilter = 'blur(0px)'; overlay.style.webkitBackdropFilter = 'blur(0px)'; }
  setTimeout(closePopup, 320);
};

const closePopup = () => {
  const container = document.getElementById('react-popup-root');
  container.classList.remove('active');
  container.innerHTML = '';
  if (pp?.cooldownTimer) clearInterval(pp.cooldownTimer);
  pp = null;
  currentPopupPlace = null;
};


const submitVote = async (place, statusIdx) => {
  const pts = VOTE_PTS[statusIdx];
  const res = await apiPost('vote', {
    place: { id:place.id, name:place.name, type:place.type, addr:place.addr, lat:place.lat, lng:place.lng, logo:place.logo, rating:place.rating, reviewsN:place.reviewsN, verified:!!place.verified, open:place.open !== false },
    status: statusIdx,
    email: currentUser?.email,
  });
  if (res?.cooldown) {
    applyCooldown(place.id);
    showToast(`⏳ Ya reportaste ${place.name}`);
    return false;
  }
  if (res && typeof res.points === 'number') {
    userPts = res.points;
    updateHUD();
    flashPoints();
    showToast(`🎉 +${pts} puntos ganados`);
    return true;
  }
  addPoints(pts);
  showToast(`🎉 +${pts} ganados`);
  return true;
};

// ============================================================
// CERCA (resumido - igual que antes)
// ============================================================
const cercaLoadPlaces = async () => {
  // "Ticket" de esta carga: si el usuario cambia de radio antes de que esto termine,
  // cercaReqId avanza y esta carga se descarta en vez de pisar los resultados nuevos.
  const myReq = ++cercaReqId;
  const radiusAtStart = cercaRadius;
  const lat = userLat ?? CONFIG.DEFAULT_CENTER.lat;
  const lng = userLng ?? CONFIG.DEFAULT_CENTER.lng;

  // 1. Si ya teníamos datos cargados para este radio, mostrarlos de una.
  //    Si no, arrancamos vacío mientras se busca de verdad (solo datos reales).
  const cached = cercaCache[radiusAtStart];
  cercaLoading = !cached;
  cercaAllPlaces = cached ? cached.places : [];
  cercaApplyFilters();
  const _updLbl1 = document.getElementById('cerca-updated-lbl');
  if (_updLbl1) _updLbl1.textContent = cached ? `Actualizado ${cached.label}` : 'Actualizado ahora';
  if (cercaLoading) showPlacesLoading('Cargando establecimientos…', 'cerca-loading-pill', 'cerca-loading-text');

  // 2. Cargar reales en segundo plano.
  //    Mismo criterio que _loadPlaces(): Supabase/PostGIS primero (UNA
  //    sola query rápida contra lo ya importado con import-places.js),
  //    y solo si ahí tampoco hay suficiente densidad, recién ahí se va
  //    a buscar en vivo a Overpass/Geoapify — que es la parte que tarda
  //    los 4-10s, porque son requests a APIs externas desde el navegador.
  const MIN_LOCAL_RESULTS = 5;
  let data = Object.values(placeStore)
    .filter(p => validCoord(p.lat,p.lng) && dist(lat,lng,p.lat,p.lng) <= radiusAtStart)
    .map(p => ({ ...p, dist: Math.round(dist(lat,lng,p.lat,p.lng)), cat: p.cat || guessCat(p.name,p.type) }));

  if (data.length < MIN_LOCAL_RESULTS && BACKEND_READY) {
    try {
      const backendFull = await apiGet('sync_places', { lat, lng, radius: radiusAtStart });
      if (myReq !== cercaReqId) return; // idem: descartar si ya no es la carga vigente
      if (backendFull?.places?.length) {
        backendFull.places.forEach(p => { placeStore[p.id] = p; });
        data = Object.values(placeStore)
          .filter(p => validCoord(p.lat,p.lng) && dist(lat,lng,p.lat,p.lng) <= radiusAtStart)
          .map(p => ({ ...p, dist: Math.round(dist(lat,lng,p.lat,p.lng)), cat: p.cat || guessCat(p.name,p.type) }));
      }
    } catch (e) {
      console.warn('[cercaLoadPlaces] sync_places falló, sigue a Overpass/Geoapify', e);
    }
  }

  if (data.length < 3) {
    const fetched = await searchPlaces(lat, lng, radiusAtStart);
    data = fetched.map(p => ({ ...p, dist: Math.round(dist(lat,lng,p.lat,p.lng)), cat: p.cat || guessCat(p.name,p.type) }));
  }
  if (myReq !== cercaReqId) return; // el radio cambió mientras esperábamos: descartar, ya hay una carga más nueva en curso

  if (data.length > 0) {
    // Reemplazar caché por reales (los reales van arriba)
    cercaAllPlaces = data;
  }
  // Si no hay reales, la lista queda vacía (se muestra el estado "sin resultados")
  cercaLoading = false;
  hidePlacesLoading(200, 'cerca-loading-pill');

  // Sincronizar con backend (actualiza estados)
  if (BACKEND_READY) {
    const backend = await apiGet('sync_places', {lat,lng,radius:radiusAtStart,status_only:1});
    if (myReq !== cercaReqId) return; // idem: descartar si ya no es la carga vigente
    if (backend?.places) {
      const bm = new Map(backend.places.map(p=>[p.id,p]));
      cercaAllPlaces = cercaAllPlaces.map(p => {
        const bp = bm.get(p.id);
        return bp ? {...p, status: bp.status??p.status, reporters: bp.reporters??p.reporters} : p;
      });
    }
  }

  cercaLoaded = true;
  const now = new Date();
  const label = `${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;
  cercaCache[radiusAtStart] = { places: cercaAllPlaces, label };
  const _updLbl2 = document.getElementById('cerca-updated-lbl'); if (_updLbl2) _updLbl2.textContent = `Actualizado ${label}`;
  cercaApplyFilters();
};
const guessCat = (name,type) => {
  const l = (name+' '+type).toLowerCase();
  if (l.includes('restaurant')||l.includes('cafe')||l.includes('comida')||l.includes('panadería')||l.includes('bar')) return 'food';
  if (l.includes('farmacia')||l.includes('hospital')||l.includes('clínica')||l.includes('médico')||l.includes('veterinaria')||l.includes('óptica')) return 'health';
  if (l.includes('super')||l.includes('mercado')||l.includes('carrefour')||l.includes('coto')) return 'supermarket';
  if (l.includes('banco')||l.includes('cajero')||l.includes('atm')) return 'bank';
  if (l.includes('gobierno')||l.includes('municipal')||l.includes('correo')||l.includes('anses')) return 'government';
  return 'shopping';
};
const cercaShowSkeleton = (count = 6) => {
  // Cards "fantasma" que se muestran al instante (0ms) mientras se
  // resuelven las reales (Overpass/backend puede tardar 4-10s). Usan
  // el CSS .nc-skeleton / .skel-anim que ya estaba en index.html.
  const list = document.getElementById('cerca-list');
  if (!list) return;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<div class="nc-skeleton" style="animation-delay:${Math.min(i*0.04,0.2)}s;">
      <div class="nc-skel-logo skel-anim"></div>
      <div class="nc-skel-body">
        <div class="nc-skel-line skel-anim" style="width:${55 + (i%3)*10}%;"></div>
        <div class="nc-skel-line skel-anim" style="width:${30 + (i%4)*8}%;height:8px;"></div>
        <div class="nc-skel-block skel-anim" style="width:100%;"></div>
      </div>
    </div>`;
  }
  list.innerHTML = html;
};
const cercaApplyFilters = () => {
  let list = [...cercaAllPlaces];
  if (cercaCat !== 'all') list = list.filter(p => p.cat === cercaCat);
  if (cercaSearchQ) {
    const q = normTxt(cercaSearchQ);
    list = list.filter(p => normTxt(p.name).includes(q) || normTxt(p.type).includes(q) || normTxt(p.addr).includes(q));
  }
  if (cercaSortMode === 'distance') list.sort((a,b) => a.dist - b.dist);
  else if (cercaSortMode === 'status') list.sort((a,b) => b.reporters - a.reporters || b.status - a.status);
  else if (cercaSortMode === 'rating') list.sort((a,b) => parseFloat(b.rating) - parseFloat(a.rating));
  cercaFiltered = list;
  cercaRenderList();
};
const cercaRenderList = () => {
  const list = document.getElementById('cerca-list');
  const n = cercaFiltered.length;
  document.getElementById('cerca-count').textContent = n;
  document.getElementById('cerca-count-lbl').textContent = n === 1 ? ' lugar encontrado' : ' lugares encontrados';
  if (!n) {
    if (cercaLoading) {
      cercaShowSkeleton();
    } else {
      list.innerHTML = `<div class="nc-empty"><div class="nc-empty-icon">🔍</div><div class="nc-empty-title">Sin resultados</div><div class="nc-empty-sub">Probá aumentando el radio o cambiando el filtro.</div></div>`;
    }
    return;
  }
  const groups = {};
  cercaFiltered.forEach((p,i) => { const cat = p.cat || p.type || 'Otros'; if (!groups[cat]) groups[cat]=[]; groups[cat].push({p,i}); });
  let html = '', idx=0;
  Object.keys(groups).forEach(cat => {
    html += `<div class="nc-group"><div class="nc-group-title">${cat}</div>`;
    groups[cat].forEach(({p}) => {
      const s = getStatus(p);
      const logo = (p.sponsor?.logo_url) ? `<img src="${p.sponsor.logo_url}" alt="${p.name}">` : (p.logo || '🏪');
      const rev = typeof p.reviewsN === 'number' ? p.reviewsN.toLocaleString('es-AR') : p.reviewsN;
      const tier = p.sponsor?.tier;
      const isPremiumTier = tier === 'premium';
      const isBlackTier = tier === 'black';
      const isSponsor = isPremiumTier || isBlackTier;
      const sponsorStyle = isBlackTier ? `--sponsor-color:${SPONSOR_BLACK_ACCENT};` : (isPremiumTier ? `--sponsor-color:${SPONSOR_GOLD};` : '');
      const sponsorBadge = isSponsor && p.sponsor?.badge_text ? `<span class="nc-sponsor-badge${isBlackTier ? ' nc-sponsor-badge-black' : ''}"${isBlackTier ? ` style="background:linear-gradient(135deg,#0A0A0C,#1c1c20);color:${SPONSOR_BLACK_ACCENT};border:1px solid rgba(212,175,55,.5);"` : ''}>${p.sponsor.badge_text}</span>` : '';
      html += `<div class="nc-card${isSponsor ? ' is-sponsor' : ''}${isBlackTier ? ' is-sponsor-black' : ''}" data-place-id="${p.id}" style="animation-delay:${Math.min(idx*0.025,0.3)}s;${sponsorStyle}${isBlackTier ? 'background:linear-gradient(180deg,#1a1a1d,#0a0a0c);border-color:rgba(212,175,55,.35);' : ''}">
        <div class="nc-logo">${logo}</div>
        <div class="nc-body">
          <div class="nc-top"><div class="nc-name"${isBlackTier ? ' style="color:#F5F0E6;"' : ''}>${p.name}</div>${sponsorBadge}<span class="nc-badge-open ${p.open?'open':'closed'}">${p.open?'Abierto':'Cerrado'}</span></div>
          <div class="nc-meta"${isBlackTier ? ' style="color:#9A9384;"' : ''}><span class="nc-type">${p.type}</span><div class="nc-dot"></div><span class="nc-dist">📍 ${fmtDist(p.dist)}</span>${p.addr ? `<div class="nc-dot"></div><span class="nc-addr">${p.addr}</span>` : ''}</div>
          <div class="nc-status" style="background:${s.color}"><div class="nc-sdot"></div><span class="nc-slabel">${s.label}</span><span class="nc-ssub">${s.sub}</span></div>
        </div>
        <div class="nc-right">
          <div class="nc-rating"${isBlackTier ? ' style="color:#F5F0E6;"' : ''}><span class="nc-star">★</span>${p.rating}<span class="nc-rn">&nbsp;(${rev})</span></div>
          <button class="nc-report-btn" data-place-id="${p.id}">Reportar</button>
        </div>
      </div>`;
      idx++;
    });
    html += `</div>`;
  });
  list.innerHTML = html;
  list.querySelectorAll('.nc-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.classList.contains('nc-report-btn')) return;
      const id = card.dataset.placeId;
      const p = placeStore[id] || cercaFiltered.find(x=>x.id===id);
      if (!p) return;
      vibrate(10);
      selectPlaceInUI(id);
      openPopup(p);
      switchTab('map');
      if (mlMap && validCoord(p.lat,p.lng)) safeMove(() => mlMap.panTo([p.lng,p.lat]));
    });
    card.addEventListener('mouseenter', () => { const id = card.dataset.placeId; if (id) selectPlaceInUI(id); });
  });
  list.querySelectorAll('.nc-report-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.placeId;
      const p = placeStore[id] || cercaFiltered.find(x=>x.id===id);
      if (!p) return;
      vibrate(8);
      if (!isLoggedIn) { showToastAction('🔑 Iniciá sesión para reportar'); return; }
      selectPlaceInUI(id);
      openPopup(p);
    });
  });
};
const cercaSetRadius = (r, btn) => {
  vibrate(5);
  document.querySelectorAll('.cerca-r-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (r === cercaRadius && cercaLoaded) return; // ya está mostrando este radio, no recargar
  cercaRadius = r;
  cercaLoaded = false;
  cercaLoadPlaces();
};
const cercaSetCat = (cat, btn) => {
  vibrate(5);
  document.querySelectorAll('.cerca-f-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  cercaCat = cat;
  cercaApplyFilters();
};
const cercaCycleSort = () => {
  vibrate(5);
  const modes = ['distance','status','rating'], labels = ['Distancia','Más reportado','Rating'];
  cercaSortIdx = (cercaSortIdx+1)%3;
  cercaSortMode = modes[cercaSortIdx];
  document.getElementById('cerca-sort-lbl').textContent = labels[cercaSortIdx];
  cercaApplyFilters();
};
const selectPlaceInUI = id => {
  document.querySelectorAll('.nc-card.selected').forEach(c => c.classList.remove('selected'));
  const card = document.querySelector(`.nc-card[data-place-id="${id}"]`);
  if (card) card.classList.add('selected');
};

// ============================================================
// CHECK-IN
// ============================================================
const maybeCheckin = (lat,lng) => {
  if (document.querySelector('.checkin-overlay')) return;
  const pool = Object.values(placeStore).filter(p => validCoord(p.lat,p.lng) && dist(lat,lng,p.lat,p.lng) <= CONFIG.CHECKIN_RADIUS_M);
  if (!pool.length) return;
  const closest = pool.sort((a,b) => dist(lat,lng,a.lat,a.lng) - dist(lat,lng,b.lat,b.lng))[0];
  if (dist(lat,lng,closest.lat,closest.lng) > 20) return;
  const key = 'checkin_'+closest.id;
  const last = parseInt(sessionStorage.getItem(key)||'0');
  if (Date.now()-last < 5*60*1000) return;
  sessionStorage.setItem(key, Date.now());
  setTimeout(() => showCheckin(closest), 400);
};
const showCheckin = (place) => {
  const root = document.getElementById('checkin-overlay-root');
  const close = () => {
    const overlay = root.querySelector('.checkin-overlay');
    if (overlay) { overlay.style.opacity = '0'; overlay.style.transition = 'opacity .25s'; }
    setTimeout(() => { root.innerHTML = ''; }, 280);
  };
  const confirm = () => { close(); setTimeout(() => openPopup(place), 300); };
  root.innerHTML = `<div class="checkin-overlay"><div class="checkin-card"><div class="checkin-header"><div class="checkin-header-emoji">${place.logo||'📍'}</div><div class="checkin-header-title">¿Estás en ${place.name} en este momento?</div><div class="checkin-header-sub">${fmtDist(dist(userLat,userLng,place.lat,place.lng))} · podés reportar cuánta gente hay</div></div><div class="checkin-body"><div style="display:flex;flex-direction:column;gap:10px"><button class="checkin-confirm-btn">✅ Sí, estoy aquí — reportar</button><button class="checkin-skip-main"><span style="font-size:16px;opacity:.65">🗺️</span>No, solo ver el mapa</button></div></div></div></div>`;
  root.querySelector('.checkin-confirm-btn').addEventListener('click', confirm);
  root.querySelector('.checkin-skip-main').addEventListener('click', close);
  root.querySelector('.checkin-overlay').addEventListener('click', e => { if (e.target.classList.contains('checkin-overlay')) close(); });
};

// ============================================================
// GOOGLE OAUTH (vía Supabase Auth — reemplaza el flujo manual de GSI)
// ============================================================
const resetLoginBtn = () => {
  const btn = document.getElementById('login-topbar-btn');
  if (!btn) return;
  btn.classList.remove('is-loading');
  const t = btn.querySelector('.gbtn-txt'); if (t) t.textContent = 'Ingresar';
};
// doGoogleLogin ahora redirige a Google vía Supabase Auth (OAuth estándar,
// sin manejar tokens a mano). Al volver, onAuthChange (más abajo) hidrata
// la sesión — no hace falta handleGoogle ni fetch a userinfo.
const doGoogleLogin = btn => {
  if (isLoggedIn) return;
  if (!BACKEND_READY) { showToast('⚠️ Login no configurado'); return; }
  const loginBtn = btn || document.getElementById('login-topbar-btn');
  if (loginBtn) { loginBtn.classList.add('is-loading'); const t = loginBtn.querySelector('.gbtn-txt'); if (t) t.textContent = 'Conectando…'; }
  signInWithGoogle().catch(() => { resetLoginBtn(); showToast('⚠️ Error al iniciar sesión'); });
};
const toggleUserDropdown = () => {
  const wrap = document.getElementById('user-chip-wrap');
  const dd = document.getElementById('user-dropdown');
  dd.classList.toggle('open');
  wrap.classList.toggle('open');
};
const doLogout = () => {
  vibrate(10);
  isLoggedIn = false; currentUser = null; userPts = 0; placeCooldowns = {}; followMode = false; updateGpsUI();
  signOut();
  document.getElementById('user-chip-wrap').style.display = 'none';
  document.getElementById('login-topbar-btn').style.display = 'flex';
  document.getElementById('login-topbar-btn').classList.remove('is-loading');
  document.querySelector('.gbtn-txt').textContent = 'Ingresar';
  document.getElementById('user-dropdown').classList.remove('open');
  document.getElementById('user-chip-wrap').classList.remove('open');
  updateHUD();
  stopSync();
  if (currentPopupPlace) closePopup();
  showToast('✅ Sesión cerrada');
};
const applyLoggedUI = () => {
  document.getElementById('login-topbar-btn').style.display = 'none';
  document.getElementById('user-chip-wrap').style.display = 'flex';
  const avatar = document.getElementById('topbar-avatar');
  if (currentUser.picture) {
    avatar.innerHTML = `<img src="${currentUser.picture}" alt="${currentUser.name}" referrerpolicy="no-referrer">`;
  } else {
    avatar.textContent = (currentUser.name || 'YO').charAt(0).toUpperCase();
  }
  updateHUD();
  maybeStartSync();
};
// restoreSession: chequea si ya hay sesión de Supabase (ej. volviendo del
// redirect de Google) y se suscribe a cambios futuros de auth.
const restoreSession = async () => {
  const { data: { session } } = await getSession();
  if (session?.user) await hydrateFromAuthUser(session.user);
  onAuthChange(async user => {
    if (user && !isLoggedIn) { await hydrateFromAuthUser(user); resetLoginBtn(); hideToastAction(); showToast(`👋 ¡Hola, ${(currentUser.name||'').split(' ')[0] || currentUser.email}!`); }
  });
};
const hydrateFromAuthUser = async (authUser) => {
  currentUser = {
    email: authUser.email,
    name: authUser.user_metadata?.name || authUser.email,
    picture: authUser.user_metadata?.avatar_url || '',
  };
  isLoggedIn = true;
  applyLoggedUI();
  if (BACKEND_READY) {
    const me = await apiGet('me', { email: currentUser.email });
    if (me?.points != null) { userPts = me.points; updateHUD(); }
  }
  maybeStartSync();
};

// ============================================================
// HUD
// ============================================================
const updateHUD = () => {
  const info = getLevel(userPts);
  document.getElementById('my-pts').textContent = userPts + ' pts';
  document.getElementById('lvl-badge').textContent = 'Nivel ' + info.level;
  document.getElementById('xp-bar-fill').style.width = info.pct + '%';
  const p = document.getElementById('my-pts-prizes');
  if (p) p.textContent = userPts + ' pts disponibles';
};
const flashPoints = () => {
  const el = document.getElementById('my-pts');
  if (el) { el.style.animation = 'none'; el.offsetHeight; el.style.animation = 'ptsFlash .45s cubic-bezier(.34,1.56,.64,1)'; }
};
const addPoints = amount => {
  const prev = getLevel(userPts).level;
  userPts += amount;
  updateHUD();
  flashPoints();
  const cur = getLevel(userPts).level;
  if (cur > prev) setTimeout(() => levelUp(cur), 400);
};
const levelUp = level => {
  const modal = document.createElement('div');
  modal.className = 'levelup-modal';
  modal.innerHTML = `<div class="levelup-card"><div class="levelup-burst">⭐</div><div class="levelup-lvl">¡NIVEL ${level}!</div><div class="levelup-title">${LEVEL_TITLES[Math.min(level-1, LEVEL_TITLES.length-1)]}</div><button class="levelup-close" onclick="this.closest('.levelup-modal').remove()">¡Genial!</button></div>`;
  document.body.appendChild(modal);
  setTimeout(() => { if (modal.parentNode) modal.remove(); }, 5000);
};
const buildRanking = () => {
  const list = document.getElementById('rank-list');
  if (!rankingData.length) {
    list.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:60px 24px;text-align:center;height:100%;"><div style="font-size:34px">🏆</div><div style="font-size:14px;font-weight:800;color:var(--text)">Todavía no hay reportes</div><div style="font-size:12px;color:var(--text2);max-width:220px">Sé el primero en reportar y encabezá el ranking</div></div>`;
    return;
  }
  const medals = ['🥇','🥈','🥉'];
  list.innerHTML = rankingData.sort((a,b) => b.pts - a.pts).map((u,i) =>
    `<div class="rank-row${u.isMe?' is-me':''}" style="animation-delay:${i*.04}s">
      <div class="rank-pos">${medals[i] || (i+1)}</div>
      <div class="rank-avatar" style="background:${u.bg};color:${u.fg}">${u.init}</div>
      <div class="rank-info"><div class="rank-name">${u.name}${u.isMe?' <span style="font-size:11px;color:var(--green);font-weight:800">(vos)</span>':''}</div><div class="rank-sub">${u.reports} reportes este mes</div></div>
      <div class="rank-pts-val">${u.pts.toLocaleString('es-AR')}</div>
    </div>`
  ).join('');
};
const buildPrizes = () => {
  document.getElementById('my-pts-prizes').textContent = userPts + ' pts disponibles';
  document.getElementById('prizes-list').innerHTML = prizesData.map((pr, idx) => {
    const pct = Math.min(100, Math.round((userPts / pr.pts) * 100));
    return `<div class="prize-row" style="animation-delay:${idx*.04}s">
      <div class="prize-emoji">${pr.emoji}</div>
      <div class="prize-body">
        <div class="prize-name">${pr.name}</div>
        <div class="prize-cat">${pr.pts.toLocaleString('es-AR')} pts · ${pr.cat} · ${pr.partner}</div>
        <div class="pbar-bg"><div class="pbar-fill" style="width:0%" data-w="${pct}"></div></div>
      </div>
      <div class="prize-cta">Muy pronto</div>
    </div>`;
  }).join('');
  requestAnimationFrame(() => {
    document.querySelectorAll('.pbar-fill').forEach(el => { el.style.width = el.dataset.w + '%'; });
  });
};

// ============================================================
// SYNC
// ============================================================
const syncOccupancy = () => {
  if (!BACKEND_READY || !Object.keys(placeStore).length) return;
  const lat = userLat ?? CONFIG.DEFAULT_CENTER.lat;
  const lng = userLng ?? CONFIG.DEFAULT_CENTER.lng;
  apiGet('sync_places', {lat,lng,radius:1000,status_only:1})
    .then(res => {
      if (!res?.places) return;
      let changed = false;
      res.places.forEach(bp => {
        const p = placeStore[bp.id];
        if (p) { if (p.status !== bp.status || p.reporters !== (bp.reporters??p.reporters)) changed = true;
          p.status = bp.status ?? p.status; p.reporters = bp.reporters ?? p.reporters; placeStore[p.id] = p; }
      });
      if (changed) {
        persistCache();
        if (nearbyPlaces.length) buildMapMarkers(nearbyPlaces);
        if (document.getElementById('panel-cerca').classList.contains('visible')) cercaApplyFilters();
        if (currentPopupPlace) { const upd = placeStore[currentPopupPlace.id]; if (upd) { Object.assign(currentPopupPlace, upd); renderPopup(); } }
      }
    })
    .catch(()=>{});
};
const startSync = () => { if (_syncInterval) return; syncOccupancy(); _syncInterval = setInterval(syncOccupancy, 15000); };
const stopSync = () => { if (_syncInterval) { clearInterval(_syncInterval); _syncInterval = null; } };
const maybeStartSync = () => { if (isLoggedIn && !_syncInterval) startSync(); else if (!isLoggedIn && _syncInterval) stopSync(); };

// ============================================================
// SWITCH TAB
// ============================================================
const switchTab = tab => {
  vibrate(6);
  ['map','cerca','ranking','prizes'].forEach(t => {
    document.getElementById('panel-'+t).classList.toggle('visible', t === tab);
  });
  if (tab === 'cerca') { if (!cercaLoaded) cercaLoadPlaces(); else cercaApplyFilters(); }
  if (tab === 'ranking') { buildRanking(); if (!rankingData.length && BACKEND_READY) apiGet('ranking', currentUser?{email:currentUser.email}:{}).then(r => { if (r?.ranking) { rankingData = r.ranking; buildRanking(); } }); }
  if (tab === 'prizes') { buildPrizes(); if (!prizesData.length && BACKEND_READY) apiGet('prizes').then(r => { if (r?.prizes) { prizesData = r.prizes; buildPrizes(); } }); }
};

// ============================================================
// TOAST
// ============================================================
const showToast = msg => {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
};
const showToastAction = msg => {
  const t = document.getElementById('toast-action');
  document.getElementById('toast-action-msg').textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastActionTimer);
  _toastActionTimer = setTimeout(() => t.classList.remove('show'), 5000);
};
const hideToastAction = () => {
  clearTimeout(_toastActionTimer);
  document.getElementById('toast-action').classList.remove('show');
};

// ============================================================
// PWA
// ============================================================
let deferredPrompt = null;
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(()=>{}); });
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (!standalone) document.getElementById('install-banner').style.display = 'flex';
});
const installPwa = () => {
  document.getElementById('install-banner').style.display = 'none';
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.finally(() => { deferredPrompt = null; });
};
window.addEventListener('appinstalled', () => {
  document.getElementById('install-banner').style.display = 'none';
  showToast('✅ Qooentum instalada');
});

// ============================================================
// PICK MODE
// ============================================================
const enterPickMode = () => {
  pickModeActive = true;
  switchTab('map');
  document.getElementById('pick-mode-banner').classList.add('show');
  document.getElementById('maplibre-map').style.cursor = 'crosshair';
  mlMap.once('click', e => {
    if (!pickModeActive) return;
    const {lat,lng} = e.lngLat;
    const closest = Object.values(placeStore).filter(p => validCoord(p.lat,p.lng)).map(p => ({...p, _d:dist(lat,lng,p.lat,p.lng)})).sort((a,b) => a._d - b._d)[0];
    if (closest && closest._d < 100) { exitPickMode(); openPopup(closest); }
    else exitPickMode();
  });
};
const exitPickMode = () => {
  pickModeActive = false;
  document.getElementById('pick-mode-banner').classList.remove('show');
  document.getElementById('maplibre-map').style.cursor = '';
};
const renderPopup = () => {
  // Llamado desde el sync en tiempo real cuando cambian los datos del
  // place con el popup abierto (status/reporters). Actualiza la
  // referencia y re-pinta header+body sin tocar el estado local del
  // usuario (selected/submitted/cooldownMs) ni reiniciar la animación
  // de entrada — igual que hacía React al reconciliar el mismo nodo.
  if (!pp || !currentPopupPlace) return;
  pp.place = currentPopupPlace;
  ppApplyCardTheme();
  ppRenderHeader();
  ppRenderBody();
};

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  loadCache();
  loadCooldowns();
  pruneTiles();
  updateHUD();
  restoreSession();
  maybeStartSync();
  requestGpsBeforeMap();
});

document.addEventListener('click', e => {
  const wrap = document.getElementById('user-chip-wrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('user-dropdown').classList.remove('open');
    wrap.classList.remove('open');
  }
});

setInterval(pruneTiles, 60*60*1000);
setInterval(persistCache, 5*60*1000);
setInterval(() => {
  const today = Date.now() - (Date.now() % 86400000);
  Object.values(placeStore).forEach(p => {
    if (p.report_ts && p.report_ts < today) { p.reporters=0; p.status=0; p.report_ts=null; }
  });
}, 60*60*1000);

// Exponer funciones globales
window.switchTab = switchTab;
window.toggleUserDropdown = toggleUserDropdown;
window.doGoogleLogin = doGoogleLogin;
window.doLogout = doLogout;
window.onGpsBtnClick = onGpsBtnClick;
window.onZoomIn = onZoomIn;
window.onZoomOut = onZoomOut;
window.installPwa = installPwa;
window.cercaSetRadius = cercaSetRadius;
window.cercaSetCat = cercaSetCat;
window.cercaCycleSort = cercaCycleSort;
window.cercaApplyFilters = cercaApplyFilters;
window.cercaSearchQ = '';
window.hideToastAction = hideToastAction;
