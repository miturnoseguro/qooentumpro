import { defineConfig } from 'vite';

// Nada exótico acá a propósito:
//   - index.html en la raíz es el entrypoint (Vite lo detecta solo).
//   - Todo lo que hoy es "estático y se sirve tal cual" (manifest.json,
//     icons/, sw.js, bright_patched.json) va en /public — Vite lo copia
//     sin tocar a la raíz de dist/ en el build.
//   - src/app.js y src/lib/supabase-api.js se procesan como módulos ES
//     normales (import/export), Vite arma el bundle solo.
export default defineConfig({
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
