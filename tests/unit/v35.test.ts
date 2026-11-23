/**
 * Pruebas de Cine Match v3.5: motor personal (hybrid-personal-3.5.0) y comparación a ciegas.
 *
 * Son pruebas FUNCIONALES con fichas sintéticas y proveedor SIMULADO: comprueban que el código hace lo que dice
 * (umbrales, separación de señales, intercalado sin repetidos, que nada toque tus valoraciones). NO miden calidad de
 * recomendación: eso se mide con la evaluación editorial (docs/eval-v3.5.md) y con la comparación a ciegas real.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db, useTestDb } from '../../src/db/db';
import { createProfile, ensureBootstrap, getSettings, listRatings, updateConfig, updateSettings } from '../../src/db/repo';
import { buildProfile } from '../../src/engine/profile';
import { ALGORITHM_VERSION, rank, scoreCandidates } from '../../src/engine/recommender';
import { PERSONAL_ENGINE_VERSION, PERSONAL_PARAMS, personalEngine, personalScores } from '../../src/engine/personalEngine';
import { answerItem, exportSessions, loadSessions, newSession, rng, summarize, teamDraft, type AbSession } from '../../src/services/abtest';
import { setFetch } from '../../src/services/catalog';
import { rateAndLearn } from '../../src/services/ratings';
import { resetRatingsStore } from '../../src/services/ratingsStore';
import { resetRecompute } from '../../src/services/recompute';
import { currentRun, engineFor, rankWithFilters, refreshRecommendations } from '../../src/services/recommendations';
import { DEFAULT_FILTERS } from '../../src/services/filters';
import type { Rating, TitleKey } from '../../src/types';
import { buildCatalog, fakeFetch, type FakeTitle } from '../fixtures/fakeTmdb';
import { simulateHistory, syntheticMetas, USERS } from '../fixtures/synthetic';

const P = 'p-principal';

describe('v3.5 · motor personal: umbrales y señales separadas', async () => {
  const { catalog, metas } = await syntheticMetas(20, 7);
  const { ratings } = simulateHistory(USERS[0], catalog, 30, 3);
  const rated = ratings.filter((r) => r.overall !== undefined);
  const histKeys = new Set(ratings.map((r) => r.key));
  const candidates = [...metas.keys()].filter((k) => !histKeys.has(k)).slice(0, 60);
  const input = (rs: Rating[]) => ({ profile: buildProfile(rs, metas), ratings: rs, titles: metas, candidates, narrative: null });
  const discard = (k: TitleKey): Rating => ({ id: `u|${k}`, profileId: 'u', key: k, watched: false, notInterested: true, dimensions: {}, createdAt: 0, updatedAt: 0, schema: 3 } as Rating);

  it(`con menos de ${PERSONAL_PARAMS.minRatings} notas usa sólo el orden de v3.4`, () => {
    const few = rated.slice(0, PERSONAL_PARAMS.minRatings - 1);
    const ps = personalScores(input(few), candidates);
    const v34 = new Map(scoreCandidates({ ...input(few) }).map((s) => [s.key, s.predRaw]));
    expect(ps.size).toBeGreaterThan(0);
    for (const [k, s] of ps) { expect(s.order).toBeCloseTo(v34.get(k)!, 9); expect(s.lin).toBeUndefined(); expect(s.interest).toBeUndefined(); }
  });
  it(`el modelo de interés sólo se activa con ≥ ${PERSONAL_PARAMS.minDiscards} descartes; «visto sin nota» no es negativo`, () => {
    const base = rated.slice(0, 20);
    const two = [...base, ...candidates.slice(-2).map(discard)];
    expect([...personalScores(input(two), candidates.slice(0, 40)).values()].every((s) => s.interest === undefined && s.lin !== undefined)).toBe(true);
    const three = [...base, ...candidates.slice(-3).map(discard)];
    expect([...personalScores(input(three), candidates.slice(0, 40)).values()].every((s) => s.interest !== undefined)).toBe(true);
  });
  it('los descartes no entrenan el modelo de nota (no son valoraciones negativas)', () => {
    const base = rated.slice(0, 20);
    const a = personalScores(input(base), candidates.slice(0, 40));
    const b = personalScores(input([...base, ...candidates.slice(-4).map(discard)]), candidates.slice(0, 40));
    for (const [k, s] of a) expect(b.get(k)!.linRating).toBeCloseTo(s.linRating!, 9);
  });
  it('el orden usa orderScore cuando se lo da; la nota mostrada sigue siendo la de v3.4', () => {
    const inp = input(rated);
    const plain = rank({ ...inp, limit: 20 });
    const last = candidates.find((k) => !plain.some((i) => i.key === k))!;
    const boosted = rank({ ...inp, limit: 20, orderScore: new Map(candidates.map((k) => [k, k === last ? 100 : 5])) });
    expect(boosted[0].key).toBe(last);
    const p35 = personalEngine.rank({ ...inp, limit: 20 });
    const all34 = new Map(rank({ ...inp, limit: 200 }).map((i) => [i.key, i.score]));
    for (const it of p35) expect(it.score).toBe(all34.get(it.key));
    expect(new Set(p35.map((i) => i.key)).size).toBe(p35.length);
  });
});

describe('v3.5 · intercalado a ciegas (team draft) y resumen', () => {
  const keys = (p: string, n: number) => Array.from({ length: n }, (_, i) => `movie:${p}${i}` as unknown as TitleKey);
  it('sin repetidos, equilibrado y respetando el orden de cada motor', () => {
    for (let seed = 1; seed < 30; seed++) {
      const a = keys('1', 20), b = [...keys('1', 6).reverse(), ...keys('2', 20)];
      const m = teamDraft(a, b, 12, rng(seed));
      expect(m).toHaveLength(12);
      expect(new Set(m.map((x) => x.key)).size).toBe(12);
      const na = m.filter((x) => x.team === 'A').length;
      expect(Math.abs(na - (12 - na))).toBeLessThanOrEqual(1);
      const pos = (list: TitleKey[], t: 'A' | 'B') => m.filter((x) => x.team === t).map((x) => list.indexOf(x.key));
      for (const [l, t] of [[a, 'A'], [b, 'B']] as const) { const p = pos(l, t); expect([...p].sort((x, y) => x - y)).toEqual(p); }
    }
  });
  it('listas idénticas no repiten títulos; listas cortas se agotan sin error', () => {
    const a = keys('3', 10);
    expect(new Set(teamDraft(a, [...a], 12, rng(2)).map((x) => x.key)).size).toBe(10);
    expect(teamDraft(keys('4', 2), [], 12, rng(2))).toHaveLength(2);
  });
  it('«Ya la vi» y «No puedo evaluarla» no cuentan como rechazo', () => {
    const s: AbSession = { id: 's', createdAt: 0, engines: { A: 'x', B: 'y' }, items: [
      { key: 'movie:1', title: '1', team: 'A', answer: 'vista' }, { key: 'movie:2', title: '2', team: 'A', answer: 'nose' },
      { key: 'movie:3', title: '3', team: 'A', answer: 'algo' }, { key: 'movie:4', title: '4', team: 'B', answer: 'no' },
      { key: 'movie:5', title: '5', team: 'B', answer: 'vista' }, { key: 'movie:6', title: '6', team: 'B' }] };
    const r = summarize([s]);
    const x = r.perEngine.find((e) => e.engine === 'x')!, y = r.perEngine.find((e) => e.engine === 'y')!;
    expect(x.scored).toBe(1); expect(x.mean).toBe(1); expect(x.vista).toBe(1); expect(x.no).toBe(0);
    expect(y.scored).toBe(1); expect(y.mean).toBe(0); expect(y.no).toBe(1);
    expect(r.wins).toEqual({ x: 1 }); expect(r.answered).toBe(5);
  });
});

describe('v3.5 · comparación a ciegas en la app (proveedor simulado)', () => {
  const catalog = buildCatalog(12);
  const keyOf = (t: FakeTitle) => `${t.type}:${t.id}` as TitleKey;
  beforeEach(async () => {
    localStorage.clear(); resetRecompute(); resetRatingsStore();
    useTestDb(`v35-${Math.random().toString(36).slice(2)}`);
    setFetch(fakeFetch(catalog));
    await ensureBootstrap();
    await updateConfig({ tmdbToken: 'eyJtest' });
    await updateSettings(P, { platforms: ['netflix', 'prime', 'disney', 'max'], country: 'AR' });
  });
  it('arma 12 títulos nuevos sin repetir, a ciegas, sin tocar valoraciones, y exporta sin credenciales', async () => {
    expect(await newSession(P)).toHaveProperty('error'); // sin cálculo previo
    for (const [i, t] of catalog.filter((x) => x.cluster === 'thriller').slice(0, 9).entries()) await rateAndLearn(P, keyOf(t), { watched: true, overall: 9 - (i % 4), dimensions: {} });
    await rateAndLearn(P, keyOf(catalog.find((x) => x.cluster === 'animation')!), { notInterested: true, dimensions: {} });
    await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    const before = JSON.stringify((await listRatings(P)).map((r) => [r.key, r.overall, r.watched, r.notInterested, r.updatedAt]));
    const s = await newSession(P, 12345) as AbSession;
    expect(s.items).toHaveLength(12);
    expect(new Set(s.items.map((i) => i.key)).size).toBe(12);
    expect(Object.values(s.engines).sort()).toEqual([ALGORITHM_VERSION, PERSONAL_ENGINE_VERSION].sort());
    const mine = new Set((await listRatings(P)).map((r) => r.key));
    expect(s.items.some((i) => mine.has(i.key))).toBe(false);
    answerItem(P, s.id, s.items[0].key, 'mucho');
    answerItem(P, s.id, s.items[1].key, 'vista');
    expect(loadSessions(P)[0].items[0].answer).toBe('mucho');
    // una comparación nueva no repite lo ya respondido
    const s2 = await newSession(P, 999) as AbSession;
    expect(s2.items.some((i) => i.key === s.items[0].key || i.key === s.items[1].key)).toBe(false);
    const ex = JSON.stringify(exportSessions(P));
    expect(ex).not.toContain('eyJtest');
    expect(ex).not.toContain('"overall"');
    expect(JSON.stringify((await listRatings(P)).map((r) => [r.key, r.overall, r.watched, r.notInterested, r.updatedAt]))).toBe(before);
    expect(await db.ratings.count()).toBe(10);
  });
});

describe('v3.5 · selector de motor en Ajustes (proveedor simulado)', () => {
  const catalog = buildCatalog(12);
  const keyOf = (t: FakeTitle) => `${t.type}:${t.id}` as TitleKey;
  const order = (r: { items: { key: TitleKey }[] }) => r.items.slice(0, 30).map((i) => i.key).join(',');
  const dump = async () => JSON.stringify((await db.ratings.toArray()).map((r) => [r.key, r.overall, r.watched, r.notInterested, r.list, r.dimensions, r.updatedAt]));
  beforeEach(async () => {
    localStorage.clear(); resetRecompute(); resetRatingsStore();
    useTestDb(`v35s-${Math.random().toString(36).slice(2)}`);
    setFetch(fakeFetch(catalog));
    await ensureBootstrap();
    await updateConfig({ tmdbToken: 'eyJtest' });
    await updateSettings(P, { platforms: ['netflix', 'prime', 'disney', 'max'], country: 'AR' });
    const th = catalog.filter((x) => x.cluster === 'thriller'), sf = catalog.filter((x) => x.cluster === 'scifi');
    for (const [i, t] of [...th.slice(0, 6), ...sf.slice(0, 4)].entries()) await rateAndLearn(P, keyOf(t), { watched: true, overall: [9, 8, 6, 9, 4, 7, 8, 5, 9, 3][i], dimensions: {} });
    for (const t of catalog.filter((x) => x.cluster === 'animation').slice(0, 3)) await rateAndLearn(P, keyOf(t), { notInterested: true, dimensions: {} });
  });
  const choose = (engine: 'v3.4' | 'v3.5') => updateSettings(P, { engine, engineChangedAt: Date.now() });

  it('instalación existente: sin elección usa v3.4; elegir v3.5 cambia el orden y volver a v3.4 lo restaura', async () => {
    expect((await getSettings(P)).engine).toBeUndefined();
    const r34 = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    expect(r34.algorithmVersion).toBe(ALGORITHM_VERSION);
    const before = await dump();
    await choose('v3.5');
    expect(await currentRun(P)).toBeUndefined(); // caché invalidada: el ranking de v3.4 no se muestra como de v3.5
    const r35 = await refreshRecommendations(P, { trigger: 'cambio de motor' });
    expect(r35.algorithmVersion).toBe(PERSONAL_ENGINE_VERSION);
    expect((await currentRun(P))?.id).toBe(r35.id);
    expect(order(r35)).not.toBe(order(r34)); // ejecuta otro algoritmo, no sólo otra etiqueta
    // misma nota mostrada: v3.5 sólo reordena
    const s34 = new Map(r34.items.map((i) => [i.key, i.score]));
    for (const it of r35.items) if (s34.has(it.key)) expect(it.score).toBe(s34.get(it.key));
    await new Promise((r) => setTimeout(r, 2));
    await choose('v3.4');
    expect(await currentRun(P)).toBeUndefined(); // el ranking viejo de v3.4 (anterior al cambio) tampoco
    const back = await refreshRecommendations(P, { trigger: 'cambio de motor' });
    expect(back.algorithmVersion).toBe(ALGORITHM_VERSION);
    expect(order(back)).toBe(order(r34));
    expect(await dump()).toBe(before);
  });
  it('la elección persiste al reabrir y es por perfil', async () => {
    await choose('v3.5');
    resetRecompute(); resetRatingsStore(); // como cerrar y abrir la app: se vuelve a leer de IndexedDB
    expect((await getSettings(P)).engine).toBe('v3.5');
    expect(engineFor(await getSettings(P)).version).toBe(PERSONAL_ENGINE_VERSION);
    const other = await createProfile('Otra persona');
    expect((await getSettings(other.id)).engine).toBeUndefined();
    expect(engineFor(await getSettings(other.id)).version).toBe(ALGORITHM_VERSION);
    expect((await getSettings(P)).engine).toBe('v3.5');
  });
  it('los filtros funcionan igual con ambos motores; el orden estricto por nota no cambia', async () => {
    const f = { ...DEFAULT_FILTERS, watched: 'all' as const, includeGenres: [53] };
    const res: Record<string, TitleKey[]> = {};
    for (const e of ['v3.4', 'v3.5'] as const) {
      await choose(e);
      const run = await refreshRecommendations(P, { trigger: 'cambio de motor', rebuildPool: true });
      const r = await rankWithFilters(P, run, f, { discover: false });
      expect(r.items.length).toBeGreaterThan(0);
      for (const it of r.items) expect(catalog.find((x) => keyOf(x) === it.key)!.genres).toContain(53);
      res[e] = r.items.map((i) => i.key);
      await new Promise((x) => setTimeout(x, 2));
    }
    expect([...res['v3.4']].sort()).toEqual([...res['v3.5']].sort()); // mismos títulos: el filtro no depende del motor
  });
  it('la comparación a ciegas sigue usando ambos motores con cualquier elección', async () => {
    await choose('v3.5');
    await refreshRecommendations(P, { trigger: 'cambio de motor', rebuildPool: true });
    const s = await newSession(P, 7) as AbSession;
    expect(Object.values(s.engines).sort()).toEqual([ALGORITHM_VERSION, PERSONAL_ENGINE_VERSION].sort());
    expect(new Set(s.items.map((i) => i.key)).size).toBe(s.items.length);
  });
});
