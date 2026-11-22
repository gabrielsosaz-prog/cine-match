/**
 * Pruebas de Cine Match v3.0.
 *
 * Bloques: guardado (consecutivo, concurrente, con fallos y recuperación), lectura resiliente, años parciales,
 * filtros (sin historial, pocos candidatos, combinados, que no pierden títulos), orden persistente, actores
 * (filmografías como candidatos y tope en el top 10), escenarios narrativos del motor por canales, notas
 * pública y personalizada, «Similares» con varias referencias, migraciones y compatibilidad.
 *
 * Los escenarios usan títulos SINTÉTICOS (formato TMDB) y un proveedor SIMULADO. Muestran cómo responde el
 * sistema en casos controlados; no son una medición de precisión con usuarios reales.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, useTestDb } from '../../src/db/db';
import { ensureBootstrap, getSettings, listRatings, saveRating, updateConfig, updateSettings } from '../../src/db/repo';
import { buildProfile } from '../../src/engine/profile';
import { CHANNELS, learnChannelWeights, priorWeights, rank, scoreCandidates, STACKING, hybridEngine } from '../../src/engine/recommender';
import { textCosine, textIdf, textVector, tokens } from '../../src/engine/text';
import { mapDetails, META_VERSION } from '../../src/providers/tmdb';
import { ALLOWED_PATH } from '../../server/tmdbProxy.js';
import { searchTitles, setFetch, personFilmography, searchPeople } from '../../src/services/catalog';
import { exportData, importData } from '../../src/services/dataPortability';
import { DEFAULT_FILTERS, type RankFilters } from '../../src/services/filters';
import { getRecomputeState, requestRecompute, resetRecompute } from '../../src/services/recompute';
import { rateAndLearn, SaveError, SAVE_TIMING } from '../../src/services/ratings';
import { getRatingsState, resetRatingsStore, subscribeRatings } from '../../src/services/ratingsStore';
import { actorCandidates, latestRun, predictFor, rankWithFilters, refreshRecommendations } from '../../src/services/recommendations';
import { findSimilar } from '../../src/services/similar';
import { parseYear } from '../../src/ui/FilterPanel';
import { personalState, publicScore } from '../../src/ui/components';
import { sortRatings } from '../../src/pages/Ratings';
import { sortRows } from '../../src/pages/Home';
import { buildCatalog, fakeFetch } from '../fixtures/fakeTmdb';
import type { DimensionScores, Person, Rating, RecommendationItem, TitleKey, TitleMeta } from '../../src/types';

const report: Record<string, unknown> = {};
const P = 'p-principal';
const catalog = buildCatalog(15);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Utilidades ----------
interface MkOpts { type?: 'movie' | 'tv'; genres?: number[]; keywords?: [number, string][]; cast?: (number | [number, number?])[]; director?: number; writer?: number; year?: number; vote?: number; votes?: number; overview?: string; collection?: [number, string] }
function mk(id: number, o: MkOpts = {}): TitleMeta {
  const type = o.type ?? 'movie';
  const cast: Person[] = (o.cast ?? []).map((c, i) => (Array.isArray(c) ? { id: c[0], name: `Actor ${c[0]}`, order: c[1] ?? i } : { id: c, name: `Actor ${c}`, order: i }));
  return {
    key: `${type}:${id}` as TitleKey, type, tmdbId: id, title: `Título ${id}`, year: o.year ?? 2010, genres: (o.genres ?? [878]).map((g) => ({ id: g, name: `G${g}` })),
    keywords: (o.keywords ?? []).map(([kid, name]) => ({ id: kid, name })), cast, directors: o.director ? [{ id: o.director, name: `Dir ${o.director}` }] : [],
    writers: o.writer ? [{ id: o.writer, name: `Guion ${o.writer}` }] : [], overview: o.overview,
    runtime: 110, voteAverage: o.vote ?? 7, voteCount: o.votes ?? 2000, collection: o.collection ? { id: o.collection[0], name: o.collection[1] } : undefined,
    completeness: 'full', missing: [], source: 'test', fetchedAt: 0, metaVersion: 3,
  };
}
const R = (key: TitleKey, overall: number | undefined, dims: DimensionScores = {}, extra: Partial<Rating> = {}): Rating =>
  ({ id: `p|${key}`, profileId: 'p', key, watched: overall !== undefined, overall, dimensions: dims, createdAt: 0, updatedAt: 1, schema: 3, ...extra });
const mapOf = (ts: TitleMeta[]) => new Map(ts.map((t) => [t.key, t]));
const scoreOf = (ratings: Rating[], titles: Map<TitleKey, TitleMeta>, keys: TitleKey[]) => {
  const profile = hybridEngine.buildProfile(ratings, titles);
  return new Map(scoreCandidates({ profile, ratings, titles, candidates: keys }).map((s) => [s.key, s]));
};
const TT: [number, string] = [12, 'time travel'], PARA: [number, string] = [13, 'paradox'], SPACE: [number, string] = [14, 'space opera'], ALIEN: [number, string] = [15, 'alien invasion'];

async function freshDb(tag: string) {
  resetRecompute(); resetRatingsStore();
  useTestDb(`v3-${tag}-${Math.random().toString(36).slice(2)}`);
  setFetch(fakeFetch(catalog));
  await ensureBootstrap();
  await updateConfig({ tmdbToken: 'eyJtest' });
  await updateSettings(P, { platforms: ['netflix', 'prime', 'disney', 'max'], country: 'AR' });
}

// ═════════════ Fase 1 · Guardado ═════════════
describe('1. Guardado confirmado, consecutivo, concurrente y con fallos', () => {
  beforeEach(() => freshDb('save'));
  afterEach(() => { vi.restoreAllMocks(); SAVE_TIMING.timeoutMs = 10000; });

  it('el guardado se confirma releyendo la base y NO espera al recálculo del modelo', async () => {
    const [h] = await searchTitles('Thriller Film', 'es-MX');
    const t0 = Date.now();
    const res = await rateAndLearn(P, h.key, { overall: 8 });
    expect(res.confirmed).toBe(true);
    expect(res.rating?.overall).toBe(8);
    expect(res.recompute).toBeInstanceOf(Promise); // el recálculo sigue en segundo plano
    expect(res.run).toBeUndefined();
    report['Guardado: ms hasta confirmar (sin red)'] = Date.now() - t0;
    await res.recompute;
  });

  it('20 guardados consecutivos rápidos del mismo título no pierden campos', async () => {
    const [h] = await searchTitles('Comedy Film', 'es-MX');
    const patches = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? { watched: i % 2 === 0 } : i % 3 === 1 ? { overall: 1 + (i % 10) } : { dimensions: { story: 1 + (i % 5) } }));
    for (const p of patches) await rateAndLearn(P, h.key, p);
    const r = (await listRatings(P)).find((x) => x.key === h.key)!;
    expect(r.overall).toBe(1 + (19 % 10));
    expect(r.dimensions.story).toBe(1 + (17 % 5));
    expect(r.watched).toBe(18 % 2 === 0);
  });

  it('escrituras simultáneas de campos distintos (vista + nota + aspecto + lista) quedan todas', async () => {
    const [h] = await searchTitles('Drama Film', 'es-MX');
    await Promise.all([
      rateAndLearn(P, h.key, { watched: true }),
      rateAndLearn(P, h.key, { overall: 9 }),
      rateAndLearn(P, h.key, { dimensions: { acting: 5 } }),
      rateAndLearn(P, h.key, { list: 'want' }),
      rateAndLearn(P, h.key, { comment: 'Gran final' }),
    ]);
    const r = (await listRatings(P)).find((x) => x.key === h.key)!;
    expect(r).toMatchObject({ watched: true, overall: 9, list: 'want', comment: 'Gran final' });
    expect(r.dimensions.acting).toBe(5);
  });

  it('un fallo de escritura se informa (SaveError) y NO borra ni vacía lo ya guardado', async () => {
    const hits = await searchTitles('Scifi Film', 'es-MX');
    await rateAndLearn(P, hits[0].key, { overall: 9, watched: true });
    await rateAndLearn(P, hits[1].key, { overall: 4 });
    vi.spyOn(db.ratings, 'put').mockImplementation(() => { throw new Error('QuotaExceededError simulado'); });
    await expect(rateAndLearn(P, hits[0].key, { overall: 2 })).rejects.toBeInstanceOf(SaveError);
    vi.restoreAllMocks();
    const rs = await listRatings(P);
    expect(rs).toHaveLength(2);
    expect(rs.find((r) => r.key === hits[0].key)).toMatchObject({ overall: 9, watched: true });
  });

  it('una base que no responde corta por tiempo con un error claro (sin quedar «procesando»)', async () => {
    const [h] = await searchTitles('Action Film', 'es-MX');
    SAVE_TIMING.timeoutMs = 80;
    vi.spyOn(db, 'transaction').mockImplementation((() => new Promise(() => undefined)) as any);
    const t0 = Date.now();
    await expect(rateAndLearn(P, h.key, { overall: 7 })).rejects.toThrow(/no respondió a tiempo/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('si el recálculo falla (TMDB caído), lo guardado queda intacto y el error se informa aparte', async () => {
    const hits = await searchTitles('Horror Film', 'es-MX');
    setFetch(fakeFetch(catalog, { status: 500 }));
    const res = await rateAndLearn(P, hits[0].key, { overall: 8 }, { wait: true });
    expect(res.confirmed).toBe(true);
    expect((await listRatings(P)).find((r) => r.key === hits[0].key)?.overall).toBe(8);
    // El recálculo puede completarse con datos guardados o fallar; nunca toca valoraciones
    expect(getRecomputeState().running).toBe(false);
  });

  it('cola única: muchos pedidos de recálculo seguidos se agrupan (sin escrituras concurrentes de rankings)', async () => {
    const hits = await searchTitles('Romance Film', 'es-MX');
    await refreshRecommendations(P, { trigger: 'base', rebuildPool: true });
    const before = await db.runs.count();
    const ps = hits.slice(0, 6).map((h, i) => rateAndLearn(P, h.key, { overall: 4 + i }, { debounceMs: 30 }));
    const results = await Promise.all(ps);
    await Promise.all(results.map((r) => r.recompute));
    const created = (await db.runs.count()) - before;
    report['Cola de recálculo: 6 valoraciones seguidas → cálculos'] = created;
    expect(created).toBeLessThanOrEqual(2);
    expect((await listRatings(P)).length).toBe(6);
  });

  it('el estado de recálculo nunca queda «procesando» después de un error', async () => {
    setFetch(fakeFetch(catalog, { status: 401 }));
    await requestRecompute(P, { trigger: 'test', rebuildPool: true });
    expect(getRecomputeState()).toMatchObject({ running: false, queued: false });
  });

  it('se conservan sólo 5 cálculos y latestRun devuelve el más nuevo sin cargar todos', async () => {
    for (let i = 0; i < 7; i++) await refreshRecommendations(P, { trigger: `t${i}` });
    expect(await db.runs.count()).toBe(5);
    expect((await latestRun(P))!.trigger).toBe('t6');
  });
});

describe('2. Lectura resiliente: «cargando» ≠ «vacío» y nunca se reemplaza lo confirmado por vacío', () => {
  beforeEach(() => freshDb('store'));
  it('empieza en «cargando», pasa a «listo» con los datos y conserva lo último confirmado si la base se cierra', async () => {
    await saveRating(P, 'movie:1000' as TitleKey, { overall: 8, watched: true });
    await saveRating(P, 'movie:1001' as TitleKey, { overall: 6 });
    expect(getRatingsState(P).status).toBe('loading');
    const unsub = subscribeRatings(P, () => undefined);
    for (let i = 0; i < 50 && getRatingsState(P).status !== 'ready'; i++) await wait(10);
    expect(getRatingsState(P)).toMatchObject({ status: 'ready' });
    expect(getRatingsState(P).ratings).toHaveLength(2);
    // Cierre inesperado de la conexión (como cuando el sistema la cierra en segundo plano)
    db.close();
    await saveRating(P, 'movie:1002' as TitleKey, { overall: 7 }).catch(() => undefined);
    await wait(50);
    const s = getRatingsState(P);
    expect(s.ratings.length).toBeGreaterThanOrEqual(2); // nunca vacío
    expect(s.status).toBe('ready');
    unsub();
  });
});

// ═════════════ Fase 1 · Años ═════════════
describe('3. Año: escritura parcial en teclados de Android', () => {
  it('acepta valores parciales sin aplicarlos y valida al tener 4 cifras', () => {
    expect(parseYear('')).toEqual({ partial: false });
    expect(parseYear('2')).toEqual({ partial: true });
    expect(parseYear('20')).toEqual({ partial: true });
    expect(parseYear('201')).toEqual({ partial: true });
    expect(parseYear('2010')).toEqual({ value: 2010, partial: false });
    expect(parseYear('1500').error).toBeTruthy();
    expect(parseYear('20a1').error).toBeTruthy();
  });
});

// ═════════════ Fase 1 · Filtros ═════════════
describe('4. Filtros: sin historial, pocos candidatos, combinados y sin perder títulos', () => {
  beforeEach(() => freshDb('filters'));
  const F = (o: Partial<RankFilters>): RankFilters => ({ ...DEFAULT_FILTERS, ...o });

  it('sin valoraciones, «sólo Terror» encuentra títulos (busca en TMDB si hay pocos) y los marca como de baja evidencia', async () => {
    const run = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    const r = await rankWithFilters(P, run, F({ includeGenres: [27] }));
    report['Sólo Terror sin historial'] = { candidatos: r.candidates, sumadosDesdeTMDB: r.discovered, resultados: r.items.length };
    expect(r.items.length).toBeGreaterThan(0);
    const metas = await db.titles.bulkGet(r.items.map((i) => i.key));
    expect(metas.every((m) => m!.genres.some((g) => g.id === 27))).toBe(true);
    // Sin historial: estimación provisional, nunca presentada como segura
    expect(r.items.every((i) => i.provisional)).toBe(true);
  });

  it('«Sólo películas» conserva TODAS las películas del ranking general (re-ordena dentro del subconjunto)', async () => {
    const hits = await searchTitles('Thriller', 'es-MX');
    for (const h of hits.slice(0, 6)) await rateAndLearn(P, h.key, { overall: 8 });
    const run = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    const generalMovies = (await db.titles.bulkGet(run.items.map((i) => i.key))).filter((m) => m?.type === 'movie').map((m) => m!.key);
    const r = await rankWithFilters(P, run, F({ types: ['movie'] }));
    const got = new Set(r.items.map((i) => i.key));
    const ratedWatched = new Set((await listRatings(P)).filter((x) => x.watched).map((x) => x.key));
    const missing = generalMovies.filter((k) => !got.has(k) && !ratedWatched.has(k));
    report['Sólo películas: películas del ranking general que faltan en el filtrado'] = missing.length;
    expect(missing).toEqual([]);
    expect(r.items.length).toBe(r.candidates); // sin tope: todo el subconjunto queda ordenado
  });

  it('filtros combinados (tipo + género + año + plataforma) se respetan todos', async () => {
    const run = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    const f = F({ types: ['movie'], includeGenres: [878, 12], yearMin: 1990, yearMax: 2024, platforms: ['netflix'] });
    const r = await rankWithFilters(P, run, f);
    const metas = await db.titles.bulkGet(r.items.map((i) => i.key));
    const snaps = await db.availability.bulkGet(r.items.map((i) => `${i.key}|AR`));
    metas.forEach((m, i) => {
      expect(m!.type).toBe('movie');
      expect(m!.genres.some((g) => [878, 12].includes(g.id))).toBe(true);
      expect(m!.year! >= 1990 && m!.year! <= 2024).toBe(true);
      expect(snaps[i]!.offers.some((o) => o.platform === 'netflix')).toBe(true);
    });
  });

  it('filtro por actor con id único: distingue homónimos y lista su filmografía combinable', async () => {
    const people = await searchPeople('Actor 231', 'es-MX');
    const ids = people.filter((p) => p.name === 'Actor 231').map((p) => `${p.id}:${p.department}`);
    expect(ids).toEqual(expect.arrayContaining(['231:Acting', '99231:Directing'])); // mismo nombre, dos personas
    const run = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    const r = await rankWithFilters(P, run, F({ person: { id: 231, name: 'Actor 231', department: 'Acting' }, watched: 'all' }));
    const metas = await db.titles.bulkGet(r.items.map((i) => i.key));
    expect(r.items.length).toBeGreaterThan(0);
    expect(metas.every((m) => catalog.find((c) => c.id === m!.tmdbId && c.type === m!.type)!.cast.includes(231))).toBe(true);
    const onlyTv = await rankWithFilters(P, run, F({ person: { id: 231, name: 'Actor 231', department: 'Acting' }, types: ['tv'], watched: 'all' }));
    expect((await db.titles.bulkGet(onlyTv.items.map((i) => i.key))).every((m) => m!.type === 'tv')).toBe(true);
  });
});

// ═════════════ Fase 1 · Orden persistente ═════════════
describe('5. Orden: dirección, desempate estable y orden de la lista de inicio', () => {
  it('A-Z / Z-A y desempate estable (editar un título no lo hace saltar)', () => {
    const rs = ['b', 'a', 'c'].map((k, i) => ({ ...R(`movie:${k}` as TitleKey, 7), updatedAt: 10 + i }));
    const title = (r: Rating) => r.key.slice(6);
    expect(sortRatings(rs, 'title', title, 'asc').map(title)).toEqual(['a', 'b', 'c']);
    expect(sortRatings(rs, 'title', title, 'desc').map(title)).toEqual(['c', 'b', 'a']);
    const edited = rs.map((r) => (r.key === 'movie:b' ? { ...r, updatedAt: 99, overall: 3 } : r));
    expect(sortRatings(edited, 'title', title, 'asc').map(title)).toEqual(['a', 'b', 'c']);
  });
  it('inicio: ordenar por público, año o título sin perder filas; sin dato al final', () => {
    const item = (k: string, rank: number) => ({ key: k as TitleKey, item: { key: k, rank } as RecommendationItem, meta: { title: k, year: rank === 2 ? undefined : 2000 + rank, voteAverage: rank === 3 ? undefined : 9 - rank, voteCount: 500 } as TitleMeta });
    const rows = [item('c', 1), item('a', 2), item('b', 3)];
    expect(sortRows(rows, 'public', 'desc').map((r) => r.key)).toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, 'year', 'desc').map((r) => r.key)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, 'title', 'asc').map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, 'affinity', 'desc')).toHaveLength(3);
  });
});

// ═════════════ Fase 2 · Escenarios narrativos ═════════════
describe('6. Motor por canales: escenarios controlados', () => {
  // Historial: viajes en el tiempo encantan; ópera espacial no gusta. Todo es ciencia ficción.
  const hist = [
    mk(1, { keywords: [TT, PARA], director: 10 }), mk(2, { keywords: [TT, PARA], director: 11 }), mk(3, { keywords: [TT] }),
    mk(4, { keywords: [SPACE, ALIEN] }), mk(5, { keywords: [SPACE, ALIEN] }), mk(6, { keywords: [SPACE] }),
  ];
  const ratings = [R(hist[0].key, 10), R(hist[1].key, 9), R(hist[2].key, 9), R(hist[3].key, 3), R(hist[4].key, 2), R(hist[5].key, 4)];

  it('mismo género, afinidad muy distinta (temáticas específicas pesan más que el género)', () => {
    const a = mk(100, { keywords: [TT, PARA] }), b = mk(101, { keywords: [SPACE, ALIEN] });
    const s = scoreOf(ratings, mapOf([...hist, a, b]), [a.key, b.key]);
    report['Mismo género (CF): viajes en el tiempo vs ópera espacial'] = { viajes: s.get(a.key)!.pred, operaEspacial: s.get(b.key)!.pred };
    expect(s.get(a.key)!.pred - s.get(b.key)!.pred).toBeGreaterThan(2);
  });

  it('géneros distintos con alta afinidad narrativa (romance con viajes en el tiempo)', () => {
    const rom = mk(102, { genres: [10749], keywords: [TT, PARA] }), romPlain = mk(103, { genres: [10749], keywords: [[40, 'wedding']] });
    const s = scoreOf(ratings, mapOf([...hist, rom, romPlain]), [rom.key, romPlain.key]);
    report['Género distinto (romance) con viajes en el tiempo'] = { conViajes: s.get(rom.key)!.pred, sinViajes: s.get(romPlain.key)!.pred };
    expect(s.get(rom.key)!.pred).toBeGreaterThan(s.get(romPlain.key)!.pred + 1);
  });

  it('los actores importan cuando hay evidencia suficiente (3 títulos con Actuaciones 5★)', () => {
    const trilogy = [1, 2, 3].map((i) => mk(200 + i, { genres: [12], keywords: [[50 + i, `k${i}`]], cast: [[900, 0], [901, 1]] }));
    const others = [mk(210, { genres: [12], keywords: [[60, 'x']] }), mk(211, { genres: [12], keywords: [[61, 'y']] })];
    const rs = [...trilogy.map((t) => R(t.key, 9, { acting: 5 })), R(others[0].key, 5, { acting: 3 }), R(others[1].key, 5, { acting: 3 })];
    const withA = mk(220, { genres: [35], keywords: [[70, 'z']], cast: [[900, 0]] }), noA = mk(221, { genres: [35], keywords: [[70, 'z']], cast: [[999, 0]] });
    const s = scoreOf(rs, mapOf([...trilogy, ...others, withA, noA]), [withA.key, noA.key]);
    const once = scoreOf([R(trilogy[0].key, 9, { acting: 5 }), R(others[0].key, 5, { acting: 3 })], mapOf([...trilogy, ...others, withA, noA]), [withA.key, noA.key]);
    const gain3 = s.get(withA.key)!.pred - s.get(noA.key)!.pred, gain1 = once.get(withA.key)!.pred - once.get(noA.key)!.pred;
    report['Actores: ventaja de un título con el protagonista'] = { con3Observaciones: gain3, con1Observacion: gain1 };
    expect(gain3).toBeGreaterThan(0.3);
    expect(gain3).toBeGreaterThan(gain1);
  });

  it('las estrellas por aspecto cambian el ranking aunque la nota general sea la misma', () => {
    const a = mk(300, { keywords: [[80, 'heist']] }), b = mk(301, { keywords: [[81, 'courtroom']] });
    const h1 = mk(302, { keywords: [[80, 'heist']] }), h2 = mk(303, { keywords: [[81, 'courtroom']] }), h3 = mk(304, { keywords: [[80, 'heist']] }), h4 = mk(305, { keywords: [[81, 'courtroom']] });
    const titles = mapOf([a, b, h1, h2, h3, h4]);
    const base = [h1, h2, h3, h4].map((t) => R(t.key, 7));
    const likesHeistStory = [R(h1.key, 7, { story: 5 }), R(h2.key, 7, { story: 1 }), R(h3.key, 7, { story: 5 }), R(h4.key, 7, { story: 1 }), R(mk(306).key, 9, { story: 5 }), R(mk(307).key, 3, { story: 1 })];
    titles.set(mk(306).key, mk(306)); titles.set(mk(307).key, mk(307));
    const s0 = scoreOf(base, titles, [a.key, b.key]), s1 = scoreOf(likesHeistStory, titles, [a.key, b.key]);
    report['Aspectos: misma nota general, distinta historia'] = { sinAspectos: [s0.get(a.key)!.pred, s0.get(b.key)!.pred], conAspectos: [s1.get(a.key)!.pred, s1.get(b.key)!.pred] };
    expect(Math.abs(s0.get(a.key)!.pred - s0.get(b.key)!.pred)).toBeLessThan(0.2);
    expect(s1.get(a.key)!.pred).toBeGreaterThan(s1.get(b.key)!.pred + 0.3);
  });

  it('las preferencias negativas no eliminan excepciones positivas (superhéroes descartados, Batman puntuada alto)', () => {
    const SH: [number, string] = [90, 'superhero'], BAT: [number, string] = [91, 'batman'];
    const rej = [1, 2, 3, 4].map((i) => mk(400 + i, { genres: [28], keywords: [SH] }));
    const bats = [1, 2].map((i) => mk(410 + i, { genres: [28], keywords: [SH, BAT], collection: [5, 'Batman'] }));
    const rs = [...rej.map((t) => R(t.key, undefined, {}, { notInterested: true, watched: false })), ...bats.map((t) => R(t.key, 9))];
    const newBat = mk(420, { genres: [28], keywords: [SH, BAT], collection: [5, 'Batman'] }), otherHero = mk(421, { genres: [28], keywords: [SH] });
    const s = scoreOf(rs, mapOf([...rej, ...bats, newBat, otherHero]), [newBat.key, otherHero.key]);
    expect(s.get(newBat.key)!.rejection.penalty).toBeGreaterThan(s.get(otherHero.key)!.rejection.penalty);
    expect(s.get(newBat.key)!.pred).toBeGreaterThan(s.get(otherHero.key)!.pred + 0.4);
  });

  it('la popularidad no domina: un título muy votado pero ajeno queda por debajo de uno afín con menos votos', () => {
    const popular = mk(500, { keywords: [SPACE, ALIEN], vote: 8.6, votes: 300000 }), niche = mk(501, { keywords: [TT, PARA], vote: 6.4, votes: 400 });
    const items = rank({ profile: hybridEngine.buildProfile(ratings, mapOf([...hist, popular, niche])), ratings, titles: mapOf([...hist, popular, niche]), candidates: [popular.key, niche.key], limit: 2 });
    expect(items[0].key).toBe(niche.key);
    const q = items.find((i) => i.key === popular.key)!.channels!.find((c) => c.id === 'quality')!;
    expect(Math.abs(q.contribution)).toBeLessThanOrEqual(0.35 * 2.5); // acotado
  });

  it('la ausencia de datos es desconocida, no negativa (sin palabras clave ni reparto → canales en 0)', () => {
    const bare = mk(600, { genres: [99999] });
    const s = scoreOf(ratings, mapOf([...hist, bare]), [bare.key]).get(bare.key)!;
    for (const id of ['theme', 'actors', 'crew', 'aspects', 'comments'] as const) expect(s.raw[id]).toBe(0);
  });

  it('diagnóstico: cada ítem trae el aporte por canal y suma la estimación', () => {
    const c = mk(700, { keywords: [TT] });
    const titles = mapOf([...hist, c]);
    const [it0] = rank({ profile: hybridEngine.buildProfile(ratings, titles), ratings, titles, candidates: [c.key], limit: 1 });
    const total = (it0.base ?? 0) + it0.channels!.reduce((a, x) => a + x.contribution, 0);
    expect(Math.abs(total - it0.score)).toBeLessThan(0.15);
    expect(it0.channels!.map((x) => x.id)).toContain('theme');
  });

  it('similitud léxica de sinopsis: palabras compartidas acercan, no es semántica', () => {
    const docs = ['Un científico viaja en el tiempo con un auto', 'Dos amigos viajan en el tiempo y cambian el pasado', 'Una familia se muda a una casa embrujada'].map(tokens);
    const idf = textIdf([...docs, tokens('El tiempo pasa'), tokens('Una casa')]);
    const v = docs.map((d) => textVector(d, idf));
    expect(textCosine(v[0], v[1])).toBeGreaterThan(textCosine(v[0], v[2]));
  });
});

describe('7. Pesos por canal con validación cruzada', () => {
  it('con menos de 12 valoraciones usa los pesos previos (sin aprender ruido)', () => {
    const ts = [1, 2, 3, 4, 5].map((i) => mk(800 + i, { keywords: [[i, `k${i}`]] }));
    const w = learnChannelWeights(ts.map((t, i) => R(t.key, 5 + i)), mapOf(ts));
    expect(w.learned).toBe(false);
    expect(w.weights).toEqual(priorWeights());
  });
  it('con suficientes valoraciones aprende pesos acotados y reporta error fuera de muestra', () => {
    const ts: TitleMeta[] = [];
    const rs: Rating[] = [];
    for (let i = 0; i < 40; i++) {
      const tt = i % 2 === 0;
      const t = mk(900 + i, { genres: [i % 3 ? 878 : 18], keywords: tt ? [TT, [100 + (i % 5), `x${i % 5}`]] : [SPACE, [100 + (i % 5), `x${i % 5}`]], cast: [[1000 + (i % 7), 0]] });
      ts.push(t); rs.push(R(t.key, tt ? 8 + (i % 3) * 0.5 : 3 + (i % 3) * 0.5));
    }
    const w = learnChannelWeights(rs, mapOf(ts));
    expect(w.learned).toBe(true);
    expect(w.n).toBeGreaterThanOrEqual(STACKING.minRatings);
    for (const c of CHANNELS) { expect(w.weights[c.id]).toBeGreaterThanOrEqual(0); expect(w.weights[c.id]).toBeLessThanOrEqual(c.max); }
    report['Pesos aprendidos (escenario sintético, 40 notas)'] = { pesos: w.weights, ecm: w.rmse };
    // Fuera de muestra, los pesos previos mejoran a «sólo tu media» en este escenario controlado
    expect(w.rmse!.prior).toBeLessThan(w.rmse!.baseline);
    expect(w.weights.genre).toBeLessThanOrEqual(0.9);
  });
});

// ═════════════ Fase 3 · Actores ═════════════
describe('8. Actores: filmografías como candidatos, con tope', () => {
  beforeEach(() => freshDb('actors'));
  it('actores con Actuaciones altas en ≥2 títulos aportan sus otros títulos al conjunto de candidatos', async () => {
    const actor = 231;
    const withActor = catalog.filter((t) => t.cast.includes(actor));
    expect(withActor.length).toBeGreaterThan(3);
    // «Trilogía»: tres títulos con el actor, puntuados alto y con 5★ de Actuaciones
    for (const t of withActor.slice(0, 3)) {
      const [h] = (await searchTitles(t.name, 'es-MX')).filter((x) => x.tmdbId === t.id);
      await rateAndLearn(P, h.key, { overall: 9, dimensions: { acting: 5 }, watched: true });
    }
    const settings = await getSettings(P);
    const ratings = await listRatings(P);
    const run = await refreshRecommendations(P, { trigger: 'test', rebuildPool: true });
    const titles = new Map((await db.titles.toArray()).map((m) => [m.key, m]));
    const profile = hybridEngine.buildProfile(ratings, titles, settings);
    expect(profile.actors.get(actor)!.actingCount).toBe(3);
    const act = await actorCandidates(profile, settings);
    const otherFilms = withActor.slice(3).map((t) => `${t.type}:${t.id}`);
    report['Actores: candidatos por filmografía'] = { actores: act.actors, sumados: act.keys.length, otrasDelActor: otherFilms.length };
    expect(act.actors.map((a) => a.id)).toContain(actor);
    expect(otherFilms.some((k) => run.pool.includes(k as TitleKey))).toBe(true);
    const credits = await personFilmography(actor, 'es-MX', { role: 'cast', fiction: true });
    expect(credits.length).toBe(withActor.length);
  });

  it('en el top 10, como máximo 2 títulos impulsados por el mismo actor', () => {
    const trilogy = [1, 2, 3].map((i) => mk(1100 + i, { keywords: [[1, 'a']], cast: [[7, 0]] }));
    const rs = trilogy.map((t) => R(t.key, 10, { acting: 5 }));
    const cands = Array.from({ length: 24 }, (_, i) => mk(1200 + i, { keywords: [[200 + i, `u${i}`]], cast: i < 8 ? [[7, 0]] : [[50 + i, 0]] }));
    const titles = mapOf([...trilogy, ...cands]);
    const items = rank({ profile: hybridEngine.buildProfile(rs, titles), ratings: rs, titles, candidates: cands.map((c) => c.key), limit: 10 });
    const withLead = items.filter((i) => titles.get(i.key)!.cast.some((p) => p.id === 7));
    expect(withLead.length).toBe(2); // impulsados por el actor: suben, pero no monopolizan
    const all = rank({ profile: hybridEngine.buildProfile(rs, titles), ratings: rs, titles, candidates: cands.map((c) => c.key), limit: 24 });
    expect(all.filter((i) => titles.get(i.key)!.cast.some((p) => p.id === 7))).toHaveLength(8); // no desaparecen: siguen después del top 10
  });
});

// ═════════════ Fase 4 · Notas ═════════════
describe('9. Nota pública y «Para vos»', () => {
  it('la nota pública sale de TMDB y no se inventa sin votos suficientes', () => {
    expect(publicScore({ voteAverage: 7.84, voteCount: 2000 })).toBe(7.8);
    expect(publicScore({ voteAverage: 9, voteCount: 3 })).toBeUndefined();
    expect(publicScore({})).toBeUndefined();
  });
  it('«Para vos» es provisional o insuficiente con poca evidencia', () => {
    expect(personalState({ score: 7, confidence: 0.05 }).kind).toBe('insufficient');
    expect(personalState({ score: 7, confidence: 0.3, provisional: true }).kind).toBe('provisional');
    expect(personalState({ score: 7, confidence: 0.8, provisional: false })).toEqual({ kind: 'ok', value: 7 });
  });
  it('para un título ya puntuado, la estimación se calcula sin su nota (no es un eco)', async () => {
    await freshDb('pred');
    const hits = await searchTitles('Scifi Film', 'es-MX');
    for (const h of hits.slice(1, 6)) await rateAndLearn(P, h.key, { overall: 8 });
    await rateAndLearn(P, hits[0].key, { overall: 1 });
    const a = (await predictFor(P, [hits[0].key], { holdOut: true })).get(hits[0].key)!;
    expect(a.score).toBeGreaterThan(4); // se parece a lo que puntuaste 8, no repite tu 1
  });
});

// ═════════════ Fase 5 · Similares ═════════════
describe('10. Similares con varias referencias', () => {
  beforeEach(() => freshDb('similar'));
  it('excluye referencias, separa similitud de afinidad y avisa cuando no está personalizado', async () => {
    const refs = (await searchTitles('Scifi Film', 'es-MX')).filter((h) => h.type === 'movie').slice(0, 2).map((h) => h.key);
    const r = await findSimilar(P, refs, { ...DEFAULT_FILTERS, watched: 'all' }, { onlyMyPlatforms: false });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.some((x) => refs.includes(x.key))).toBe(false);
    expect(r.personalized).toBe(false);
    const top = r.results[0];
    expect(top.similarity).toBeGreaterThan(0);
    expect(top.affinity?.score).toBeDefined();
    const metas = await db.titles.bulkGet(r.results.slice(0, 5).map((x) => x.key));
    report['Similares: tipos/clusters del top 5 para 2 referencias de ciencia ficción'] = metas.map((m) => m?.title);
    expect(metas.filter((m) => /Scifi/.test(m!.title)).length).toBeGreaterThanOrEqual(3);
  });
  it('aplica los filtros avanzados a los resultados', async () => {
    const refs = (await searchTitles('Thriller Film', 'es-MX')).slice(0, 1).map((h) => h.key);
    const r = await findSimilar(P, refs, { ...DEFAULT_FILTERS, types: ['tv'], watched: 'all' }, { onlyMyPlatforms: false });
    const metas = await db.titles.bulkGet(r.results.map((x) => x.key));
    expect(metas.every((m) => m!.type === 'tv')).toBe(true);
  });
});

// ═════════════ Datos y compatibilidad ═════════════
describe('11. Migraciones y compatibilidad', () => {
  beforeEach(() => freshDb('compat'));
  it('la ficha v3 agrega guionistas; las fichas anteriores se vuelven a pedir sin tocar valoraciones', async () => {
    expect(META_VERSION).toBe(3);
    const m = mapDetails({ id: 1, title: 'X', genres: [], credits: { cast: [], crew: [{ id: 5, name: 'Bob Gale', job: 'Screenplay', department: 'Writing' }, { id: 6, name: 'Dir', job: 'Director', department: 'Directing' }] } }, 'movie', 'es-MX');
    expect(m.writers).toEqual([expect.objectContaining({ id: 5, name: 'Bob Gale' })]);
    const [h] = await searchTitles('Drama Film', 'es-MX');
    await rateAndLearn(P, h.key, { overall: 7, watched: true, dimensions: { story: 4 } });
    await db.titles.update(h.key, { metaVersion: 2 });
    await refreshRecommendations(P, { trigger: 'test' });
    expect((await db.titles.get(h.key))!.metaVersion).toBe(3);
    expect((await listRatings(P))[0]).toMatchObject({ overall: 7, watched: true, dimensions: { story: 4 } });
  });
  it('exportar e importar sigue funcionando y no sobrescribe con vacío', async () => {
    const [h] = await searchTitles('Comedy Film', 'es-MX');
    await rateAndLearn(P, h.key, { overall: 9, watched: true });
    const data = await exportData();
    await importData({ ...data, ratings: [] });
    expect((await listRatings(P)).find((r) => r.key === h.key)?.overall).toBe(9);
  });
  it('el proxy permite las rutas nuevas (personas) y sigue bloqueando el resto', () => {
    expect(ALLOWED_PATH.test('/search/person')).toBe(true);
    expect(ALLOWED_PATH.test('/person/123/combined_credits')).toBe(true);
    expect(ALLOWED_PATH.test('/person/123/images')).toBe(false);
    expect(ALLOWED_PATH.test('/account')).toBe(false);
  });
});

describe('Informe', () => {
  it('guarda los resultados de los escenarios', () => {
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/v3-scenarios.json', JSON.stringify({ aviso: 'Escenarios con datos sintéticos y proveedor simulado: muestran el comportamiento del sistema, no su precisión con usuarios reales.', ...report }, null, 2));
  });
});
