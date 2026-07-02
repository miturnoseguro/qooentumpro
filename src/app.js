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
  REPORT_RADIUS_M: 20,
  GPS_ZOOM: 19,
  FOLLOW_ZOOM: 18,
  CHECKIN_RADIUS_M: 150,
  TILE_DEG: 0.0025,
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
  if (!p.reporters || p.reporters===0) return (p.sponsor?.tier === 'premium') ? NO_REPORT_SPONSOR : NO_REPORT;
  return STATUS_CFG[p.status];
};
const WAIT  = ['Sin espera','~5 min','~15 min','+30 min'];
const TREND = ['↘ Baja','→ Estable','↗ Sube','↗ Sube'];
// Tono gold fijo para sponsors premium (no depende del badge_color que traiga el comercio) — la marca (verde) se reserva solo para login y link al sitio
const SPONSOR_GOLD = '#D4AF37';
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
let currentPopupPlace = null, popupRoot = null;
let cercaAllPlaces = [], cercaFiltered = [], cercaRadius=1000, cercaCat='all', cercaSearchQ='', cercaSortMode='distance', cercaSortIdx=0, cercaLoading=false;
let cercaLoaded = false;
let cercaReqId = 0; // usado para descartar respuestas de cargas viejas (evita el parpadeo al cambiar de radio rápido)
let cercaCache = {}; // cache de resultados por radio, para no repetir el flash de datos demo al volver a un radio ya visitado
let rankingData = [], prizesData = SEED_PRIZES.map(p=>({...p}));
let _markerBatchToken = 0, _buildMarkersTimer = null;
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
const overpassFetchMirror = async (url, query) => {
  const now = Date.now();
  const last = _overpassMirrorLastReq[url] || 0;
  const elapsed = now - last;
  if (elapsed < OVERPASS_MIN_INTERVAL_PER_MIRROR) await new Promise(r => setTimeout(r, OVERPASS_MIN_INTERVAL_PER_MIRROR - elapsed));
  _overpassMirrorLastReq[url] = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) { _overpassMirrorLastReq[url] = Date.now() + 30000; throw new Error('429'); }
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};
// Corre todos los espejos en paralelo y devuelve el primero que responda ok.
const overpassRate = async (query) => {
  try {
    return await Promise.any(OVERPASS_MIRRORS.map(url => overpassFetchMirror(url, query)));
  } catch (e) {
    console.warn('[overpass] todos los espejos fallaron', e);
    return null;
  }
};
const overpassSearch = async (lat, lng, radiusM) => {
  const key = `${Math.round(lat*400)}_${Math.round(lng*400)}`;
  const cached = OVERPASS_CACHE.get(key);
  if (cached && Date.now()-cached.ts < OVERPASS_CACHE_TTL) return cached.places;
  const r = Math.min(radiusM, 10000);
  const q = `[out:json][timeout:15];
(
  node["amenity"~"restaurant|cafe|fast_food|bar|pharmacy|hospital|clinic|bank|atm|post_office|fuel|bakery|dentist|doctors|social_facility|ice_cream|veterinary"](around:${r},${lat},${lng});
  node["shop"~"supermarket|convenience|greengrocer|butcher|clothes|shoes|electronics|hardware|books|mobile_phone|hairdresser|beauty|laundry|bakery|money_lender|optician|pet|sports|furniture|stationery"](around:${r},${lat},${lng});
  node["leisure"~"fitness_centre|sports_centre"](around:${r},${lat},${lng});
  way["amenity"~"restaurant|cafe|fast_food|bar|pharmacy|hospital|clinic|bank|fuel|supermarket|veterinary"](around:${r},${lat},${lng});
  way["shop"~"supermarket|convenience|hardware|sports|furniture"](around:${r},${lat},${lng});
  way["leisure"~"fitness_centre|sports_centre"](around:${r},${lat},${lng});
);
out center 60;`;
  const data = await overpassRate(q);
  if (!data) { const cached2 = OVERPASS_CACHE.get(key); return cached2 ? cached2.places : []; }
  const places = (data.elements||[])
    .map(el => {
      const lat = el.lat ?? el.center?.lat ?? null;
      const lng = el.lon ?? el.center?.lon ?? null;
      if (lat==null || lng==null) return null;
      const tags = el.tags || {};
      const name = tags.name || tags['name:es'] || null;
      if (!name) return null;
      const meta = osmToMeta(tags);
      const d = Math.round(dist(lat,lng, parseFloat(lat), parseFloat(lng)));
      return {
        id: `osm-${el.type}-${el.id}`,
        name, type: meta.tipo, logo: meta.emoji, cat: meta.cat,
        addr: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || tags.address || '',
        lat: parseFloat(lat), lng: parseFloat(lng), dist: d,
        status:0, reporters:0,
        rating: (3.5 + ((el.id%14)*0.1)).toFixed(1),
        reviewsN: 10 + (el.id%190),
        open: true, verified: false, sponsor: null,
      };
    })
    .filter(p => p && p.dist <= radiusM)
    .sort((a,b) => a.dist - b.dist)
    .slice(0, window.innerWidth < 768 ? 80 : 150);
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
    const [osms, backend] = await Promise.all([
      searchPlaces(lat,lng,600),
      BACKEND_READY ? apiGet('sync_places', {lat,lng,radius:600}) : null,
    ]);
    const bm = new Map((backend?.places||[]).map(p=>[p.id,p]));
    const merged = osms.map(p => { const bp = bm.get(p.id); return bp ? {...p,...bp} : p; });
    const onlyBackend = (backend?.places||[]).filter(p => !osms.find(o=>o.id===p.id));
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

const onGps = pos => {
  const {latitude:lat, longitude:lng, accuracy} = pos.coords;
  if (!validCoord(lat,lng)) return;
  if (gpsEverReceived && accuracy > 150) return;
  const isFirstFix = !gpsEverReceived;
  userLat = lat; userLng = lng; gpsEverReceived = true;
  saveLastLocation(lat,lng);
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
  const toRender = [...placesToShow]
    .sort((a,b) => ((a.lat-center.lat)**2+(a.lng-center.lng)**2) - ((b.lat-center.lat)**2+(b.lng-center.lng)**2))
    .slice(0, MAX);
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
        return;
      }
      const el = makeMarker(p);
      el.addEventListener('click', () => { vibrate(10); selectPlaceInUI(p.id); if (pickModeActive) { exitPickMode(); openPopup(p); } else openPopup(p); });
      const marker = new maplibregl.Marker({ element:el, anchor:'bottom' }).setLngLat([p.lng,p.lat]).addTo(mlMap);
      mlMarkers[p.id] = { marker, el, _lastStatus:p.status, _lastReporters:p.reporters };
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
  const el = document.createElement('div');
  el.className = 'fc-card-wrap' + (isPremium ? ' is-sponsor' : '');
  if (isPremium) el.style.setProperty('--sponsor-color', SPONSOR_GOLD);
  else if (p.sponsor?.badge_color) el.style.setProperty('--sponsor-color', p.sponsor.badge_color);
  el.innerHTML = `
    <div class="fc-card">
      <div class="fc-card-head">
        <div class="fc-card-logo">${logo}${ver}</div>
        <div class="fc-card-info"><div class="fc-card-name">${p.name}</div><div class="fc-card-type">${p.type}</div></div>
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
const {useState, useEffect, useRef} = React;
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
const getLogo = p => p.sponsor?.logo_url ? React.createElement('img', { src:p.sponsor.logo_url, alt:p.name, style:{width:'100%',height:'100%',objectFit:'contain',borderRadius:10} }) : p.logo;
const canReportPlace = p => userLat!=null && userLng!=null && dist(userLat,userLng,p.lat,p.lng) <= CONFIG.REPORT_RADIUS_M;

const PlacePopup = ({ place, onClose }) => {
  const [visible, setVisible] = useState(false);
  const [cardVisible, setCardVisible] = useState(false);
  const [selected, setSelected] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [cooldownMs, setCooldownMs] = useState(getCooldown(place.id));
  const [imgLoaded, setImgLoaded] = useState(false);
  const overlayRef = useRef(null);
  const onCooldown = cooldownMs > 0 && !submitted;
  const nearby = canReportPlace(place);
  const hasGps = userLat!=null && userLng!=null;
  const distTo = hasGps ? Math.round(dist(userLat,userLng,place.lat,place.lng)) : null;

  useEffect(() => { requestAnimationFrame(() => { setVisible(true); setTimeout(() => setCardVisible(true), 40); }); }, []);
  useEffect(() => {
    if (cooldownMs <= 0) return;
    const id = setInterval(() => setCooldownMs(ms => Math.max(0, ms-1000)), 1000);
    return () => clearInterval(id);
  }, [cooldownMs > 0]);

  const handleClose = () => { setCardVisible(false); setVisible(false); setTimeout(onClose, 320); };
  const handleOverlay = e => { if (e.target === overlayRef.current) handleClose(); };
  const handleVote = idx => {
    if (submitted || onCooldown || !nearby) return;
    if (!isLoggedIn) { showToastAction('🔑 Iniciá sesión para reportar'); return; }
    vibrate(8);
    setSelected(idx);
  };
  const handleSubmit = async () => {
    if (selected == null || submitted || onCooldown || !nearby) return;
    if (!isLoggedIn) { showToastAction('🔑 Iniciá sesión para reportar'); return; }
    setSubmitted(true);
    vibrate(15);
    applyCooldown(place.id);
    place.status = selected;
    place.reporters = (place.reporters || 0) + 1;
    place.report_ts = Date.now();
    placeStore[place.id] = place;
    refreshMarker(place.id);
    if (currentPopupPlace && currentPopupPlace.id === place.id) Object.assign(currentPopupPlace, place);
    if (document.getElementById('panel-cerca').classList.contains('visible')) cercaApplyFilters();

    const ok = await submitVote(place, selected);
    if (ok) { flashPoints(); setCooldownMs(getCooldown(place.id)); }
    setTimeout(handleClose, 900);
  };

  const s = getStatus(place);
  const photo = getPhoto(place);
  const sponsor = place.sponsor || null;
  const isPremium = sponsor?.tier === 'premium';
  const sponsorColor = isPremium ? SPONSOR_GOLD : (sponsor?.badge_color || '#6366F1');
  const badgeText = sponsor?.badge_text || null;
  const promo = sponsor?.promo || null;
  const website = sponsor?.website || null;
  // Paleta "gold premium" para comercios sponsor de nivel premium — mismo lineamiento que la mini card y la card de lista
  const T = isPremium ? {
    cardBg: `linear-gradient(180deg, color-mix(in srgb, ${sponsorColor} 14%, #fff) 0%, rgba(29,29,29) 48%)`,
    statBg: `color-mix(in srgb, ${sponsorColor} 9%, #fff)`,
    statBorder: `1px solid color-mix(in srgb, ${sponsorColor} 28%, var(--border))`,
    text: '#0F172A',
    text2: '#475569',
    text3: '#64748B',
    btnBg: '#fff',
    btnBorder: '#E2E8F0',
    pad: '13px 14px 16px',
  } : null;

  const overlayStyle = {
    position:'fixed', inset:0,
    background: `rgba(15,23,42,${visible ? '.62' : '0'})`,
    backdropFilter: `blur(${visible ? '6px' : '0px'})`,
    WebkitBackdropFilter: `blur(${visible ? '6px' : '0px'})`,
    display:'flex', alignItems:'center', justifyContent:'center',
    transition: 'background 0.3s ease, backdrop-filter 0.3s ease',
    zIndex:10000, padding:'20px',
  };
  const cardStyle = {
    width:'100%', maxWidth:'370px', background: T ? T.cardBg : '#fff', borderRadius:'22px',
    overflow:'hidden',
    boxShadow: isPremium ? `0 24px 64px rgba(15,23,42,.22), 0 0 0 2px ${sponsorColor}60` : (sponsor ? `0 24px 64px rgba(15,23,42,.28), 0 0 0 2px ${sponsorColor}40` : '0 24px 64px rgba(15,23,42,.28)'),
    transform: cardVisible ? 'translateY(0) scale(1)' : 'translateY(40px) scale(0.93)',
    opacity: cardVisible ? 1 : 0,
    transition: 'transform 0.38s cubic-bezier(0.34,1.56,0.64,1), opacity 0.28s ease',
    maxHeight: 'calc(100dvh - 40px)', display:'flex', flexDirection:'column',
  };

  const tooFar = hasGps && !nearby && !onCooldown && React.createElement('div', { style:{display:'flex',alignItems:'center',gap:10,background:'#F1F5F9',border:'1px solid #E2E8F0',borderRadius:12,padding:'10px 12px',marginBottom:12} },
    React.createElement('span', {style:{fontSize:20,flexShrink:0}},'📍'),
    React.createElement('div', null,
      React.createElement('p', {style:{margin:0,fontSize:13,fontWeight:800,color:'#0F172A'}}, `Estás a ${distTo}m de este comercio`),
      React.createElement('p', {style:{margin:'2px 0 0',fontSize:12,color:'#64748B'}}, 'Necesitás estar a menos de '+CONFIG.REPORT_RADIUS_M+'m para reportar.')
    )
  );
  const notLog = !isLoggedIn && !onCooldown && React.createElement('div', { style:{display:'flex',alignItems:'center',gap:10,background:'#F0FDF9',border:'1px solid #A8EDD8',borderRadius:12,padding:'10px 12px',marginBottom:12} },
    React.createElement('span', {style:{fontSize:20,flexShrink:0}},'🔑'),
    React.createElement('div', {style:{flex:1}},
      React.createElement('p', {style:{margin:0,fontSize:13,fontWeight:800,color:'#007A59'}}, 'Iniciá sesión para reportar'),
      React.createElement('p', {style:{margin:'2px 0 0',fontSize:12,color:'#047857'}}, 'Ganás puntos por cada reporte.')
    ),
    React.createElement('button', {
      onClick: () => doGoogleLogin(document.getElementById('login-topbar-btn')),
      style:{background:'linear-gradient(135deg,#00C48C,#009E72)',color:'#fff',border:'none',borderRadius:40,padding:'6px 12px',fontSize:12,fontWeight:800,cursor:'pointer',whiteSpace:'nowrap',fontFamily:'inherit'}
    }, 'Ingresar')
  );

  return React.createElement('div', { ref:overlayRef, style:overlayStyle, onClick:handleOverlay },
    React.createElement('div', { style:cardStyle },
      React.createElement('div', { style:{overflowY:'auto',msOverflowStyle:'none',scrollbarWidth:'none'} },
        React.createElement('div', { style:{position:'relative',height:'200px',flexShrink:0,background:'#E2E8F0'} },
          React.createElement('img', {
            src:photo, alt:place.name, loading:'lazy',
            onLoad:()=>setImgLoaded(true),
            onError:e => { const fb = PHOTOS[place.type] || PHOTOS.default; if (e.target.src !== fb) e.target.src = fb; },
            style:{width:'100%',height:'100%',objectFit:'cover',display:'block',opacity:imgLoaded?1:0,transition:'opacity 0.4s ease'}
          }),
          badgeText && React.createElement('div', {style:{position:'absolute',top:12,right:52,background:sponsorColor,borderRadius:40,padding:'3px 9px',display:'flex',alignItems:'center',gap:4,boxShadow:'0 2px 8px rgba(0,0,0,.25)'}},
            React.createElement('span', {style:{fontSize:10,fontWeight:800,color:'#fff'}}, badgeText)
          ),
          React.createElement('div', { style:{position:'absolute',inset:0,background:'linear-gradient(to bottom, rgba(0,0,0,0) 30%, rgba(0,0,0,0.68) 100%)'} }),
          React.createElement('button', {
            onClick:handleClose,
            style:{position:'absolute',top:12,right:12,width:32,height:32,borderRadius:'50%',background:'rgba(0,0,0,0.42)',border:'none',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:18,lineHeight:1,backdropFilter:'blur(8px)'}
          }, '✕'),
          React.createElement('div', { style:{position:'absolute',top:12,left:12,background:s.color,borderRadius:40,padding:'3px 9px',display:'flex',alignItems:'center',gap:4} },
            React.createElement('span', {style:{width:5,height:5,borderRadius:'50%',background:'rgba(255,255,255,0.55)',display:'inline-block',flexShrink:0}}),
            React.createElement('span', {style:{fontSize:10,fontWeight:800,color:'#fff'}}, s.label)
          ),
          React.createElement('div', { style:{position:'absolute',bottom:12,left:12,right:12,display:'flex',alignItems:'flex-end',gap:10} },
            React.createElement('div', {style:{position:'relative',flexShrink:0}},
              React.createElement('div', {style:{width:44,height:44,borderRadius:14,background:'#fff',border:'2.5px solid rgba(255,255,255,0.9)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,overflow:'hidden'}}, getLogo(place)),
              place.verified && React.createElement('div', {style:{position:'absolute',bottom:-3,right:-3,width:16,height:16,background:`linear-gradient(135deg, ${sponsorColor}, color-mix(in srgb, ${sponsorColor} 55%, #fff))`,borderRadius:'50%',border:'2px solid #fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:7,color:'#fff',fontWeight:900}},'✓')
            ),
            React.createElement('div', {style:{flex:1,minWidth:0}},
              React.createElement('p', {style:{margin:0,fontSize:15,fontWeight:800,color:'#fff',lineHeight:1.2,textShadow:'0 1px 6px rgba(0,0,0,0.5)'}}, place.name),
              React.createElement('p', {style:{margin:'2px 0 0',fontSize:11,color:'rgba(255,255,255,0.82)',textShadow:'0 1px 4px rgba(0,0,0,0.4)'}}, place.type + ' · ' + place.addr)
            ),
            React.createElement('div', {style:{display:'flex',alignItems:'center',gap:3,background:'rgba(255,255,255,0.18)',backdropFilter:'blur(8px)',border:'0.5px solid rgba(255,255,255,0.3)',borderRadius:40,padding:'3px 8px',flexShrink:0}},
              React.createElement('span', {style:{color:'#F59E0B',fontSize:11}},'★'),
              React.createElement('span', {style:{fontSize:11,fontWeight:800,color:'#fff'}}, place.rating),
              React.createElement('span', {style:{fontSize:10,color:'rgba(255,255,255,0.7)'}}, ' · ' + place.reviewsN)
            )
          )
        ),
        React.createElement('div', {style:{padding: T ? T.pad : '14px 14px 16px'}},
          React.createElement('div', {style:{display:'flex',gap:6,marginBottom:12}},
            ...[{val:place.reporters,lbl:'Reportes'}, {val:WAIT[place.status],lbl:'Espera'}, {val:TREND[place.status],lbl:'Tendencia'}].map(({val,lbl}) =>
              React.createElement('div', {key:lbl,style:{flex:1,background: T ? T.statBg : '#F1F5F9',border: T ? T.statBorder : 'none',borderRadius:9,padding:'6px 8px',textAlign:'center'}},
                React.createElement('p', {style:{margin:0,fontSize:13,fontWeight:600,color: T ? T.text : '#0F172A',letterSpacing:'-0.2px'}}, val),
                React.createElement('p', {style:{margin:'1px 0 0',fontSize:8,color: T ? T.text3 : '#64748B',textTransform:'uppercase',letterSpacing:'0.4px',fontWeight:600}}, lbl)
              )
            )
          ),
          promo && React.createElement('div', {style:{display:'flex',alignItems:'center',gap:8,background: T ? `color-mix(in srgb, ${sponsorColor} 14%, transparent)` : `${sponsorColor}14`,border:`1px solid ${sponsorColor}44`,borderRadius:10,padding:'8px 10px',marginBottom:10}},
            React.createElement('span', {style:{fontSize:16,flexShrink:0}},'🎁'),
            React.createElement('span', {style:{fontSize:12,fontWeight:800,color:sponsorColor}}, promo)
          ),
          notLog, tooFar,
          !hasGps && !onCooldown && React.createElement('div', {style:{display:'flex',alignItems:'center',gap:10,background:'#EEF2FF',border:'1px solid #C7D2FE',borderRadius:12,padding:'10px 12px',marginBottom:12}},
            React.createElement('span', {style:{fontSize:20,flexShrink:0}},'🛰️'),
            React.createElement('div', null,
              React.createElement('p', {style:{margin:0,fontSize:13,fontWeight:800,color:'#3730A3'}}, 'Activá tu ubicación para reportar'),
              React.createElement('p', {style:{margin:'2px 0 0',fontSize:12,color:'#4338CA'}}, 'Solo podés reportar si estás físicamente dentro del comercio.')
            )
          ),
          isLoggedIn && nearby && !onCooldown && React.createElement('div', {style:{display:'flex',alignItems:'center',gap:7,marginBottom:10,padding:'7px 10px',background:'#E8FBF5',borderRadius:10,border:'1px solid #A8EDD8'}},
            React.createElement('span', {style:{fontSize:14}},'✅'),
            React.createElement('span', {style:{fontSize:12,fontWeight:700,color:'#007A59'}}, `Estás a ${distTo ?? '?'}m · podés reportar`)
          ),
          onCooldown && React.createElement('div', {style:{display:'flex',alignItems:'center',gap:10,background:'#FFFBEB',border:'1px solid #FDE68A',borderRadius:12,padding:'10px 12px',marginBottom:10}},
            React.createElement('span', {style:{fontSize:20,flexShrink:0}},'⏳'),
            React.createElement('div', null,
              React.createElement('p', {style:{margin:0,fontSize:13,fontWeight:800,color:'#92400E'}}, `Ya reportaste ${place.name} hace poco`),
              React.createElement('p', {style:{margin:'2px 0 0',fontSize:12,color:'#92400E'}}, `Podés volver a reportar en ${fmtCooldown(cooldownMs)}`)
            )
          ),
          !submitted && isLoggedIn && nearby && !onCooldown && React.createElement('div', {style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:10}},
            ...[{idx:0,label:'Poca gente',pts:'+10',color:'#00C48C'}, {idx:1,label:'Bastante',pts:'+10',color:'#F59E0B'}, {idx:2,label:'Mucha gente',pts:'+15',color:'#F97316'}, {idx:3,label:'Colapsado',pts:'+20',color:'#EF4444'}].map(({idx,label,pts,color}) => {
              const isSel = selected === idx;
              return React.createElement('button', {
                key:idx,
                onClick:()=>handleVote(idx),
                style:{
                  border: isSel ? `2px solid ${color}` : (T ? `1.5px solid ${T.btnBorder}` : '1.5px solid #E2E8F0'),
                  borderRadius:10, background:isSel ? color : (T ? T.btnBg : '#fff'),
                  padding:'9px 8px', cursor:'pointer',
                  display:'flex', alignItems:'center', gap:6,
                  fontSize:11, fontWeight:700,
                  color: isSel ? '#fff' : (T ? T.text : '#0F172A'),
                  textAlign:'left', fontFamily:'inherit',
                  transition:'all 0.18s cubic-bezier(0.34,1.56,0.64,1)',
                  transform: isSel ? 'translateY(-1px)' : 'none',
                  boxShadow: isSel ? `0 4px 12px ${color}44` : 'none',
                }
              },
                React.createElement('span', {style:{width:8,height:8,borderRadius:'50%',background: isSel ? 'rgba(255,255,255,0.55)' : color, display:'inline-block', flexShrink:0}}),
                label,
                React.createElement('span', {style:{marginLeft:'auto',fontSize:9,fontWeight:800,color:'#fff',background:color,padding:'1px 6px',borderRadius:40}}, pts)
              );
            })
          ),
          submitted && React.createElement('div', {style:{display:'flex',alignItems:'center',gap:10,background:'#E8FBF5',border:'1px solid #A8EDD8',borderRadius:12,padding:'11px 12px',marginBottom:10}},
            React.createElement('span', {style:{fontSize:20}},'✅'),
            React.createElement('div', null,
              React.createElement('p', {style:{margin:0,fontSize:13,fontWeight:800,color:'#007A59'}}, '¡Reporte enviado!'),
              React.createElement('p', {style:{margin:'2px 0 0',fontSize:11,color:'#047857'}}, `+${VOTE_PTS[selected] || 10} puntos sumados`)
            )
          ),
          !submitted && isLoggedIn && nearby && !onCooldown && React.createElement('button', {
            onClick:handleSubmit,
            disabled: selected == null,
            style:{
              width:'100%',
              background: selected != null ? `linear-gradient(135deg, ${STATUS_CFG[selected].color}, ${STATUS_CFG[selected].color}cc)` : (T ? T.btnBg : '#E2E8F0'),
              color: selected != null ? '#fff' : (T ? T.text3 : '#94A3B8'),
              border:'none', borderRadius:12, padding:'12px',
              fontSize:13, fontWeight:800,
              cursor: selected != null ? 'pointer' : 'not-allowed',
              display:'flex', alignItems:'center', justifyContent:'center', gap:6,
              fontFamily:'inherit', transition:'all 0.22s',
              boxShadow: selected != null ? `0 6px 20px ${STATUS_CFG[selected].color}44` : 'none',
              transform: selected != null ? 'translateY(-1px)' : 'none',
            }
          }, 'Reportar estado'),
          React.createElement('p', {style:{margin:'8px 0 0',fontSize:10,color: T ? T.text3 : '#94A3B8',display:'flex',alignItems:'center',gap:4,fontWeight:500}},
            React.createElement('svg', {viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round',style:{width:11,height:11,flexShrink:0}},
              React.createElement('path', {d:'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'}),
              React.createElement('circle', {cx:9,cy:7,r:4}),
              React.createElement('path', {d:'M23 21v-2a4 4 0 0 0-3-3.87'}),
              React.createElement('path', {d:'M16 3.13a4 4 0 0 1 0 7.75'})
            ),
            `${place.reporters} reportes en las últimas 2h`
          ),
          website && React.createElement('a', {
            href: website, target:'_blank', rel:'noopener noreferrer',
            style:{
              display:'block', marginTop:10, fontSize:11.5, fontWeight:800,
              color: BRAND_GREEN, textAlign:'center', textDecoration:'none',
              border:`1.5px solid ${BRAND_GREEN}`, borderRadius:40,
              padding:'9px 14px',
              background: `${BRAND_GREEN}0D`,
              letterSpacing:'.2px',
            }
          }, website.replace(/^https?:\/\//,'').replace(/\/$/,''))
        )
      )
    )
  );
};

const openPopup = place => {
  currentPopupPlace = place;
  const container = document.getElementById('react-popup-root');
  container.classList.add('active');
  if (!popupRoot) popupRoot = ReactDOM.createRoot(container);
  popupRoot.render(React.createElement(PlacePopup, { place, onClose: closePopup }));
};
const closePopup = () => {
  const container = document.getElementById('react-popup-root');
  container.classList.remove('active');
  if (popupRoot) popupRoot.render(null);
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

  // 2. Cargar reales en segundo plano
  let data = Object.values(placeStore)
    .filter(p => validCoord(p.lat,p.lng) && dist(lat,lng,p.lat,p.lng) <= radiusAtStart)
    .map(p => ({ ...p, dist: Math.round(dist(lat,lng,p.lat,p.lng)), cat: p.cat || guessCat(p.name,p.type) }));
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
const cercaShowSkeleton = () => {
  // Ya no se usa, pero se mantiene por si se necesitara.
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
      list.innerHTML = `<div class="nc-empty"><div class="nc-empty-icon"><div class="search-spinner" style="margin:0 auto;width:20px;height:20px;"></div></div><div class="nc-empty-title" style="margin-top:8px;">Buscando comercios cercanos…</div><div class="nc-empty-sub">Esto puede tardar unos segundos.</div></div>`;
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
      const isSponsor = p.sponsor?.tier === 'premium';
      const sponsorStyle = isSponsor ? `--sponsor-color:${SPONSOR_GOLD};` : '';
      const sponsorBadge = isSponsor && p.sponsor?.badge_text ? `<span class="nc-sponsor-badge">${p.sponsor.badge_text}</span>` : '';
      html += `<div class="nc-card${isSponsor ? ' is-sponsor' : ''}" data-place-id="${p.id}" style="animation-delay:${Math.min(idx*0.025,0.3)}s;${sponsorStyle}">
        <div class="nc-logo">${logo}</div>
        <div class="nc-body">
          <div class="nc-top"><div class="nc-name">${p.name}</div>${sponsorBadge}<span class="nc-badge-open ${p.open?'open':'closed'}">${p.open?'Abierto':'Cerrado'}</span></div>
          <div class="nc-meta"><span class="nc-type">${p.type}</span><div class="nc-dot"></div><span class="nc-dist">📍 ${fmtDist(p.dist)}</span>${p.addr ? `<div class="nc-dot"></div><span class="nc-addr">${p.addr}</span>` : ''}</div>
          <div class="nc-status" style="background:${s.color}"><div class="nc-sdot"></div><span class="nc-slabel">${s.label}</span><span class="nc-ssub">${s.sub}</span></div>
        </div>
        <div class="nc-right">
          <div class="nc-rating"><span class="nc-star">★</span>${p.rating}<span class="nc-rn">&nbsp;(${rev})</span></div>
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
  if (!popupRoot || !currentPopupPlace) return;
  popupRoot.render(React.createElement(PlacePopup, { place: currentPopupPlace, onClose: closePopup }));
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
