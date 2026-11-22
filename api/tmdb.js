// Función serverless de Vercel: /api/tmdb/<ruta de TMDB>?<parámetros>
// (vercel.json reescribe /api/tmdb/* a esta función con ?p=<ruta>).
import { proxyTmdb, sameOrigin } from '../server/tmdbProxy.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!sameOrigin(req.headers.host, req.headers.origin, req.headers.referer)) return res.status(403).json({ error: 'origin_not_allowed' });
  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = '/' + String(url.searchParams.get('p') ?? '').replace(/^\/+/, '');
  url.searchParams.delete('p');
  const out = await proxyTmdb(path, url.searchParams, process.env.TMDB_READ_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.status(out.status).send(out.body);
}
