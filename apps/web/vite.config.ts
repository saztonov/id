import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin: браузер ходит только в наш BFF, presigned URL наружу не выдаются.
    /**
     * Проксируется не только `/api`.
     *
     * `/auth` и `/me` живут вне версионного префикса, и без них в разработке не
     * работали ни выход, ни обновление CSRF-токена, ни сама проверка сессии —
     * SPA поднималась только собранной сборкой. Форма локального входа без
     * этого не проверяется вовсе.
     *
     * `changeOrigin: false` — тот же выбор, что в e2e-харнессе: заголовок Host
     * остаётся браузерным. Из-за этого `Origin` приходит как `:5173`, а
     * `PUBLIC_URL` указывает на `:3000`, поэтому в разработке нужен
     * `AUTH_LOCAL_ALLOWED_ORIGINS=http://localhost:5173` (в production эта
     * переменная запрещена).
     */
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/auth': { target: 'http://localhost:3000', changeOrigin: false },
      '/me': { target: 'http://localhost:3000', changeOrigin: false },
      '/health': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
