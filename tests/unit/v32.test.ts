/**
 * Pruebas de Cine Match v3.2: filtros de países y actores (incluidos/excluidos), búsqueda tolerante de personas,
 * «Buscar por reparto», tráileres por prioridad, persistencia de filtros y conservación de datos.
 *
 * Usan el catálogo SINTÉTICO con formato TMDB y un proveedor SIMULADO: verifican la lógica en casos controlados.
 * La validación con datos reales de TMDB (Michael J. Fox, DiCaprio, Ben Affleck + Jennifer Lopez) está en
 * tests/prod/v32.spec.ts y se ejecuta contra producción.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db, useTestDb } from '../../src/db/db';
import { ensureBootstrap, listRatings, updateConfig, updateSettings } from '../../src/db/repo';
import { setFetch } from '../../src/services/catalog';
import { activeFilters, countriesOf, DEFAULT_FILTERS, filterLabel, includedPeople, loadFilters, matchesContent, migrateFilters, saveFilters, without, type RankFilters } from '../../src/services/filters';
import { nameMatch, rankPeople, spellingVariants, tolerantPeopleSearch } from '../../src/services/peopleSearch';
import { peopleSets } from '../../src/services/peopleFilter';
import { rateAndLearn } from '../../src/services/ratings';
import { resetRatingsStore } from '../../src/services/ratingsStore';
import { resetRecompute } from '../../src/services/recompute';
import { rankWithFilters, refreshRecommendations } from '../../src/services/recommendations';
import { chooseTrailer, needsExternalSearch, rankTrailers, youtubeSearchUrl } from '../../src/services/trailers';
import type { PersonHit, VideoInfo } from '../../src/providers/tmdb';
import type { RecommendationRun, TitleKey, TitleMeta } from '../../src/types';
import { buildCatalog, countryOf, fakeFetch, type FakeTitle } from '../fixtures/fakeTmdb';

const P = 'p-principal';
const catalog = buildCatalog(15);
const keyOf = (t: FakeTitle) => `${t.type}:${t.id}` as TitleKey;
const byKey = new Map(catalog.map((t) => [keyOf(t), t]));
const F = (o: Partial<RankFilters>): RankFilters => ({ ...DEFAULT_FILTERS, watched: 'all', ...o });
const actor = (id: number) => ({ id, name: `Actor ${id}`, department: 'Acting' });
/** Países tal como los publica el simulador (origen + producción, con coproducción MX en ids múltiplos de 7) */
const countriesFake = (t: FakeTitle) => [countryOf(t), ...(t.type === 'movie' && t.id % 7 === 0 ? ['MX'] : [])];

async function freshDb(tag: string) {
  resetRecompute(); resetRatingsStore();
  useTestDb(`v32-${tag}-${Math.random().toString(36).slice(2)}`);
  setFetch(fakeFetch(catalog));
  await ensureBootstrap();
  await updateConfig({ tmdbToken: 'eyJtest' });
  await updateSettings(P, { platforms: ['netflix', 'prime', 'disney', 'max'], country: 'AR' });
}
const emptyRun = (): RecommendationRun => ({ profileId: P, algorithmVersion: '', createdAt: 0, trigger: '', ratingsCount: 0, country: 'AR', items: [], pool: [] });
async function keysOf(f: RankFilters, opts: { anyPlatform?: boolean; run?: RecommendationRun } = {}) {
  const r = await rankWithFilters(P, opts.run ?? (await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true })), f, { discover: false, anyPlatform: opts.anyPlatform });
  return { r, keys: r.items.map((i) => i.key) };
}

// Pares de actores del simulador con y sin títulos en común
const castIds = [...new Set(catalog.flatMap((t) => t.cast))];
const titlesWith = (id: number) => catalog.filter((t) => t.cast.includes(id));
const together = (a: number, b: number) => titlesWith(a).filter((t) => t.cast.includes(b));
const pairWith = castIds.flatMap((a) => castIds.filter((b) => b > a && together(a, b).length >= 2 && titlesWith(a).length > together(a, b).length).map((b) => [a, b] as const))[0];
const pairWithout = castIds.flatMap((a) => castIds.filter((b) => b > a && together(a, b).length === 0).map((b) => [a, b] as const))[0];

// ═════════════ Países ═════════════
describe('v3.2 · países incluidos y excluidos', () => {
  const meta = (o: Partial<TitleMeta>): TitleMeta => ({ key: 'movie:1' as TitleKey, type: 'movie', tmdbId: 1, title: 'X', genres: [], keywords: [], cast: [], directors: [], writers: [], completeness: 'full', missing: [], source: 't', fetchedAt: 0, metaVersion: 3, ...o });
  const ar = meta({ originCountry: ['AR'], productionCountries: ['AR'] });
  const arEs = meta({ originCountry: ['AR'], productionCountries: ['AR', 'ES'] });
  const esMx = meta({ originCountry: ['ES'], productionCountries: ['ES', 'MX'] });
  const us = meta({ originCountry: ['US'], productionCountries: ['US'] });
  const ok = (t: TitleMeta, f: Partial<RankFilters>) => matchesContent({ meta: t }, F(f));

  it('1. país incluido: basta uno de los incluidos («cualquiera»)', () => {
    expect(ok(ar, { includeCountries: ['AR', 'ES'] })).toBe(true);
    expect(ok(esMx, { includeCountries: ['AR', 'ES'] })).toBe(true);
    expect(ok(us, { includeCountries: ['AR', 'ES'] })).toBe(false);
  });
  it('2. país excluido: quita cualquier título con ese país', () => {
    expect(ok(esMx, { excludeCountries: ['MX'] })).toBe(false);
    expect(ok(us, { excludeCountries: ['MX'] })).toBe(true);
  });
  it('3. coproducciones: cuentan todos los países de producción y el de origen', () => {
    expect(countriesOf(arEs)).toEqual(['AR', 'ES']);
    expect(ok(arEs, { includeCountries: ['ES'] })).toBe(true);
    // origen y producción se distinguen
    expect(ok(arEs, { includeCountries: ['ES'], countryField: 'origin' })).toBe(false);
    expect(ok(arEs, { includeCountries: ['ES'], countryField: 'production' })).toBe(true);
    expect(ok(esMx, { excludeCountries: ['MX'], countryField: 'origin' })).toBe(true);
  });
  it('4. incluidos y excluidos a la vez: la exclusión manda', () => {
    const f = { includeCountries: ['AR', 'ES'], excludeCountries: ['MX'] };
    expect(ok(ar, f)).toBe(true);
    expect(ok(arEs, f)).toBe(true);
    expect(ok(esMx, f)).toBe(false); // España incluida, pero coproducción con México excluido
    expect(ok(us, f)).toBe(false);
    expect(filterLabel('excludeCountries', F(f), String, String)).toBe('Países excluidos: México');
    expect(filterLabel('includeCountries', F(f), String, String)).toBe('Países incluidos: Argentina o España');
  });
  it('con el catálogo: excluir MX quita también las coproducciones con MX', async () => {
    await freshDb('countries');
    const { keys } = await keysOf(F({ includeCountries: ['US', 'ES'], excludeCountries: ['MX'] }), { anyPlatform: true });
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const cs = countriesFake(byKey.get(k)!);
      expect(cs).not.toContain('MX');
      expect(cs.some((c) => ['US', 'ES'].includes(c))).toBe(true);
    }
  });
});

// ═════════════ Actores ═════════════
describe('v3.2 · actores incluidos y excluidos (filmografías de TMDB)', () => {
  beforeEach(() => freshDb('people'));
  it('el simulador tiene pares con y sin obras en común', () => {
    expect(pairWith).toBeDefined();
    expect(pairWithout).toBeDefined();
  });
  it('5. actor incluido: todos sus títulos, aunque no estén en el ranking', async () => {
    const [a] = pairWith;
    const { r, keys } = await keysOf(F({ includePeople: [actor(a)] }), { anyPlatform: true, run: emptyRun() });
    expect(new Set(keys)).toEqual(new Set(titlesWith(a).map(keyOf)));
    expect(r.peopleTotal).toBe(titlesWith(a).length);
  });
  it('6. actor excluido: quita todo título donde aparece', async () => {
    const [a] = pairWith;
    const { keys } = await keysOf(F({ excludePeople: [actor(a)] }), { anyPlatform: true });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => byKey.get(k)!.cast.includes(a))).toBe(false);
  });
  it('7. dos actores en «Todos»: sólo obras donde actúan ambos', async () => {
    const [a, b] = pairWith;
    const { keys } = await keysOf(F({ includePeople: [actor(a), actor(b)], peopleMode: 'all' }), { anyPlatform: true, run: emptyRun() });
    expect(new Set(keys)).toEqual(new Set(together(a, b).map(keyOf)));
    expect(filterLabel('includePeople', F({ includePeople: [actor(a), actor(b)], peopleMode: 'all' }), String, String)).toBe(`Actores incluidos: Actor ${a} y Actor ${b} · Coincidencia: Todos`);
  });
  it('8. dos actores en «Cualquiera»: la unión de sus filmografías', async () => {
    const [a, b] = pairWith;
    const { keys } = await keysOf(F({ includePeople: [actor(a), actor(b)], peopleMode: 'any' }), { anyPlatform: true, run: emptyRun() });
    expect(new Set(keys)).toEqual(new Set([...titlesWith(a), ...titlesWith(b)].map(keyOf)));
  });
  it('9. un actor incluido y otro excluido: la exclusión manda', async () => {
    const [a, b] = pairWith;
    const { keys } = await keysOf(F({ includePeople: [actor(a)], excludePeople: [actor(b)] }), { anyPlatform: true, run: emptyRun() });
    expect(new Set(keys)).toEqual(new Set(titlesWith(a).filter((t) => !t.cast.includes(b)).map(keyOf)));
    const sets = await peopleSets(F({ includePeople: [actor(a)], excludePeople: [actor(b)] }), 'es-MX');
    for (const t of together(a, b)) expect(sets!.allow!.has(keyOf(t))).toBe(false);
  });
  it('10. actores combinados con países, tipo y plataformas', async () => {
    const [a, b] = pairWith;
    const f = F({ includePeople: [actor(a), actor(b)], peopleMode: 'any', excludeCountries: ['MX'], types: ['movie'] });
    const { keys } = await keysOf(f, { anyPlatform: true, run: emptyRun() });
    const expected = [...new Set([...titlesWith(a), ...titlesWith(b)])].filter((t) => t.type === 'movie' && !countriesFake(t).includes('MX'));
    expect(new Set(keys)).toEqual(new Set(expected.map(keyOf)));
    // Con plataformas: sólo los que están en las del perfil; los demás se cuentan como «fuera de tus plataformas»
    const mine = await keysOf(F({ includePeople: [actor(a)] }), { run: emptyRun() });
    const snaps = await db.availability.bulkGet(mine.keys.map((k) => `${k}|AR`));
    expect(snaps.every((s) => s && s.offers.some((o) => ['netflix', 'prime', 'disney', 'max'].includes(o.platform)))).toBe(true);
    expect(mine.keys.length + (mine.r.outsidePlatforms ?? 0)).toBe(titlesWith(a).length);
  });
  it('15. resultado vacío legítimo: dos actores sin obras en común', async () => {
    const [a, b] = pairWithout;
    const { r } = await keysOf(F({ includePeople: [actor(a), actor(b)], peopleMode: 'all' }), { anyPlatform: true, run: emptyRun() });
    expect(r.items).toEqual([]);
    expect(r.peopleTotal).toBe(0);
    expect(r.perPerson!.every((p) => p.count > 0)).toBe(true); // cada uno tiene obras, pero no juntos
  });
  it('homónimos: un id de dirección no suma créditos de reparto', async () => {
    const sets = await peopleSets(F({ includePeople: [{ id: 99231, name: 'Actor 231', department: 'Directing' }] }), 'es-MX');
    expect(sets!.allow!.size).toBe(0);
  });
});

// ═════════════ Búsqueda de personas ═════════════
describe('v3.2 · búsqueda tolerante de personas', () => {
  const hit = (id: number, name: string, popularity: number, knownFor: string[] = []): PersonHit => ({ id, name, popularity, department: 'Acting', profilePath: null, knownFor });
  // Respuestas tomadas de TMDB real (ejecución de investigación): ids y nombres reales, popularidad aproximada
  const MJF = hit(521, 'Michael J. Fox', 4.5, ['Volver al futuro']);
  const OTHER_FOX = hit(51230, 'Michael Fox', 0.3);
  const LEO = hit(6193, 'Leonardo DiCaprio', 12, ['Titanic', 'El origen']);
  const BEN = hit(880, 'Ben Affleck', 6, ['Argo']);
  const JLO = hit(16866, 'Jennifer Lopez', 5, ['Hustlers']);
  const JLO_HOMONYM = hit(5091952, 'Jenifer López Miles', 0);
  const db: Record<string, PersonHit[]> = {
    'michael fox': [OTHER_FOX, MJF], 'michael j fox': [MJF], 'leonardo dicaprio': [LEO], dicaprio: [LEO], affleck: [BEN, hit(15556, 'Casey Affleck', 3)],
    'ben affleck': [BEN], lopez: [JLO, hit(77, 'George Lopez', 2)], 'jennifer lopez': [JLO], 'jenifer lopez': [JLO_HOMONYM],
  };
  const search = async (q: string) => db[q.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()] ?? [];

  it('11. «Michael Fox» identifica a Michael J. Fox (inicial intermedia ignorada, popularidad desempata)', async () => {
    expect(nameMatch('Michael Fox', 'Michael J. Fox')).toBe(1);
    const { people } = await tolerantPeopleSearch('Michael Fox', search);
    expect(people[0].id).toBe(521);
    expect(people.map((p) => p.id)).toContain(51230); // el homónimo sigue visible, por separado
    expect(new Set(people.map((p) => p.id)).size).toBe(people.length); // nunca se mezclan personas
  });
  it('12. «Michael J. Fox» lo encuentra directo', async () => {
    const { people, corrected } = await tolerantPeopleSearch('Michael J. Fox', search);
    expect(people[0].id).toBe(521);
    expect(corrected).toBeUndefined();
  });
  it('13. «Leonardo DiCaprio» y variantes: mayúsculas, tildes, «Di Caprio», «Leonard DiCaprio»', async () => {
    for (const q of ['Leonardo DiCaprio', 'leonardo dicaprio', 'Leonardo Di Caprio', 'Leonard DiCaprio', 'Leonárdo Dicaprio']) {
      const { people } = await tolerantPeopleSearch(q, search);
      expect(people[0]?.id, q).toBe(6193);
    }
    expect(spellingVariants('Leonardo Di Caprio')).toContain('leonardo dicaprio');
  });
  it('14. «Ben Afleck» y «Jenifer Lopez» (errores de escritura) llegan a Ben Affleck y Jennifer Lopez', async () => {
    const ben = await tolerantPeopleSearch('Ben Afleck', search);
    expect(ben.people[0].id).toBe(880);
    expect(ben.people[0].fuzzy).toBe(true);
    expect(ben.corrected).toBe('Ben Affleck');
    const jlo = await tolerantPeopleSearch('Jenifer Lopez', search);
    expect(jlo.people[0].id).toBe(16866); // antes que la homónima casi desconocida
    expect(jlo.people.map((p) => p.id)).toContain(5091952);
  });
  it('no confunde personas distintas: nombres sin parecido quedan fuera', () => {
    expect(nameMatch('Ben Affleck', 'Casey Affleck')).toBeLessThan(0.72);
    expect(nameMatch('Michael Fox', 'Megan Fox')).toBeLessThan(0.72);
    const r = rankPeople('Ben Affleck', [[hit(15556, 'Casey Affleck', 3), BEN]]);
    expect(r[0].id).toBe(880);
  });
});

// ═════════════ Tráileres ═════════════
describe('v3.2 · tráileres por prioridad', () => {
  const v = (o: Partial<VideoInfo>): VideoInfo => ({ key: 'k' + Math.random().toString(36).slice(2), site: 'YouTube', name: 'Trailer', type: 'Trailer', official: true, ...o });
  it('16. tráiler oficial en español primero', () => {
    const list = rankTrailers([v({ language: 'en', name: 'Official Trailer' }), v({ language: 'es', name: 'Tráiler oficial doblado', region: 'MX' })], 'en');
    expect(list[0].rank).toBe(1);
    expect(list[0].audio).toBe('Audio en español (oficial)');
    expect(list.map((c) => c.rank)).toEqual([1, 4]); // también se puede elegir la versión original
    expect(needsExternalSearch(list)).toBe(false);
  });
  it('17. subtítulos confirmados sólo si el título del vídeo lo indica', () => {
    const c = chooseTrailer([v({ language: 'en', name: 'Official Trailer' }), v({ language: 'es', name: 'Tráiler oficial subtitulado' })], 'en')!;
    expect(c.rank).toBe(2);
    expect(c.subsEs).toBe(true);
    expect(c.audio).toMatch(/indicados en el título/);
    // «legendado» es portugués: no se presenta como subtítulos en español
    const pt = chooseTrailer([v({ language: 'pt', name: 'Trailer Legendado' })], 'en')!;
    expect(pt.subsEs).toBe(false);
    expect(pt.rank).toBe(4);
  });
  it('18. sin subtítulos conocidos: se ofrece el original sin afirmar subtítulos, más la búsqueda externa', () => {
    const list = rankTrailers([v({ language: 'en', name: 'Official Trailer' }), v({ language: 'en', type: 'Teaser', name: 'Teaser' })], 'en');
    expect(list.map((c) => c.rank)).toEqual([4, 5]);
    expect(list.every((c) => !c.subsEs)).toBe(true);
    expect(list[0].audio).toMatch(/no confirmados/);
    expect(needsExternalSearch(list)).toBe(true);
    // el idioma del vídeo (es) no se toma como idioma de subtítulos
    expect(chooseTrailer([v({ language: 'es', name: 'Trailer' })], 'en')!.subsEs).toBe(false);
  });
  it('19. búsqueda externa en YouTube: título + año + «tráiler subtitulado español», nunca un vídeo', () => {
    const url = youtubeSearchUrl('Parásitos', 2019);
    expect(url.startsWith('https://www.youtube.com/results?search_query=')).toBe(true);
    expect(decodeURIComponent(url.split('=')[1])).toBe('Parásitos 2019 tráiler subtitulado español');
    expect(url).not.toMatch(/watch\?v=/);
  });
});

// ═════════════ Persistencia y datos ═════════════
describe('v3.2 · persistencia de filtros y conservación de datos', () => {
  beforeEach(() => freshDb('persist'));
  it('21. los filtros se guardan, se recuperan y se quita uno sin borrar los demás', () => {
    const f = F({ includePeople: [actor(880), actor(16866)], peopleMode: 'all', excludePeople: [actor(5)], includeCountries: ['AR', 'ES'], excludeCountries: ['MX'], includeGenres: [18] });
    saveFilters(P, f);
    const back = loadFilters(P);
    expect(back).toEqual(f);
    expect(activeFilters(back)).toEqual(expect.arrayContaining(['includePeople', 'excludePeople', 'includeCountries', 'excludeCountries', 'includeGenres']));
    const sinMx = without(back, 'excludeCountries');
    expect(sinMx.excludeCountries ?? []).toEqual([]);
    expect(sinMx.includePeople).toEqual(f.includePeople);
    expect(sinMx.includeCountries).toEqual(['AR', 'ES']);
  });
  it('migración idempotente del filtro de actor de v3.1', () => {
    const old = F({ person: actor(231) });
    const m1 = migrateFilters(old);
    expect(m1.person).toBeUndefined();
    expect(m1.includePeople).toEqual([actor(231)]);
    expect(migrateFilters(m1)).toEqual(m1);
    expect(includedPeople(old)).toEqual([actor(231)]); // compatibilidad sin migrar
    localStorage.setItem(`cine-match:filters:${P}`, JSON.stringify(old));
    const loaded = loadFilters(P);
    expect(includedPeople(loaded)).toEqual([actor(231)]);
  });
  it('22. buscar y filtrar no modifica valoraciones, vistos, descartes ni preferencias', async () => {
    const t = catalog[3];
    await rateAndLearn(P, keyOf(t), { watched: true, overall: 8, dimensions: {} });
    await rateAndLearn(P, keyOf(catalog[4]), { watched: false, list: 'dismissed', dimensions: {} } as never);
    const before = JSON.stringify((await listRatings(P)).map((r) => [r.key, r.overall, r.watched, r.list]));
    const settingsBefore = JSON.stringify(await db.settings.toArray());
    await keysOf(F({ includePeople: [actor(pairWith[0])], excludeCountries: ['MX'] }), { anyPlatform: true });
    await peopleSets(F({ excludePeople: [actor(pairWith[1])] }), 'es-MX');
    expect(JSON.stringify((await listRatings(P)).map((r) => [r.key, r.overall, r.watched, r.list]))).toBe(before);
    expect(JSON.stringify(await db.settings.toArray())).toBe(settingsBefore);
  });
});
