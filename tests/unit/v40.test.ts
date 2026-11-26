/**
 * v4.0 · Motor de atractivo personalizado (experimental).
 * - reglas y pesos idénticos al prototipo; preferencias flexibles frente a exclusiones estrictas;
 * - exclusiones (vistos, descartados, con registro) y una entrega por saga;
 * - respuestas de interés: separadas de las notas, coherentes con descartes y vistas, historial;
 * - persistencia: actualización de la base sin perder valoraciones; exportación/importación con los datos nuevos;
 * - estadísticas por motor (un no visto no es un fallo);
 * - rendimiento con el catálogo real.
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, useTestDb } from '../../src/db/db';
import { ensureBootstrap, listRatings, saveRating } from '../../src/db/repo';
import { NarrativeIndex, type CatalogMeta } from '../../src/engine/narrative';
import {
  ATTRACTION_PARAMS, PREFS, capRules, catalogCandidates, emptyTasteProfile, rankAttraction, ruleHits, scoreAttraction, type AttractionContext,
} from '../../src/engine/attraction';
import { rankWithAttraction } from '../../src/engine/attractionEngine';
import { exportData, mergeImport, planImport } from '../../src/services/dataPortability';
import { useTestBackupDb } from '../../src/services/backups';
import { engineStats, getTaste, interestMap, listInterests, recordInterest, recordShown, saveTaste } from '../../src/services/taste';
import { ENGINES, ENGINE_LABEL } from '../../src/services/recommendations';
import type { InterestRecord, Rating, TasteProfile, TitleKey, TitleMeta } from '../../src/types';

const P = 'p-principal';
let n = 0;
beforeEach(() => { localStorage.clear(); useTestDb(`v40-${n}`); useTestBackupDb(`v40-${n++}-bk`); });

// ───────── catálogo sintético ─────────
const DIM = 8;
interface Row { key: string; year?: number; genres?: number[]; kw?: [number, string][]; facets?: [string, number][]; runtime?: number; seasons?: number; votes?: number; vote?: number; prov?: number[]; collection?: number; v: number[] }
function makeIdx(rows: Row[]): NarrativeIndex {
  const kwNames: Record<string, string> = {};
  for (const r of rows) for (const [id, name] of r.kw ?? []) kwNames[id] = name;
  const meta: CatalogMeta = {
    version: 'test', model: 'sintético', dim: DIM, embedded: rows.length, n: rows.length, semZ: 2.3,
    calib: { p50: 0.2, p90: 0.5, p99: 0.7, p999: 0.85, mean: 0.2 }, sources: {}, df: { kw: {}, facet: {}, genre: {} }, kwNames,
    titles: rows.map((r) => [r.key, r.key, r.year ?? 2020, r.genres ?? [18], (r.kw ?? []).map(([id]) => id), ['US'], 'en', r.collection ?? 0, [], [], [], r.vote ?? 7, r.votes ?? 1000, 10, '',
      (r.facets ?? []).map(([id, c]) => [id, c, [], 0]), 2, 800, r.prov ?? [8], r.runtime ?? 0, r.seasons ?? 0]),
  };
  const emb = new Int8Array(rows.length * DIM);
  rows.forEach((r, i) => { const nn = Math.hypot(...r.v); r.v.forEach((x, j) => { emb[i * DIM + j] = Math.round((x / nn) * 127); }); });
  return new NarrativeIndex(meta, emb);
}
const allOn = (): TasteProfile => ({ ...emptyTasteProfile(P), prefs: Object.fromEntries(PREFS.map((p) => [p.id, 'on'])) });
const rating = (key: string, o: Partial<Rating>): Rating => ({ id: `${P}|${key}`, profileId: P, key: key as TitleKey, watched: false, dimensions: {}, createdAt: 1, updatedAt: 1, schema: 3, ...o });
const v = (...xs: number[]) => [...xs, ...Array(DIM - xs.length).fill(0)];

describe('v4.0 · reglas del perfil (pesos del prototipo)', () => {
  const idx = makeIdx([
    { key: 'movie:1', year: 1985, runtime: 160, genres: [10752, 18], v: v(1) },
    { key: 'movie:2', year: 2019, runtime: 100, genres: [53], kw: [[10, 'plot twist'], [11, 'artificial intelligence']], facets: [['mys.psych', 0.6], ['pace.fast', 0.5]], v: v(0, 1) },
    { key: 'tv:3', year: 2017, seasons: 12, genres: [80], kw: [[12, 'police procedural']], v: v(0, 0, 1) },
    { key: 'tv:4', year: 2021, seasons: 2, genres: [9648], facets: [['mys.missing', 0.8]], v: v(0, 0, 0, 1) },
  ]);
  it('aplica los pesos exactos del prototipo', () => {
    const t = allOn();
    const h1 = ruleHits(idx, idx.get('movie:1' as TitleKey)!, new Set(), t.prefs).hits;
    expect(h1.map((h) => h.w)).toEqual([-1.5, -1.0, -1.2]);
    const h2 = ruleHits(idx, idx.get('movie:2' as TitleKey)!, new Set(), t.prefs).hits;
    expect(h2.map((h) => [h.pref, h.w])).toEqual([['modern', 0.2], ['shortMovies', 0.2], ['twists', 0.8], ['psychThriller', 0.6], ['plausibleScifi', 0.8], ['fastPace', 0.3]]);
    // tope de +1,4 a las positivas (2,9 → 1,4)
    expect(capRules(h2)).toBeCloseTo(1.4);
    const h3 = ruleHits(idx, idx.get('tv:3' as TitleKey)!, new Set(), t.prefs).hits;
    expect(h3.map((h) => h.w)).toEqual([0.2, -1.0, -1.0]);
    const h4 = ruleHits(idx, idx.get('tv:4' as TitleKey)!, new Set(), t.prefs).hits;
    expect(h4.map((h) => h.w)).toEqual([0.2, 0.4, 0.5]);
  });
  it('las marcas de Wikipedia cuentan igual que en el prototipo', () => {
    const h = ruleHits(idx, idx.get('tv:4' as TitleKey)!, new Set(['war']), allOn().prefs).hits;
    expect(h.some((x) => x.pref === 'noWar' && x.w === -1.2)).toBe(true);
  });
  it('preferencia apagada: no se aplica; flexible: nunca excluye; estricta: excluye sólo lo que cumple', () => {
    const t = allOn();
    const off = { ...t.prefs, modern: 'off' as const };
    expect(ruleHits(idx, idx.get('movie:1' as TitleKey)!, new Set(), off).hits.some((h) => h.pref === 'modern')).toBe(false);
    expect(ruleHits(idx, idx.get('movie:1' as TitleKey)!, new Set(), t.prefs).excludedBy).toBeUndefined();
    const strict = { ...t.prefs, modern: 'strict' as const };
    expect(ruleHits(idx, idx.get('movie:1' as TitleKey)!, new Set(), strict).excludedBy).toBe('modern');
    expect(ruleHits(idx, idx.get('movie:2' as TitleKey)!, new Set(), strict).excludedBy).toBeUndefined();
  });
  it('un perfil nuevo no trae preferencias activas (los datos personales se importan, no vienen en la app)', () => {
    expect(Object.keys(emptyTasteProfile('x').prefs)).toHaveLength(0);
    expect(emptyTasteProfile('x').anchors).toHaveLength(0);
  });
});

describe('v4.0 · orden, candidatos y exclusiones', () => {
  const idx = makeIdx([
    { key: 'movie:10', v: v(1, 0) },                        // muy parecido a lo que gustó
    { key: 'movie:11', v: v(0.9, 0.1), collection: 77 },
    { key: 'movie:12', v: v(0.85, 0.15), collection: 77 },  // misma saga que 11
    { key: 'movie:13', v: v(0, 1) },                        // parecido a lo descartado
    { key: 'movie:14', v: v(0.5, 0.5), votes: 50 },         // pocos votos
    { key: 'movie:15', v: v(0.7, 0.3), prov: [999] },       // otra plataforma
    { key: 'movie:16', v: v(0.8, 0.2) },                    // vista
    { key: 'movie:17', v: v(0.8, 0.2) },                    // respondida «Ya la vi»
    { key: 'movie:1', v: v(1, 0.05) }, { key: 'movie:2', v: v(0.05, 1) },
  ]);
  const ratings = [rating('movie:1', { overall: 9, watched: true }), rating('movie:2', { notInterested: true }), rating('movie:16', { watched: true })];
  const interests: InterestRecord[] = [{ id: 'a', profileId: P, key: 'movie:17' as TitleKey, answer: 'visto', at: 1 }];
  const ctx: AttractionContext = { idx, flags: new Map(), ratings, interests, taste: allOn() };
  it('candidatos del método: plataforma, ≥ 80 votos, sin registro ni «Ya la vi»/«No me interesa»', () => {
    const c = catalogCandidates(idx, [8], ratings, interests);
    expect(c.sort()).toEqual(['movie:10', 'movie:11', 'movie:12', 'movie:13']);
  });
  it('ordena por A + 0,3·S, una entrega por saga, y lo parecido a lo descartado queda abajo', () => {
    const s = scoreAttraction(ctx, ['movie:10', 'movie:11', 'movie:12', 'movie:13'] as TitleKey[]);
    for (const x of s) expect(x.order).toBeCloseTo(x.attraction + ATTRACTION_PARAMS.satisfactionWeight * x.satisfaction, 9);
    const r = rankAttraction(s, idx).map((x) => x.key);
    expect(r[0]).toBe('movie:10');
    expect(r).not.toContain('movie:12');
    expect(r[r.length - 1]).toBe('movie:13');
  });
  it('el adaptador nunca devuelve vistos ni descartados (salvo pedido explícito de vistos)', () => {
    const titles = new Map<TitleKey, TitleMeta>();
    const base = { profile: {} as never, ratings, titles, settings: {}, attraction: ctx };
    const out = rankWithAttraction({ ...base, candidates: ['movie:10', 'movie:16', 'movie:2'] as TitleKey[] }).map((i) => i.key);
    expect(out).toEqual(['movie:10']);
    const withWatched = rankWithAttraction({ ...base, candidates: ['movie:10', 'movie:16'] as TitleKey[], includeWatched: true }).map((i) => i.key);
    expect(withWatched).toContain('movie:16');
  });
  it('separa compatibilidad, satisfacción (marcada poco fiable) y explica sin texto genérico', () => {
    const titles = new Map<TitleKey, TitleMeta>([['movie:1' as TitleKey, { title: 'Película uno' } as TitleMeta]]);
    const [it] = rankWithAttraction({ profile: {} as never, ratings, titles, settings: {}, attraction: ctx, candidates: ['movie:10'] as TitleKey[] });
    expect(it.attraction).toBeDefined();
    expect(it.attraction!.satisfactionReliable).toBe(false);
    expect(['muy alta', 'alta', 'media', 'baja']).toContain(it.attraction!.level);
    expect(it.attraction!.similar).toContain('Película uno');
  });
  it('v4.0 está registrado junto a v3.4 y v3.5', () => {
    expect(Object.keys(ENGINES).sort()).toEqual(['v3.4', 'v3.5', 'v4.0']);
    expect(ENGINE_LABEL['attraction-4.0.0']).toBe('v4.0');
  });
});

describe('v4.0 · respuestas de interés (no son notas)', () => {
  it('«No me interesa» descarta, «Ya la vi» marca vista, nada cambia la nota; vale la última respuesta', async () => {
    await ensureBootstrap();
    await saveRating(P, 'movie:5' as TitleKey, { overall: 8, watched: true });
    await recordInterest(P, 'movie:7' as TitleKey, 'no', { engine: 'attraction-4.0.0', rank: 3 });
    await recordInterest(P, 'movie:8' as TitleKey, 'visto', { seenRating: 7 });
    await recordInterest(P, 'movie:5' as TitleKey, 'mucho');
    await recordInterest(P, 'movie:9' as TitleKey, 'quiza');
    await recordInterest(P, 'movie:9' as TitleKey, 'si');
    const rs = new Map((await listRatings(P)).map((r) => [r.key, r]));
    expect(rs.get('movie:7' as TitleKey)?.notInterested).toBe(true);
    expect(rs.get('movie:8' as TitleKey)?.watched).toBe(true);
    expect(rs.get('movie:8' as TitleKey)?.overall).toBeUndefined();
    expect(rs.get('movie:5' as TitleKey)?.overall).toBe(8);
    expect(rs.has('movie:9' as TitleKey)).toBe(false); // un interés no crea una valoración
    const m = await interestMap(P);
    expect(m.get('movie:9' as TitleKey)?.answer).toBe('si');
    expect((await listInterests(P)).filter((i) => i.key === 'movie:9')).toHaveLength(2); // historial completo
    expect(m.get('movie:7' as TitleKey)?.engine).toBe('attraction-4.0.0');
    // cambiar de «No» a «Me interesa» quita el descarte
    await recordInterest(P, 'movie:7' as TitleKey, 'si');
    expect((await listRatings(P)).find((r) => r.key === 'movie:7')?.notInterested).toBeUndefined();
  });
});

describe('v4.0 · estadísticas por motor', () => {
  it('un título mostrado y no visto no cuenta como fallo; vincula notas posteriores', () => {
    const shown = [
      { id: '1', profileId: P, key: 'movie:1' as TitleKey, engine: 'E', firstAt: 100, lastAt: 100, bestRank: 1, satisfaction: 7 },
      { id: '2', profileId: P, key: 'movie:2' as TitleKey, engine: 'E', firstAt: 100, lastAt: 100, bestRank: 2 },
      { id: '3', profileId: P, key: 'movie:3' as TitleKey, engine: 'E', firstAt: 100, lastAt: 100, bestRank: 3 },
      { id: '4', profileId: P, key: 'movie:4' as TitleKey, engine: 'E', firstAt: 100, lastAt: 100, bestRank: 4 },
    ];
    const interests: InterestRecord[] = [
      { id: 'a', profileId: P, key: 'movie:1' as TitleKey, answer: 'mucho', at: 150 },
      { id: 'b', profileId: P, key: 'movie:2' as TitleKey, answer: 'no', at: 150 },
      { id: 'c', profileId: P, key: 'movie:9' as TitleKey, answer: 'si', at: 150 }, // no lo mostró este motor
      { id: 'd', profileId: P, key: 'movie:4' as TitleKey, answer: 'si', at: 50 },  // anterior a mostrarse
    ];
    const ratings = [rating('movie:1', { overall: 9, watched: true, watchedAt: 200, updatedAt: 200 }), rating('movie:3', { overall: 6, updatedAt: 50 })];
    const [s] = engineStats(shown, interests, ratings);
    expect(s.shown).toBe(4);
    expect(s.answered).toBe(2);
    expect(s.interestRate).toBe(0.5); // 1 de 2 respondidos no vistos; movie:3 (sin respuesta) no cuenta
    expect(s.watched).toBe(1);
    expect(s.ratedAfter).toBe(1); // la nota de movie:3 es anterior a mostrarse
    expect(s.meanRatingAfter).toBe(9);
    expect(s.satisfactionError).toBe(2);
  });
});

describe('v4.0 · persistencia', () => {
  it('actualizar la base de la versión 3 a la 4 conserva todas las valoraciones', async () => {
    const name = `v40-upgrade-${n++}`;
    const old = new Dexie(name);
    old.version(3).stores({
      titles: 'key, type, fetchedAt', availability: 'id, key, country, checkedAt', availabilityEvents: '++id, key, country, detectedAt',
      ratings: 'id, profileId, key, updatedAt, [profileId+list]', profiles: 'id', settings: 'profileId', config: 'id',
      runs: '++id, profileId, createdAt', snapshots: '++id, profileId, at', logs: '++id, profileId, at, type',
    });
    await old.open();
    const rs = Array.from({ length: 120 }, (_, i) => rating(`movie:${i + 1}`, { overall: (i % 10) + 1, watched: true }));
    await old.table('ratings').bulkPut(rs);
    old.close();
    const fresh = useTestDb(name);
    await fresh.open();
    expect(fresh.verno).toBe(4);
    expect(await fresh.ratings.count()).toBe(120);
    expect((await fresh.ratings.get(`${P}|movie:7`))?.overall).toBe(7);
    expect(await fresh.interests.count()).toBe(0);
  });
  it('exporta e importa perfil de gustos, respuestas y registros; no duplica ni pisa un perfil más nuevo', async () => {
    await ensureBootstrap();
    await saveRating(P, 'movie:1' as TitleKey, { overall: 9, watched: true });
    const t = await saveTaste({ ...allOn(), anchors: ['movie:2' as TitleKey] });
    await recordInterest(P, 'movie:3' as TitleKey, 'mucho', { engine: 'attraction-4.0.0' });
    await recordShown(P, 'attraction-4.0.0', [{ key: 'movie:3' as TitleKey, rank: 1 } as never]);
    const file = JSON.parse(JSON.stringify(await exportData()));
    expect(file.format).toBe('cine-match-export/4');
    expect(file.taste).toHaveLength(1);
    expect(file.interests).toHaveLength(1);
    expect(file.shown).toHaveLength(1);
    // dispositivo nuevo
    useTestDb(`v40-import-${n++}`);
    const plan = await planImport(file);
    expect(plan.interestsAdded).toBe(1);
    expect(plan.tasteUpdated).toBe(1);
    await mergeImport(file);
    expect((await getTaste(P)).anchors).toEqual(['movie:2']);
    expect(await db.interests.count()).toBe(1);
    expect(await db.ratings.count()).toBe(1);
    // reimportar: no duplica
    await mergeImport(file);
    expect(await db.interests.count()).toBe(1);
    // un perfil del dispositivo más nuevo no se pisa con el del archivo
    await saveTaste({ ...(await getTaste(P)), anchors: [] });
    await mergeImport(file);
    expect((await getTaste(P)).anchors).toEqual([]);
    expect(t.updatedAt).toBeGreaterThan(0);
  });
  it('importa un archivo sólo con perfil y respuestas (sin valoraciones) sin tocar las existentes', async () => {
    await ensureBootstrap();
    await saveRating(P, 'movie:1' as TitleKey, { overall: 9, watched: true });
    const file = { format: 'cine-match-export/4', ratings: [], profiles: [], settings: [], taste: [{ ...allOn(), updatedAt: 5 }], interests: [{ id: `${P}|movie:4|1`, profileId: P, key: 'movie:4', answer: 'si', at: 1, source: 'cata-2' }] };
    const plan = await mergeImport(file);
    expect(plan.interestsAdded).toBe(1);
    expect((await listRatings(P)).map((r) => r.overall)).toEqual([9]);
    expect(Object.values((await getTaste(P)).prefs).every((x) => x === 'on')).toBe(true);
  });
  it('los formatos anteriores (1 a 3) se siguen importando', async () => {
    await ensureBootstrap();
    const plan = await mergeImport({ format: 'cine-match-export/3', ratings: [rating('movie:1', { overall: 7, updatedAt: 9 })], profiles: [] });
    expect(plan.added).toBe(1);
    expect(plan.interestsAdded).toBe(0);
  });
});

// ───────── catálogo real: rendimiento ─────────
const man = existsSync('public/catalog/manifest.json') ? JSON.parse(readFileSync('public/catalog/manifest.json', 'utf8')) : undefined;
describe.skipIf(!man?.attractionFlags)('v4.0 · catálogo real', () => {
  it('puntúa todo el catálogo candidato en tiempo razonable y respeta las exclusiones', () => {
    const cm = JSON.parse(readFileSync(`public/catalog/${man.meta}`, 'utf8')) as CatalogMeta;
    const buf = readFileSync(`public/catalog/${man.emb}`);
    const idx = new NarrativeIndex(cm, new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    const fl = JSON.parse(readFileSync(`public/catalog/${man.attractionFlags}`, 'utf8')).flags as Record<string, string[]>;
    const flags = new Map(Object.entries(fl).map(([k, x]) => [k as TitleKey, new Set(x)]));
    // historial ficticio (no personal): 30 títulos con nota y 20 descartes del propio catálogo
    const ks = idx.titles.filter((t) => t.row >= 0).map((t) => t.key);
    const ratings = [...ks.slice(0, 30).map((k, i) => rating(k, { overall: (i % 10) + 1, watched: true })), ...ks.slice(30, 50).map((k) => rating(k, { notInterested: true }))];
    const ctx: AttractionContext = { idx, flags, ratings, interests: [], taste: allOn() };
    const cands = catalogCandidates(idx, [8, 1796, 119, 9, 337, 1899, 384, 531], ratings, []);
    const t0 = performance.now();
    const ranked = rankAttraction(scoreAttraction(ctx, cands), idx, 200);
    const ms = performance.now() - t0;
    expect(cands.length).toBeGreaterThan(2000);
    expect(ranked).toHaveLength(200);
    const hist = new Set(ratings.map((r) => r.key));
    expect(ranked.some((r) => hist.has(r.key))).toBe(false);
    expect(ms).toBeLessThan(4000);
    console.log(`v4.0 catálogo real: ${cands.length} candidatos en ${Math.round(ms)} ms`);
  });
});
