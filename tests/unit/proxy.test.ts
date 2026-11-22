import { describe, expect, it } from 'vitest';
// @ts-ignore módulo JS del servidor
import { proxyTmdb, sameOrigin } from '../../server/tmdbProxy.js';

const TOKEN = 'eyJ-token-secreto';

describe('Proxy de TMDB del lado servidor', () => {
  it('agrega el token como Bearer sólo hacia TMDB y no lo devuelve', async () => {
    let seen: { url: string; auth: string } | undefined;
    const f = async (url: string, init: any) => { seen = { url, auth: init.headers.Authorization }; return new Response('{"results":[]}', { status: 200 }); };
    const r = await proxyTmdb('/search/multi', new URLSearchParams({ query: 'dark', language: 'es-MX' }), TOKEN, f);
    expect(r.status).toBe(200);
    expect(seen!.url).toBe('https://api.themoviedb.org/3/search/multi?query=dark&language=es-MX');
    expect(seen!.auth).toBe(`Bearer ${TOKEN}`);
    expect(r.body + JSON.stringify(r.headers)).not.toContain(TOKEN);
  });
  it('sin token informa el error sin consultar TMDB', async () => {
    const r = await proxyTmdb('/search/multi', new URLSearchParams(), undefined, async () => { throw new Error('no debería llamar'); });
    expect(r.status).toBe(503);
    expect(r.body).toContain('TMDB_READ_ACCESS_TOKEN');
  });
  it('sólo permite rutas de lectura conocidas y descarta parámetros extra', async () => {
    let called = '';
    const f = async (url: string) => { called = url; return new Response('{}', { status: 200 }); };
    expect((await proxyTmdb('/account/123/rated/movies', new URLSearchParams(), TOKEN, f)).status).toBe(404);
    expect((await proxyTmdb('/../authentication', new URLSearchParams(), TOKEN, f)).status).toBe(404);
    await proxyTmdb('/movie/27205', new URLSearchParams({ append_to_response: 'credits', api_key: 'x', session_id: 'y' }), TOKEN, f);
    expect(called).toBe('https://api.themoviedb.org/3/movie/27205?append_to_response=credits');
  });
  it('propaga errores y Retry-After de TMDB', async () => {
    const f = async () => new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
    const r = await proxyTmdb('/genre/tv/list', new URLSearchParams(), TOKEN, f);
    expect(r.status).toBe(429);
    expect(r.headers['Retry-After']).toBe('2');
  });
  it('TMDB inalcanzable → 502', async () => {
    const r = await proxyTmdb('/genre/tv/list', new URLSearchParams(), TOKEN, async () => { throw new TypeError('fetch failed'); });
    expect(r.status).toBe(502);
  });
  it('rechaza pedidos desde otros sitios', () => {
    expect(sameOrigin('cine.vercel.app', 'https://cine.vercel.app', undefined)).toBe(true);
    expect(sameOrigin('cine.vercel.app', 'https://malicioso.com', undefined)).toBe(false);
    expect(sameOrigin('cine.vercel.app', undefined, 'https://cine.vercel.app/#/buscar')).toBe(true);
  });
});
