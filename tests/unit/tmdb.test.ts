import { describe, expect, it } from 'vitest';
import { TmdbClient, mapDetails, mapProviders, platformOf } from '../../src/providers/tmdb';
import { ProviderError } from '../../src/providers/errors';
import { buildCatalog, fakeFetch } from '../fixtures/fakeTmdb';

const catalog = buildCatalog(5);
const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('Búsqueda de títulos', () => {
  it('devuelve películas y series, descarta personas', async () => {
    const c = new TmdbClient({ token: 'eyJtest' }, fakeFetch(catalog));
    const r = await c.search('Thriller', 'es-MX');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.type === 'movie' || x.type === 'tv')).toBe(true);
  });
  it('distingue película y serie homónimas aunque compartan id numérico', async () => {
    const c = new TmdbClient({ token: 'eyJtest' }, fakeFetch(catalog));
    const r = await c.search('La Casa', 'es-MX');
    expect(r.map((x) => x.key).sort()).toEqual(['movie:9000', 'tv:9000']);
    expect(new Set(r.map((x) => x.year)).size).toBe(2);
  });
  it('consulta vacía no llama a la API', async () => {
    const f = fakeFetch(catalog);
    expect(await new TmdbClient({ token: 'x' }, f).search('   ', 'es')).toEqual([]);
    expect(f.calls.length).toBe(0);
  });
  it('usa Bearer para token v4 y api_key para clave v3', async () => {
    let seen: { url: string; auth?: string }[] = [];
    const f = async (url: string, init?: RequestInit) => { seen.push({ url, auth: (init?.headers as any)?.Authorization }); return json(200, { genres: [] }); };
    await new TmdbClient({ token: 'eyJabc' }, f).genres('movie', 'es');
    await new TmdbClient({ token: '0123456789abcdef0123456789abcdef' }, f).genres('movie', 'es');
    expect(seen[0].auth).toBe('Bearer eyJabc');
    expect(seen[1].url).toContain('api_key=0123456789abcdef0123456789abcdef');
    expect(seen[1].auth).toBeUndefined();
  });
  it('con proxy no envía credenciales desde el cliente', async () => {
    let seen: any;
    const f = async (url: string, init?: RequestInit) => { seen = { url, init }; return json(200, { genres: [] }); };
    await new TmdbClient({ proxyUrl: 'https://proxy.example/3' }, f).genres('tv', 'es');
    expect(seen.url.startsWith('https://proxy.example/3/genre/tv/list')).toBe(true);
    expect(seen.init.headers.Authorization).toBeUndefined();
  });
});

describe('Errores de proveedores externos', () => {
  it('sin credenciales → config', async () => {
    await expect(new TmdbClient({}).genres('movie', 'es')).rejects.toMatchObject({ kind: 'config' });
  });
  it('401 → auth', async () => {
    await expect(new TmdbClient({ token: 'x' }, async () => json(401)).genres('movie', 'es')).rejects.toMatchObject({ kind: 'auth' });
  });
  it('429 reintenta y luego informa rate_limit', async () => {
    let n = 0;
    const f = async () => { n++; return json(429, {}, { 'Retry-After': '0' }); };
    await expect(new TmdbClient({ token: 'x' }, f).genres('movie', 'es')).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(n).toBe(3);
  });
  it('500 transitorio se recupera con reintento', async () => {
    let n = 0;
    const f = async () => (++n === 1 ? json(500) : json(200, { genres: [{ id: 1, name: 'X' }] }));
    expect(await new TmdbClient({ token: 'x' }, f).genres('movie', 'es')).toHaveLength(1);
  });
  it('fallo de red → network', async () => {
    const f = async () => { throw new TypeError('Failed to fetch'); };
    const e = await new TmdbClient({ token: 'x' }, f).genres('movie', 'es').catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe('network');
  });
  it('JSON inválido → bad_response', async () => {
    const f = async () => new Response('<html>', { status: 200 });
    await expect(new TmdbClient({ token: 'x' }, f).genres('movie', 'es')).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('Datos faltantes y disponibilidad', () => {
  it('marca campos faltantes sin inventarlos', () => {
    const m = mapDetails({ id: 5, title: 'X' }, 'movie', 'es-MX');
    expect(m.year).toBeUndefined();
    expect(m.overview).toBeUndefined();
    expect(m.missing).toEqual(expect.arrayContaining(['sinopsis', 'géneros', 'reparto', 'dirección', 'duración', 'póster', 'fecha de estreno']));
  });
  it('país sin datos → no-data; respuesta rota → error', () => {
    expect(mapProviders('movie:1', { results: { US: {} } }, 'AR').status).toBe('no-data');
    expect(mapProviders('movie:1', null, 'AR').status).toBe('error');
  });
  it('mapea plataformas principales y excluye canales de Amazon', () => {
    expect(platformOf(8, 'Netflix')).toBe('netflix');
    expect(platformOf(1796, 'Netflix basic with Ads')).toBe('netflix');
    expect(platformOf(119, 'Amazon Prime Video')).toBe('prime');
    expect(platformOf(337, 'Disney Plus')).toBe('disney');
    expect(platformOf(1899, 'Max')).toBe('max');
    expect(platformOf(1825, 'HBO Max Amazon Channel')).toBeNull();
    expect(platformOf(167, 'Claro video')).toBeNull();
  });
  it('registra fuente y fecha de verificación', () => {
    const s = mapProviders('tv:2', { results: { AR: { flatrate: [{ provider_id: 8, provider_name: 'Netflix' }] } } }, 'AR');
    expect(s.source).toBe('TMDB / JustWatch');
    expect(Date.now() - s.checkedAt).toBeLessThan(1000);
    expect(s.offers[0].platform).toBe('netflix');
  });
});
