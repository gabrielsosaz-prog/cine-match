/**
 * Proxy opcional para TMDB (Cloudflare Workers, plan gratuito).
 * Mantiene la credencial del lado servidor: el frontend nunca la ve.
 *
 * Despliegue:
 *   npm i -g wrangler && wrangler login
 *   wrangler secret put TMDB_TOKEN        # pegar el "Token de acceso de lectura"
 *   wrangler secret put ALLOWED_ORIGIN    # ej. https://TU_USUARIO.github.io
 *   wrangler deploy proxy/cloudflare-worker.js --name cine-match-proxy --compatibility-date 2024-11-01
 * En la app: Ajustes → Fuente de datos → Proxy = https://cine-match-proxy.TU_SUBDOMINIO.workers.dev/3
 */
const ALLOWED_PATHS = /^\/3\/(search\/multi|discover\/(movie|tv)|trending\/(movie|tv)\/week|genre\/(movie|tv)\/list|(movie|tv)\/\d+(\/watch\/providers)?)$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Método no permitido', { status: 405, headers: cors });
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) return new Response('Origen no permitido', { status: 403, headers: cors });
    const url = new URL(request.url);
    if (!ALLOWED_PATHS.test(url.pathname)) return new Response('Ruta no permitida', { status: 404, headers: cors });
    const upstream = new URL('https://api.themoviedb.org' + url.pathname + url.search);
    const res = await fetch(upstream, {
      headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, Accept: 'application/json' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    const body = await res.text();
    return new Response(body, { status: res.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
  },
};
