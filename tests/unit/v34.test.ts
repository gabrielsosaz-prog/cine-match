/**
 * Pruebas de Cine Match v3.4: preferencias flexibles del texto, modo diagnóstico, orden del motor y credenciales.
 *
 * Son pruebas FUNCIONALES (fichas armadas a mano y proveedor SIMULADO): comprueban que el código hace lo que dice.
 * NO miden calidad de recomendación. La calidad se mide aparte con datos reales del catálogo y una referencia
 * editorial independiente (npm run eval → docs/eval-v3.4.md, docs/audience-validation.md,
 * docs/preferences-validation.json).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, useTestDb } from '../../src/db/db';
import { ensureBootstrap, listRatings, updateConfig, updateSettings } from '../../src/db/repo';
import { buildProfile } from '../../src/engine/profile';
import { ALGORITHM_VERSION, rank } from '../../src/engine/recommender';
import { setFetch } from '../../src/services/catalog';
import { CHANNEL_BASIS, diagnose, diagnosticOn, exportDiagnostics, setDiagnostic } from '../../src/services/diagnostics';
import { activeFilters, DEFAULT_FILTERS, loadFilters, saveFilters, smartNeeds, type RankFilters } from '../../src/services/filters';
import { extractPrefs, PREF_MAX_SHIFT, PREF_SHIFT, PREFS, prefAdjust, reorderByPrefs } from '../../src/services/preferences';
import { rateAndLearn } from '../../src/services/ratings';
import { resetRatingsStore } from '../../src/services/ratingsStore';
import { resetRecompute } from '../../src/services/recompute';
import { rankWithFilters, refreshRecommendations } from '../../src/services/recommendations';
import { AUDIENCE_RULES } from '../../src/services/audience';
import { condLabel, parseText } from '../../src/services/textFilter';
import type { Rating, RecommendationItem, TitleKey, TitleMeta } from '../../src/types';
import { buildCatalog, fakeFetch, type FakeTitle } from '../fixtures/fakeTmdb';
import { syntheticMetas } from '../fixtures/synthetic';

const P = 'p-principal';
const F = (o: Partial<RankFilters>): RankFilters => ({ ...DEFAULT_FILTERS, watched: 'all', ...o });
let n = 0;
const meta = (o: Partial<TitleMeta>): TitleMeta => ({
  key: `movie:${++n}` as TitleKey, type: 'movie', tmdbId: n, title: `T${n}`, genres: [], keywords: [], cast: [], directors: [], writers: [],
  completeness: 'full', missing: [], source: 't', fetchedAt: 0, metaVersion: 3, ...o,
});
const kw = (...names: string[]) => names.map((name, i) => ({ id: 9000 + i, name }));
const T = (s: string) => parseText(s, 2026);

describe('v3.4 · texto libre: restricciones estrictas vs. preferencias flexibles', () => {
  it('separa una preferencia narrativa de las restricciones y la marca como no excluyente', () => {
    const p = T('Películas de ciencia ficción posteriores a 2010 con viajes en el tiempo importantes para la trama y poco romance');
    expect(p.include.map(condLabel)).toEqual(expect.arrayContaining(['Tipo: película', 'Género: Ciencia ficción', 'Año mínimo: 2011']));
    expect(p.exclude).toEqual([]); // «poco romance» NO se convierte en «excluir Romance»
    expect(p.prefs?.map((x) => [x.id, x.applied, x.polarity])).toEqual([['time-travel', true, 1], ['less-romance', true, -1]]);
    expect(p.unparsed).toEqual([]);
    expect(p.version).toMatch(/texto-1\.0 \+ preferencias-1\.0/);
  });
  it('sin frases de preferencia, el análisis es idéntico al de texto-1.0', () => {
    const p = T('Series coreanas de los 90 sin terror');
    expect(p.prefs ?? []).toEqual([]);
    expect(p.version).toBe('texto-1.0');
    expect(p.exclude.length).toBe(1);
  });
  it('«sin romance» sigue siendo una exclusión estricta; «poco romance» es sólo preferencia', () => {
    expect(T('sin romance').exclude.length).toBe(1);
    expect(T('sin romance').prefs ?? []).toEqual([]);
    expect(T('con poco romance').exclude).toEqual([]);
  });
  it('preferencias no validadas se informan como no aplicadas, con el motivo', () => {
    const { prefs } = extractPrefs('quiero giros argumentales inesperados y una historia compleja');
    expect(prefs.map((p) => p.id)).toEqual(['twists', 'complex']);
    expect(prefs.every((p) => !p.applied && /No aplicada/.test(p.note))).toBe(true);
  });
  it('verbos de relleno no quedan como «no interpretado»', () => {
    expect(T('No mostrar terror').unparsed).toEqual([]);
  });
  it('todas las definiciones aplicadas tienen evidencia explícita (palabras clave o género)', () => {
    for (const d of PREFS.filter((x) => x.applied)) expect(d.kw.length + (d.genres?.length ?? 0)).toBeGreaterThan(0);
  });
});

describe('v3.4 · ajuste por preferencias', () => {
  const tt = extractPrefs('viajes en el tiempo importantes para la trama').prefs;
  const lr = extractPrefs('poco romance').prefs;
  it('suma con evidencia explícita y explica cuál', () => {
    const a = prefAdjust(tt, meta({ keywords: kw('time travel', 'paradox') }), ['time travel', 'paradox']);
    expect(a.delta).toBe(PREF_SHIFT);
    expect(a.matches[0].evidence).toEqual(['«time travel»']);
  });
  it('sin palabras clave ni género relevante, no suma ni resta y lo informa como desconocido', () => {
    const a = prefAdjust(tt, meta({}), undefined);
    expect(a).toEqual({ delta: 0, matches: [], unknown: [tt[0].label] });
  });
  it('la preferencia negativa baja (no quita) títulos con género Romance', () => {
    const a = prefAdjust(lr, meta({ genres: [{ id: 10749, name: 'Romance' }] }), undefined);
    expect(a.delta).toBe(-PREF_SHIFT);
    expect(a.unknown).toEqual([]);
  });
  it('desplaza posiciones respecto del orden del motor, de forma estable', () => {
    const xs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(reorderByPrefs(xs, (x) => (x === 'a' ? -5 : 0))).toEqual(['b', 'c', 'd', 'e', 'f', 'a', 'g', 'h']);
    expect(reorderByPrefs(xs, (x) => (x === 'h' ? 5 : 0))).toEqual(['a', 'b', 'h', 'c', 'd', 'e', 'f', 'g']);
    expect(reorderByPrefs(xs, () => 0)).toEqual(xs);
  });
  it('el ajuste total está acotado', () => {
    const all = PREFS.filter((p) => p.applied).map((p) => ({ ...p }));
    const a = prefAdjust(all, meta({}), ['time travel', 'flashback', 'paranoia', 'detective']);
    expect(Math.abs(a.delta)).toBeLessThanOrEqual(PREF_MAX_SHIFT);
  });
  it('las preferencias aplicadas piden palabras clave (para completar datos antes de ordenar)', () => {
    expect(smartNeeds(F({ text: T('con poco romance') })).keywords).toBe(true);
    expect(activeFilters(F({ text: T('con poco romance') }))).toContain('text');
  });
});

describe('v3.4 · motor hybrid-narrative-3.4.0: sólo cambia el orden', () => {
  let metas: Map<TitleKey, TitleMeta>;
  beforeEach(async () => { ({ metas } = await syntheticMetas(12)); });
  const R = (key: TitleKey, overall: number): Rating => ({ id: `p|${key}`, profileId: 'p', key, watched: true, overall, dimensions: {}, createdAt: 0, updatedAt: 0, schema: 3 });
  it('predeterminado = orden sin recorte + 1 por saga; las notas mostradas y los títulos candidatos no cambian', () => {
    const keys = [...metas.keys()];
    const ratings = keys.slice(0, 8).map((k, i) => R(k, 3 + i));
    const profile = buildProfile(ratings, metas);
    const args = { profile, ratings, titles: metas, candidates: keys.slice(8), limit: 400, seed: 3 };
    const v34 = rank(args), explicit = rank({ ...args, rankBy: 'uncapped', collectionCap: true }), v31 = rank({ ...args, rankBy: 'capped', collectionCap: false });
    expect(v34.map((i) => i.key)).toEqual(explicit.map((i) => i.key));
    expect(ALGORITHM_VERSION).toBe('hybrid-narrative-3.4.0');
    // mismo conjunto y misma nota por título: sólo cambia la posición
    const score = (xs: RecommendationItem[]) => new Map(xs.map((i) => [i.key, i.score]));
    expect([...score(v34)].sort()).toEqual([...score(v31)].sort());
    for (const it of v34) expect(it.score).toBeGreaterThanOrEqual(1), expect(it.score).toBeLessThanOrEqual(10);
  });
  it('como máximo un título por saga en el top 10', () => {
    const keys = [...metas.keys()];
    const withSaga = new Map([...metas].map(([k, m], i) => [k, i >= 8 && i < 30 ? { ...m, collection: { id: 77, name: 'Saga' } } : m]));
    const ratings = keys.slice(0, 8).map((k) => R(k, 9));
    const profile = buildProfile(ratings, withSaga);
    const top = rank({ profile, ratings, titles: withSaga, candidates: keys.slice(8), limit: 10, seed: 3 });
    expect(top.filter((i) => withSaga.get(i.key)!.collection?.id === 77).length).toBeLessThanOrEqual(1);
    const old = rank({ profile, ratings, titles: withSaga, candidates: keys.slice(8), limit: 10, seed: 3, collectionCap: false });
    expect(old.filter((i) => withSaga.get(i.key)!.collection?.id === 77).length).toBeGreaterThan(1);
  });
});

describe('v3.4 · modo diagnóstico', () => {
  beforeEach(() => localStorage.clear());
  it('está apagado por defecto y se guarda en el dispositivo', () => {
    expect(diagnosticOn()).toBe(false);
    setDiagnostic(true); expect(diagnosticOn()).toBe(true);
    setDiagnostic(false); expect(diagnosticOn()).toBe(false);
  });
  it('reúne canales con su tipo de evidencia, faltantes, filtros y motivo, sin inventar', () => {
    const m = meta({ title: 'Sin datos', missing: ['reparto'] });
    const item: RecommendationItem = {
      key: m.key, rank: 2, score: 7.4, confidence: 0.5, exploration: false, explanation: ['Coincide con géneros que puntuaste alto.'],
      channels: [{ id: 'genre', label: 'Géneros', contribution: 0.6, weight: 1, value: 0.6, evidence: 3 }, { id: 'narrative', label: 'Narrativa', contribution: -0.3, weight: 1, value: -0.3, evidence: 1 }],
      prefs: { delta: -5, matches: [{ id: 'less-romance', label: 'poco protagonismo del romance', polarity: -1, evidence: ['género Romance'] }], unknown: [] }, engineRank: 1,
    } as RecommendationItem;
    const d = diagnose(item, m, F({ text: T('con poco romance') }), { genre: (g) => `G${g}`, platform: (() => '') as never });
    expect(d.channels.map((c) => [c.id, c.basis])).toEqual([['genre', 'datos'], ['narrative', 'aproximado']]);
    expect(d.missing).toEqual(expect.arrayContaining(['reparto', 'palabras clave', 'país', 'sinopsis']));
    expect(d.penalties.join(' ')).toMatch(/narrativo.*-0.3 puntos/);
    expect(d.penalties.join(' ')).toMatch(/poco protagonismo del romance/);
    expect(d.filters.length).toBe(1);
    expect(d.reason).toContain('Coincide con géneros que puntuaste alto.');
    expect([d.rank, d.engineRank]).toEqual([2, 1]);
    const ex = exportDiagnostics([d], F({}));
    expect(ex.engine).toBe(ALGORITHM_VERSION);
    expect(JSON.stringify(ex)).not.toMatch(/tmdbToken|eyJ/);
  });
  it('cada canal del motor tiene un tipo de evidencia declarado', () => {
    expect(Object.keys(CHANNEL_BASIS).sort()).toEqual(['actors', 'aspects', 'comments', 'crew', 'format', 'genre', 'narrative', 'quality', 'rejection', 'similar', 'theme']);
  });
});

// ═════════════ Integración con el proveedor simulado ═════════════
const catalog = buildCatalog(12);
const keyOf = (t: FakeTitle) => `${t.type}:${t.id}` as TitleKey;
async function freshDb() {
  resetRecompute(); resetRatingsStore();
  useTestDb(`v34-${Math.random().toString(36).slice(2)}`);
  setFetch(fakeFetch(catalog));
  await ensureBootstrap();
  await updateConfig({ tmdbToken: 'eyJtest' });
  await updateSettings(P, { platforms: ['netflix', 'prime', 'disney', 'max'], country: 'AR' });
}
describe('v3.4 · integración (proveedor simulado)', () => {
  beforeEach(async () => { localStorage.clear(); await freshDb(); });
  it('una preferencia reordena sin quitar títulos y conserva la posición original del motor', async () => {
    for (const t of catalog.filter((x) => x.cluster === 'romance').slice(0, 3)) await rateAndLearn(P, keyOf(t), { watched: true, overall: 9, dimensions: {} });
    const run = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    const base = await rankWithFilters(P, run, F({}), { discover: false });
    const pref = await rankWithFilters(P, run, F({ text: T('con poco romance') }), { discover: false });
    expect(pref.items.map((i) => i.key).sort()).toEqual(base.items.map((i) => i.key).sort()); // nada se quita
    expect(pref.items.every((i) => i.engineRank && i.prefs)).toBe(true);
    const romance = (k: TitleKey) => catalog.find((t) => keyOf(t) === k)!.genres.includes(10749);
    const meanPos = (items: RecommendationItem[]) => { const r = items.filter((i) => romance(i.key)); return r.reduce((s, i) => s + i.rank, 0) / r.length; };
    expect(meanPos(pref.items)).toBeGreaterThan(meanPos(base.items));
    pref.items.forEach((it, i) => expect(it.rank).toBe(i + 1));
  });
  it('las preferencias se combinan con filtros manuales y se guardan con ellos', async () => {
    const f = F({ text: T('Películas con poco romance'), includeGenres: [35] });
    saveFilters(P, f);
    expect(loadFilters(P)).toEqual(f);
    expect(loadFilters(P).text?.prefs?.[0].id).toBe('less-romance');
    const run = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    const r = await rankWithFilters(P, run, f, { discover: false });
    for (const it of r.items) { const t = catalog.find((x) => keyOf(x) === it.key)!; expect(t.type).toBe('movie'); expect(t.genres).toContain(35); }
  });
  it('ordenar con preferencias o abrir el diagnóstico no modifica valoraciones ni ajustes', async () => {
    await rateAndLearn(P, keyOf(catalog[2]), { watched: true, overall: 8, dimensions: {} });
    const before = JSON.stringify((await listRatings(P)).map((r) => [r.key, r.overall, r.updatedAt]));
    const settingsBefore = JSON.stringify(await db.settings.toArray());
    const run = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    await rankWithFilters(P, run, F({ text: T('atmósfera inquietante y misterios que se resuelven gradualmente') }), { discover: false });
    setDiagnostic(true);
    expect(JSON.stringify((await listRatings(P)).map((r) => [r.key, r.overall, r.updatedAt]))).toBe(before);
    expect(JSON.stringify(await db.settings.toArray())).toBe(settingsBefore);
  });
});

describe('v3.4 · público y credenciales', () => {
  it('las reglas de público cambiaron de versión (1.1) por el ajuste validado de Infantil', () => {
    expect(AUDIENCE_RULES).toBe('público-1.1');
  });
  it('ningún archivo del frontend ni del build contiene un token de TMDB', () => {
    const files: string[] = [];
    const walk = (d: string) => { if (!existsSync(d)) return; for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|js|mjs|html|json)$/.test(f) && statSync(p).size < 5e6) files.push(p); } };
    walk('src'); walk('dist'); walk('scripts');
    // v4.2: la única excepción es la clave PÚBLICA «anon» de Supabase (rol anon, pública por diseño). Cualquier otro
    // JWT —un token de TMDB o una clave service_role— es una filtración.
    const jwt = /eyJ[A-Za-z0-9_-]{30,}\.([A-Za-z0-9_-]{30,})\.[A-Za-z0-9_-]*/g;
    const isPublicAnon = (payload: string) => { try { const j = JSON.parse(Buffer.from(payload, 'base64url').toString()); return j.iss === 'supabase' && j.role === 'anon'; } catch { return false; } };
    const leaks = files.filter((p) => [...readFileSync(p, 'utf8').matchAll(jwt)].some((m) => !isPublicAnon(m[1])));
    expect(leaks).toEqual([]);
  });
});
