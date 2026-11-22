/**
 * Proxy de TMDB del lado servidor. La credencial se lee de la variable de entorno
 * TMDB_READ_ACCESS_TOKEN y nunca llega al navegador.
 * Lo usan: la función serverless de Vercel (api/tmdb.js) y el servidor de desarrollo de Vite.
 */
export const ALLOWED_PATH = /^\/(search\/(multi|person)|person\/\d+(\/combined_credits)?|(movie|tv)\/\d+\/videos|watch\/providers\/(movie|tv)|discover\/(movie|tv)|trending\/(movie|tv)\/week|genre\/(movie|tv)\/list|(movie|tv)\/\d+(\/watch\/providers)?|configuration)$/;
const ALLOWED_PARAMS = new Set(['query', 'language', 'include_adult', 'page', 'append_to_response', 'watch_region', 'with_watch_providers', 'with_watch_monetization_types', 'with_genres', 'sort_by', 'vote_count.gte',
  'without_genres', 'with_keywords', 'with_cast', 'with_people', 'with_crew', 'with_original_language', 'with_origin_country', 'include_video_language', 'primary_release_date.gte', 'primary_release_date.lte', 'first_air_date.gte', 'first_air_date.lte', 'with_runtime.gte', 'with_runtime.lte']);

/**
 * @param {string} path ruta de TMDB sin el prefijo /3 (ej. "/search/multi")
 * @param {URLSearchParams} params
 * @param {string | undefined} token
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ status: number, body: string, headers: Record<string,string> }>}
 */
export async function proxyTmdb(path, params, token, fetchImpl = fetch) {
  const json = { 'Content-Type': 'application/json; charset=utf-8' };
  if (!token) return { status: 503, headers: json, body: JSON.stringify({ error: 'missing_token', message: 'Falta la variable de entorno TMDB_READ_ACCESS_TOKEN en el servidor.' }) };
  if (!ALLOWED_PATH.test(path)) return { status: 404, headers: json, body: JSON.stringify({ error: 'path_not_allowed' }) };
  const upstream = new URL('https://api.themoviedb.org/3' + path);
  for (const [k, v] of params) if (ALLOWED_PARAMS.has(k)) upstream.searchParams.set(k, v.slice(0, 200));
  let res;
  try {
    res = await fetchImpl(upstream.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  } catch (e) {
    return { status: 502, headers: json, body: JSON.stringify({ error: 'upstream_unreachable' }) };
  }
  const body = await res.text();
  const headers = { ...json, 'Cache-Control': res.ok ? 'public, s-maxage=3600, max-age=600' : 'no-store' };
  const retry = res.headers.get('Retry-After');
  if (retry) headers['Retry-After'] = retry;
  return { status: res.status, headers, body };
}

/** Rechaza usos desde otros sitios (el navegador envía Origin/Referer propios). */
export function sameOrigin(host, origin, referer) {
  const src = origin || referer;
  if (!src) return true; // navegación directa o herramientas propias
  try { return new URL(src).host === host; } catch { return false; }
}
