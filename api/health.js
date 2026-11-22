// Verifica la conexión con TMDB sin revelar el token: GET /api/health
import { proxyTmdb } from '../server/tmdbProxy.js';

export default async function handler(_req, res) {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ ok: false, tokenConfigured: false, message: 'Falta TMDB_READ_ACCESS_TOKEN' });
  const r = await proxyTmdb('/genre/movie/list', new URLSearchParams({ language: 'es-MX' }), token);
  let genres = 0;
  try { genres = JSON.parse(r.body).genres?.length ?? 0; } catch { /* sin cuerpo */ }
  res.setHeader('Cache-Control', 'no-store');
  res.status(r.status === 200 ? 200 : 502).json({ ok: r.status === 200, tokenConfigured: true, tmdbStatus: r.status, genres, checkedAt: new Date().toISOString() });
}
