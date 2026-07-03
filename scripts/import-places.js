// ============================================================
// scripts/import-places.js
// ------------------------------------------------------------
// Importa comercios desde Overpass (OSM) a la tabla public.places
// de Supabase. Pensado para correrse a mano o vía GitHub Action con
// cron. Es IDEMPOTENTE: usa upsert por id ('osm-node-123'), así que
// correrlo de nuevo sobre la misma zona no duplica nada, solo
// refresca nombre/dirección/etc. Nunca toca status/reporters/
// report_ts/sponsor (esos los maneja submit_vote en tiempo real).
//
// Uso:
//   node scripts/import-places.js --lat -34.6083 --lng -58.3896 --radius-km 12
//   node scripts/import-places.js --bbox="-34.71,-58.53,-34.53,-58.33"
//
// Requiere en .env (NO el .env del cliente/Vite, uno aparte en la raíz
// del proyecto, que nunca se commitea):
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=xxxx   (Settings → API → service_role)
// ============================================================
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// ---- Config ----
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const TILE_KM_DEFAULT = 1.5;     // tamaño de cada celda del grid (bajado de 3km: la query ampliada trae mucha más densidad por km², tiles chicos = menos riesgo de timeout)
const OVERPASS_TIMEOUT_MS = 65000; // debe ser mayor al [timeout:60] que pide la query en buildQuery()
const RETRIES_PER_TILE = 3;
const DELAY_BETWEEN_REQUESTS_MS = 1200; // por espejo, para no comerse un 429
const UPSERT_BATCH_SIZE = 400;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno (.env)');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---- Args ----
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

// ---- Mismas reglas de categorización que osmToMeta() en app.js ----
// (duplicado a propósito: este script corre en Node sin acceso al bundle
// del cliente, y así quedan tipo/emoji/categoría idénticos a los que
// arma el cliente cuando busca en vivo contra Overpass).
const OSM_RULES = [
  { match: { amenity: 'restaurant' }, emoji: '🍽️', tipo: 'Restaurante', cat: 'food' },
  { match: { amenity: 'cafe' }, emoji: '☕', tipo: 'Cafetería', cat: 'food' },
  { match: { amenity: 'fast_food' }, emoji: '🍔', tipo: 'Comida rápida', cat: 'food' },
  { match: { amenity: 'bar' }, emoji: '🍺', tipo: 'Bar', cat: 'food' },
  { match: { amenity: 'bakery' }, emoji: '🥐', tipo: 'Panadería', cat: 'food' },
  { match: { shop: 'bakery' }, emoji: '🥐', tipo: 'Panadería', cat: 'food' },
  { match: { amenity: 'ice_cream' }, emoji: '🍦', tipo: 'Heladería', cat: 'food' },
  { match: { amenity: 'pharmacy' }, emoji: '💊', tipo: 'Farmacia', cat: 'health' },
  { match: { amenity: 'hospital' }, emoji: '🏥', tipo: 'Hospital', cat: 'health' },
  { match: { amenity: 'clinic' }, emoji: '🏥', tipo: 'Clínica', cat: 'health' },
  { match: { amenity: 'dentist' }, emoji: '🦷', tipo: 'Dentista', cat: 'health' },
  { match: { amenity: 'doctors' }, emoji: '👨‍⚕️', tipo: 'Médico', cat: 'health' },
  { match: { amenity: 'bank' }, emoji: '🏦', tipo: 'Banco', cat: 'bank' },
  { match: { amenity: 'atm' }, emoji: '🏧', tipo: 'Cajero', cat: 'bank' },
  { match: { shop: 'money_lender' }, emoji: '💳', tipo: 'Pago de servicios', cat: 'bank' },
  { match: { shop: 'supermarket' }, emoji: '🛒', tipo: 'Supermercado', cat: 'supermarket' },
  { match: { shop: 'convenience' }, emoji: '🏪', tipo: 'Almacén', cat: 'supermarket' },
  { match: { shop: 'greengrocer' }, emoji: '🥦', tipo: 'Verdulería', cat: 'supermarket' },
  { match: { shop: 'butcher' }, emoji: '🥩', tipo: 'Carnicería', cat: 'supermarket' },
  { match: { amenity: 'post_office' }, emoji: '📮', tipo: 'Correo', cat: 'government' },
  { match: { office: 'government' }, emoji: '🏛️', tipo: 'Oficina pública', cat: 'government' },
  { match: { amenity: 'social_facility' }, emoji: '🏛️', tipo: 'Oficina pública', cat: 'government' },
  { match: { shop: 'clothes' }, emoji: '👕', tipo: 'Ropa', cat: 'shopping' },
  { match: { shop: 'shoes' }, emoji: '👟', tipo: 'Zapatería', cat: 'shopping' },
  { match: { shop: 'electronics' }, emoji: '📱', tipo: 'Electrónica', cat: 'shopping' },
  { match: { shop: 'hardware' }, emoji: '🔧', tipo: 'Ferretería', cat: 'shopping' },
  { match: { shop: 'books' }, emoji: '📚', tipo: 'Librería', cat: 'shopping' },
  { match: { shop: 'mobile_phone' }, emoji: '📱', tipo: 'Telefonía', cat: 'shopping' },
  { match: { shop: 'hairdresser' }, emoji: '💈', tipo: 'Peluquería', cat: 'shopping' },
  { match: { shop: 'beauty' }, emoji: '💄', tipo: 'Estética', cat: 'shopping' },
  { match: { shop: 'laundry' }, emoji: '👔', tipo: 'Lavandería', cat: 'shopping' },
  { match: { amenity: 'fuel' }, emoji: '⛽', tipo: 'Estación de servicio', cat: 'shopping' },
  { match: { amenity: 'veterinary' }, emoji: '🐾', tipo: 'Veterinaria', cat: 'health' },
  { match: { leisure: 'fitness_centre' }, emoji: '🏋️', tipo: 'Gimnasio', cat: 'shopping' },
  { match: { leisure: 'sports_centre' }, emoji: '🏋️', tipo: 'Centro deportivo', cat: 'shopping' },
  { match: { shop: 'optician' }, emoji: '👓', tipo: 'Óptica', cat: 'health' },
  { match: { shop: 'pet' }, emoji: '🐾', tipo: 'Petshop', cat: 'shopping' },
  { match: { shop: 'sports' }, emoji: '⚽', tipo: 'Deportes', cat: 'shopping' },
  { match: { shop: 'furniture' }, emoji: '🛋️', tipo: 'Mueblería', cat: 'shopping' },
  { match: { shop: 'stationery' }, emoji: '✏️', tipo: 'Librería/Papelería', cat: 'shopping' },
  { match: { healthcare: true }, emoji: '👨‍⚕️', tipo: 'Salud', cat: 'health' },
  { match: { craft: true }, emoji: '🔨', tipo: 'Taller/Oficio', cat: 'shopping' },
  { match: { tourism: true }, emoji: '🧳', tipo: 'Turismo', cat: 'shopping' },
  { match: { office: true }, emoji: '🏢', tipo: 'Oficina', cat: 'shopping' },
  { match: { shop: true }, emoji: '🏪', tipo: 'Comercio', cat: 'shopping' },
  { match: { amenity: true }, emoji: '📍', tipo: 'Lugar', cat: 'other' },
  { match: { leisure: true }, emoji: '📍', tipo: 'Lugar', cat: 'other' },
];
const osmToMeta = tags => {
  for (const r of OSM_RULES) {
    let ok = true;
    for (const [k, v] of Object.entries(r.match)) {
      if (v === true) { if (!tags[k]) { ok = false; break; } }
      else if (tags[k] !== v) { ok = false; break; }
    }
    if (ok) return { emoji: r.emoji, tipo: r.tipo, cat: r.cat };
  }
  return { emoji: '📍', tipo: 'Lugar', cat: 'other' };
};

// Antes esto era una whitelist de ~20 valores de amenity/shop: cualquier
// comercio con un tag que no estuviera en esa lista quedaba afuera del
// import sin ningún aviso. Ahora se pide cualquier node/way que tenga
// "name" + alguno de estos tags "genéricos" (shop=*, amenity=*, etc.),
// sin filtrar por valor — así entra todo lo que OSM tiene mapeado como
// comercio/servicio, y osmToMeta() de arriba es la que decide después
// cómo mostrarlo (emoji/tipo/categoría).
const OVERPASS_TAG_QUERY = `
  node["name"]["shop"](__BBOX__);
  node["name"]["amenity"](__BBOX__);
  node["name"]["office"](__BBOX__);
  node["name"]["leisure"](__BBOX__);
  node["name"]["healthcare"](__BBOX__);
  node["name"]["craft"](__BBOX__);
  node["name"]["tourism"](__BBOX__);
  way["name"]["shop"](__BBOX__);
  way["name"]["amenity"](__BBOX__);
  way["name"]["office"](__BBOX__);
  way["name"]["leisure"](__BBOX__);
  way["name"]["healthcare"](__BBOX__);
`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// bbox: [south, west, north, east]
const buildQuery = bbox => {
  const b = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
  return `[out:json][timeout:60];(${OVERPASS_TAG_QUERY.replace(/__BBOX__/g, b)});out center;`;
};

// Prueba cada espejo en orden, con reintentos, antes de dar por perdido el tile.
async function fetchOverpassTile(bbox, mirrorStart = 0) {
  const query = buildQuery(bbox);
  let lastErr;
  for (let attempt = 0; attempt < RETRIES_PER_TILE; attempt++) {
    const mirror = OVERPASS_MIRRORS[(mirrorStart + attempt) % OVERPASS_MIRRORS.length];
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'QooentumPro-Import/1.0 (contacto: daniel.galan.romano@gmail.com)',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      });
      if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} en ${mirror}`);
      const data = await res.json();
      return data.elements || [];
    } catch (e) {
      lastErr = e;
      console.warn(`  ⚠️ tile falló en ${mirror} (intento ${attempt + 1}/${RETRIES_PER_TILE}): ${e.message}`);
      await sleep(1500 * (attempt + 1));
    }
  }
  console.error(`  ❌ tile [${bbox.join(',')}] falló en todos los intentos: ${lastErr?.message}`);
  return [];
}

const elementToRow = el => {
  const lat = el.lat ?? el.center?.lat ?? null;
  const lng = el.lon ?? el.center?.lon ?? null;
  const tags = el.tags || {};
  const name = tags.name || tags['name:es'] || null;
  if (lat == null || lng == null || !name) return null;
  const meta = osmToMeta(tags);
  return {
    id: `osm-${el.type}-${el.id}`,
    name,
    type: meta.tipo,
    logo: meta.emoji,
    cat: meta.cat,
    addr: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || tags.address || '',
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    rating: +(3.5 + ((el.id % 14) * 0.1)).toFixed(1),
    reviews_n: 10 + (el.id % 190),
    verified: false,
    open: true,
    source: 'osm',
  };
};

// ---- Grid: parte el bbox pedido en celdas de ~tileKm x tileKm ----
// Overpass en un bbox gigante ("ciudad entera") tiende a cortarse por
// timeout; tilear en pedazos chicos es más lento por request pero
// mucho más confiable en conjunto (y cada tile es reintentable solo).
function makeGrid(bboxDeg, tileKm) {
  const [south, west, north, east] = bboxDeg;
  const kmPerDegLat = 111;
  const kmPerDegLng = 111 * Math.cos((((south + north) / 2) * Math.PI) / 180);
  const stepLat = tileKm / kmPerDegLat;
  const stepLng = tileKm / kmPerDegLng;
  const tiles = [];
  for (let lat = south; lat < north; lat += stepLat) {
    for (let lng = west; lng < east; lng += stepLng) {
      tiles.push([lat, lng, Math.min(lat + stepLat, north), Math.min(lng + stepLng, east)]);
    }
  }
  return tiles;
}

function bboxFromCenterRadius(lat, lng, radiusKm) {
  const kmPerDegLat = 111;
  const kmPerDegLng = 111 * Math.cos((lat * Math.PI) / 180);
  const dLat = radiusKm / kmPerDegLat;
  const dLng = radiusKm / kmPerDegLng;
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng];
}

async function upsertBatch(rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase.from('places').upsert(chunk, { onConflict: 'id' });
    if (error) {
      console.error(`  ❌ error en upsert de lote (${chunk.length} filas):`, error.message);
    } else {
      console.log(`  ✅ upsert OK: ${chunk.length} lugares (lote ${i / UPSERT_BATCH_SIZE + 1})`);
    }
  }
}

async function main() {
  let bbox; // [south, west, north, east]
  if (args.bbox) {
    bbox = String(args.bbox).split(',').map(Number);
  } else {
    const lat = parseFloat(args.lat ?? '-34.6083');
    const lng = parseFloat(args.lng ?? '-58.3896');
    const radiusKm = parseFloat(args['radius-km'] ?? '10');
    bbox = bboxFromCenterRadius(lat, lng, radiusKm);
  }
  const tileKm = parseFloat(args['tile-km'] ?? TILE_KM_DEFAULT);
  const tiles = makeGrid(bbox, tileKm);

  console.log(`📍 bbox: [${bbox.map(n => n.toFixed(4)).join(', ')}]`);
  console.log(`🧩 ${tiles.length} tiles de ~${tileKm}km`);

  const seen = new Map(); // dedupe por id entre tiles solapados
  let mirrorIdx = 0;

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    console.log(`\n[${i + 1}/${tiles.length}] tile [${tile.map(n => n.toFixed(4)).join(',')}]`);
    const elements = await fetchOverpassTile(tile, mirrorIdx++);
    let added = 0;
    for (const el of elements) {
      const row = elementToRow(el);
      if (row && !seen.has(row.id)) { seen.set(row.id, row); added++; }
    }
    console.log(`  → ${elements.length} elementos, ${added} nuevos (acumulado: ${seen.size})`);
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  const rows = [...seen.values()];
  console.log(`\n💾 Escribiendo ${rows.length} lugares en Supabase (upsert por id, lotes de ${UPSERT_BATCH_SIZE})...`);
  await upsertBatch(rows);
  console.log('\n🎉 Listo. Podés re-correr este script cuando quieras: es idempotente.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });