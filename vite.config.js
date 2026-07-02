import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Nada exótico acá a propósito:
//   - index.html y admin.html en la raíz son entrypoints (declarados
//     explícitamente abajo para que Vite incluya admin.html en el build).
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
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
  server: {
    port: 5173,
  },
});
