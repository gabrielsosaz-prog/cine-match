/// <reference types="vitest" />
import { defineConfig, loadEnv, type Plugin, type Connect } from 'vite';
// @ts-ignore módulo JS compartido con la función serverless
import { proxyTmdb, sameOrigin } from './server/tmdbProxy.js';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Proxy /api/tmdb y /api/health para `npm run dev` y `npm run preview`.
 * Lee TMDB_READ_ACCESS_TOKEN de .env del lado servidor (sin prefijo VITE_, nunca llega al bundle).
 */
function tmdbDevProxy(token?: string): Plugin {
  const mw: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, headers: Record<string, string>, body: string) => { res.statusCode = status; for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(body); };
    if (url.pathname === '/api/health') {
      if (!token) return send(503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, tokenConfigured: false }));
      const r = await proxyTmdb('/genre/movie/list', new URLSearchParams({ language: 'es-MX' }), token);
      return send(r.status === 200 ? 200 : 502, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: r.status === 200, tokenConfigured: true, tmdbStatus: r.status }));
    }
    if (!url.pathname.startsWith('/api/tmdb/')) return next();
    if (!sameOrigin(req.headers.host, req.headers.origin as string, req.headers.referer)) return send(403, {}, 'origin_not_allowed');
    const r = await proxyTmdb(url.pathname.slice('/api/tmdb'.length), url.searchParams, token);
    send(r.status, r.headers, r.body);
  };
  return { name: 'tmdb-dev-proxy', configureServer: (s) => { s.middlewares.use(mw); }, configurePreviewServer: (s) => { s.middlewares.use(mw); } };
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    tmdbDevProxy(loadEnv(mode, process.cwd(), '').TMDB_READ_ACCESS_TOKEN),
    react(),
    VitePWA({
      // v3.0: «prompt» en lugar de «autoUpdate»: una versión nueva nunca recarga la app en medio de un guardado.
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Cine Match AI',
        short_name: 'Cine Match',
        description: 'Recomendaciones personales de películas y series en Netflix, Prime Video, Disney+ y Max.',
        lang: 'es-AR',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0d12',
        theme_color: '#0b0d12',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: 'index.html',
        // El catálogo narrativo (varios MB) no se precarga: se descarga al usarse y queda en caché por versión
        globIgnores: ['catalog/**'],
        navigateFallbackDenylist: [/^\/catalog\//, /^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/catalog\/manifest\.json$/.test(url.pathname),
            handler: 'NetworkFirst',
            options: { cacheName: 'catalog-manifest', networkTimeoutSeconds: 4 },
          },
          {
            urlPattern: ({ url }) => /\/catalog\/v[^/]+\//.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'catalog-data', expiration: { maxEntries: 6 } },
          },
          {
            urlPattern: /^https:\/\/image\.tmdb\.org\//,
            handler: 'CacheFirst',
            options: { cacheName: 'posters', expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    setupFiles: ['tests/unit/setup.ts'],
  },
}));
