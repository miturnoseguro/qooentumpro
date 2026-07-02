# Qooentum

## Estructura del proyecto

```
qooentum/
├── index.html                # entrypoint de Vite (<script type="module" src="/src/app.js">)
├── vite.config.js
├── package.json
├── wrangler.toml              # opcional, solo si deployás con `wrangler pages deploy`
├── .env.example                # copiar a .env
├── .gitignore
├── src/
│   ├── app.js                  # toda la lógica de la app (UI, mapa, votos, ranking, premios)
│   └── lib/
│       └── supabase-api.js     # capa de acceso a Supabase (RPC, auth, realtime)
├── scripts/
│   └── import-places.js        # import de comercios desde Overpass/OSM (Node, service_role)
├── sql/
│   ├── 01_schema.sql
│   ├── 02_functions.sql
│   ├── 03_rls.sql
│   └── 04_realtime.sql
└── public/                     # estático, se copia tal cual a dist/ (ver más abajo)
```

⚠️ **`public/` está vacío en esta migración.** Tenés que copiar ahí a mano lo que antes
servías suelto desde la raíz: `manifest.json`, `icons/`, `sw.js`, `bright_patched.json`
(o lo que uses). Vite copia todo lo que esté en `public/` a la raíz de `dist/` sin tocarlo.

## 1) Supabase

Ya tenés el proyecto creado. Corré el SQL **en este orden**, en el SQL Editor de Supabase
(o vía CLI/migrations):

```
sql/01_schema.sql
sql/02_functions.sql
sql/03_rls.sql
sql/04_realtime.sql
```

Después, en **Authentication → Providers**, activá **Google** y cargá el Client ID/Secret
de OAuth (el mismo que tenías en `GOOGLE_CLIENT_ID`, pero ahora configurado del lado de
Supabase, no en el cliente — por eso `app.js` ya no lo necesita).

En **Authentication → URL Configuration**, agregá tu dominio de Cloudflare Pages (y
`http://localhost:5173` para desarrollo) a **Redirect URLs**.

Copiá `Project URL` y `anon public key` (Settings → API) para el paso 2.

## 2) Variables de entorno

```bash
cp .env.example .env
```

Completá `.env` con:
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` → las usa el navegador (`src/lib/supabase-api.js`).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` → las usa **solo** `scripts/import-places.js`
  (Node, nunca llega al navegador). Sacá la `service_role` key de Settings → API — **nunca**
  la pongas con prefijo `VITE_` ni la subas a un repo público.

## 3) Desarrollo local

```bash
npm install
npm run dev      # http://localhost:5173
```

## 4) Import inicial de lugares (Overpass/OSM → tabla `places`)

```bash
npm run import:places -- --lat -34.6083 --lng -58.3896 --radius-km 12
# o por bbox directo:
npm run import:places -- --bbox="-34.71,-58.53,-34.53,-58.33"
```

Es idempotente (upsert por `id`), así que podés re-correrlo para ampliar zona o refrescar
datos sin duplicar nada. Con `sync_places` ya migrado a PostGIS, en producción el mapa deja
de depender de Overpass en el momento — solo lo usa este script, offline/a mano.

Para automatizarlo con cron, un GitHub Action mensual con estos mismos env vars
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` como secrets del repo) alcanza y sobra.

## 5) Build

```bash
npm run build     # genera dist/
npm run preview   # sirve dist/ localmente para probar el build
```

## 6) Deploy en Cloudflare Pages

**Opción A — Git integration (recomendada):** conectá el repo desde el dashboard de
Cloudflare Pages y configurá:

| Setting | Valor |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `/` |
| Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| `NODE_VERSION` | `20` |

Las env vars se cargan en **Settings → Environment variables** (tanto en Production como
Preview). No hace falta `wrangler.toml` para este flujo.

**Opción B — CLI (`wrangler pages deploy`):**

```bash
npm run build
npx wrangler pages deploy dist --project-name qooentum
```

`wrangler.toml` ya está en la raíz con el `pages_build_output_dir` configurado.

### SPA / rutas
Es una app de una sola página (`index.html`), no hace falta `_redirects` para rutas —
Cloudflare Pages sirve `index.html` en la raíz sin problema. Si más adelante agregás rutas
del lado del cliente, ahí sí vas a necesitar un `public/_redirects` con `/* /index.html 200`.

## Qué falta todavía (fuera del alcance de esta migración)
- Copiar los assets estáticos reales a `public/` (`manifest.json`, `icons/`, `sw.js`, etc.).
- Configurar el provider de Google OAuth dentro de Supabase (paso 1).
- Cargar `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` reales en Cloudflare Pages.
- Correr el import inicial contra tu zona real.
