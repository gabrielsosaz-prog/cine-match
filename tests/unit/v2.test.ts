/**
 * Pruebas de la v2: migración de datos, visto independiente, filtros y aprendizaje por aspectos.
 * Los escenarios usan un catálogo SINTÉTICO: muestran el comportamiento del motor, no su precisión real.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import Dexie from 'dexie';
import { beforeAll, describe, expect, it } from 'vitest';
import { CineDB, useTestDb } from '../../src/db/db';
import { migrateRating, tenToStars } from '../../src/db/migrations';
import { ensureBootstrap, listRatings, saveRating } from '../../src/db/repo';
import { buildProfile } from '../../src/engine/profile';
import { rank, scoreCandidates } from '../../src/engine/recommender';
import { exportData, importData } from '../../src/services/dataPortability';
import { filterByWatched } from '../../src/pages/Home';
import type { DimensionScores, Rating, TitleKey, TitleMeta } from '../../src/types';
import { syntheticMetas } from '../fixtures/synthetic';
import type { FakeTitle } from '../fixtures/fakeTmdb';

const P = 'p-principal';
const V1_STORES = {
  titles: 'key, type, fetchedAt', availability: 'id, key, country, checkedAt', availabilityEvents: '++id, key, country, detectedAt',
  ratings: 'id, profileId, key, status, updatedAt, [profileId+status]', profiles: 'id', settings: 'profileId', config: 'id',
  runs: '++id, profileId, createdAt', snapshots: '++id, profileId, at', logs: '++id, profileId, at, type',
};
const v1 = (key: string, status: string, extra: object = {}) => ({ id: `${P}|${key}`, profileId: P, key, status, dimensions: {}, createdAt: 1000, updatedAt: 2000, ...extra });

describe('Migración de datos de la v1', () => {
  it('convierte la base existente sin perder valoraciones', async () => {
    const name = `mig-${Date.now()}`;
    const old = new Dexie(name);
    old.version(1).stores(V1_STORES);
    await old.open();
    await old.table('ratings').bulkPut([
      v1('movie:1', 'rated', { overall: 9, dimensions: { story: 10, suspense: 8 } }),
      v1('movie:2', 'watched'),
      v1('tv:3', 'want'),
      v1('tv:4', 'watching', { overall: 7 }),
      v1('movie:5', 'abandoned', { abandonReason: 'Ritmo muy lento', overall: 3 }),
      v1('tv:6', 'not_interested'),
    ]);
    await old.table('profiles').put({ id: P, name: 'Principal', createdAt: 1 });
    old.close();

    const dbv2 = useTestDb(name);
    await ensureBootstrap();
    const rs = new Map((await listRatings(P)).map((r) => [r.key, r]));
    expect(rs.size).toBe(6);
    // v2.1: los aspectos pasan a estrellas (10→5, 8→4) y el original 1-10 queda respaldado
    expect(rs.get('movie:1')).toMatchObject({ watched: true, overall: 9, dimensions: { story: 5, suspense: 4 }, legacy: { dimensions10: { story: 10, suspense: 8 }, fromSchema: 1 }, createdAt: 1000, updatedAt: 2000, schema: 3 });
    expect(rs.get('movie:2')).toMatchObject({ watched: true });
    expect(rs.get('movie:2')!.overall).toBeUndefined();
    expect(rs.get('tv:3')).toMatchObject({ watched: false, list: 'want' });
    expect(rs.get('tv:4')).toMatchObject({ watched: false, list: 'watching', overall: 7 });
    expect(rs.get('movie:5')).toMatchObject({ list: 'abandoned', abandonReason: 'Ritmo muy lento', overall: 3 });
    expect(rs.get('tv:6')).toMatchObject({ notInterested: true, watched: false });
    expect(rs.get('tv:6')!.list).toBeUndefined();
    for (const r of rs.values()) expect((r as any).status).toBeUndefined();
    // El índice nuevo funciona sobre datos migrados
    expect(await dbv2.ratings.where('[profileId+list]').equals([P, 'want']).count()).toBe(1);
    expect((await dbv2.profiles.get(P))?.name).toBe('Principal');
  });

  it('importa exportaciones v1 y vuelve a exportar en el formato actual', async () => {
    useTestDb(`imp-${Date.now()}`); await ensureBootstrap();
    const r = await importData({ format: 'cine-match-export/1', ratings: [v1('movie:9', 'rated', { overall: 8 }), v1('tv:8', 'want')] });
    expect(r.ratings).toBe(2);
    const all = await listRatings(P);
    expect(all.find((x) => x.key === 'movie:9')).toMatchObject({ watched: true, overall: 8 });
    const out = await exportData();
    expect(out.format).toBe('cine-match-export/4') // v4.0: formato actual;
    expect(out.ratings.every((x: Rating) => x.schema === 3)).toBe(true);
  });

  it('migrateRating es idempotente', () => {
    const once = migrateRating(v1('movie:1', 'rated', { overall: 9 }));
    expect(migrateRating(once)).toEqual(once);
  });
});

describe('Filtro de vistos del ranking', () => {
  const rows = [{ key: 'movie:1' as TitleKey }, { key: 'movie:2' as TitleKey }, { key: 'movie:3' as TitleKey }];
  const ratings = new Map<TitleKey, Rating>([
    ['movie:1', migrateRating(v1('movie:1', 'watched'))],
    ['movie:2', migrateRating(v1('movie:2', 'want', { overall: 8 }))],
  ]);
  it('solo no vistos / solo vistos / todos', () => {
    expect(filterByWatched(rows, ratings, 'unwatched').map((r) => r.key)).toEqual(['movie:2', 'movie:3']);
    expect(filterByWatched(rows, ratings, 'watched').map((r) => r.key)).toEqual(['movie:1']);
    expect(filterByWatched(rows, ratings, 'all')).toHaveLength(3);
  });
  it('mantiene visible una tarjeta recién marcada hasta cambiar de filtro', () => {
    expect(filterByWatched(rows, ratings, 'unwatched', new Set(['movie:1' as TitleKey])).map((r) => r.key)).toContain('movie:1');
  });
});

// ---------- Aprendizaje por aspectos (escenarios sintéticos) ----------
let metas: Map<TitleKey, TitleMeta>, byKey: Map<TitleKey, FakeTitle>;
beforeAll(async () => ({ metas, byKey } = await syntheticMetas(20)));
const keysOf = (c: string) => [...byKey].filter(([, t]) => t.cluster === c).map(([k]) => k);
// Los escenarios se escriben en escala 1-10 (como en la v2.0) y se convierten a estrellas con la misma
// transformación documentada que usa la migración.
const stars = (d: DimensionScores) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, tenToStars(v!)])) as DimensionScores;
const R = (key: TitleKey, overall: number | undefined, dims: DimensionScores = {}, extra: Partial<Rating> = {}): Rating =>
  ({ id: `p|${key}`, profileId: 'p', key, watched: true, overall, dimensions: stars(dims), createdAt: 0, updatedAt: 0, schema: 3, ...extra });
const avgPred = (ratings: Rating[], cands: TitleKey[]) => {
  const profile = buildProfile(ratings, metas);
  const s = scoreCandidates({ profile, ratings, titles: metas, candidates: cands });
  return s.reduce((a, x) => a + x.pred, 0) / s.length;
};
const report: Record<string, unknown> = {};

describe('Aprendizaje con puntuaciones por aspecto', () => {
  it('mismas notas generales, distintos aspectos → distintas recomendaciones', () => {
    const th = keysOf('thriller'), dr = keysOf('drama');
    const thC = th.slice(6), drC = dr.slice(6);
    const base = [...th.slice(0, 6).map((k) => R(k, 8)), ...dr.slice(0, 6).map((k) => R(k, 8))];
    const A = [...th.slice(0, 6).map((k) => R(k, 8, { suspense: 10, pacing: 9 })), ...dr.slice(0, 6).map((k) => R(k, 8, { emotion: 4, pacing: 4 }))];
    const B = [...th.slice(0, 6).map((k) => R(k, 8, { suspense: 4, pacing: 4 })), ...dr.slice(0, 6).map((k) => R(k, 8, { emotion: 10, pacing: 9 }))];
    const r = {
      sinAspectos: { thriller: avgPred(base, thC), drama: avgPred(base, drC) },
      suspensoAltoEnThrillers: { thriller: avgPred(A, thC), drama: avgPred(A, drC) },
      emocionAltaEnDramas: { thriller: avgPred(B, thC), drama: avgPred(B, drC) },
    };
    report['Escenario 1: notas generales iguales (8) en thrillers y dramas'] = r;
    expect(Math.abs(r.sinAspectos.thriller - r.sinAspectos.drama)).toBeLessThan(0.6);
    expect(r.suspensoAltoEnThrillers.thriller).toBeGreaterThan(r.suspensoAltoEnThrillers.drama + 0.3);
    expect(r.emocionAltaEnDramas.drama).toBeGreaterThan(r.emocionAltaEnDramas.thriller + 0.3);
  });

  it('aprende qué aspectos pesan en tu nota general', () => {
    const keys = [...metas.keys()].slice(0, 16);
    // Tu nota general sigue a las actuaciones; el ritmo varía sin relación
    const rs = keys.map((k, i) => { const acting = 3 + (i * 7) % 8; return R(k, acting, { acting, pacing: 3 + (i * 5) % 7 }); });
    const p = buildProfile(rs, metas);
    const acting = p.dimensions.find((d) => d.id === 'acting')!, pacing = p.dimensions.find((d) => d.id === 'pacing')!;
    report['Escenario 2: importancia aprendida'] = { actuaciones: +acting.importance.toFixed(2), ritmo: +pacing.importance.toFixed(2), promedio: 1 };
    expect(acting.importance).toBeGreaterThan(pacing.importance * 1.5);
    expect(acting.learned).not.toBeNull();
  });

  it('un aspecto sin puntuar no cuenta como nota baja', () => {
    const th = keysOf('thriller'), dr = keysOf('drama');
    const plain = [...th.slice(0, 6).map((k) => R(k, 8)), ...dr.slice(0, 6).map((k) => R(k, 8))];
    const partial = [...th.slice(0, 6).map((k) => R(k, 8, { suspense: 9 })), ...dr.slice(0, 6).map((k) => R(k, 8))];
    const p = buildProfile(partial, metas);
    // Los rasgos exclusivos de dramas no tienen afinidad de suspenso: no hay datos, no son negativos
    const dramaOnly = [...p.dimFeatures.get('suspense')!.keys()].filter((f) => f === 'g:36' || f === 'g:10752');
    expect(dramaOnly).toHaveLength(0);
    const plainPred = avgPred(plain, dr.slice(6)), partialPred = avgPred(partial, dr.slice(6));
    report['Escenario 3: aspecto ausente'] = { dramasSinAspectos: +plainPred.toFixed(2), dramasConSuspensoSoloEnThrillers: +partialPred.toFixed(2) };
    expect(partialPred).toBeGreaterThan(plainPred - 0.35);
  });

  it('una puntuación de aspecto extrema no distorsiona el perfil', () => {
    const th = keysOf('thriller');
    const rs = th.slice(0, 8).map((k) => R(k, 8, { suspense: 9 }));
    const p1 = buildProfile(rs, metas);
    const p2 = buildProfile([...rs.slice(0, 7), R(th[7], 8, { suspense: 1 })], metas);
    const a1 = p1.dimFeatures.get('suspense')!.get('g:53')?.affinity ?? 0;
    const a2 = p2.dimFeatures.get('suspense')!.get('g:53')?.affinity ?? 0;
    report['Escenario 4: una nota de suspenso de 1 entre ocho de 9'] = { afinidadAntes: +a1.toFixed(2), afinidadDespues: +a2.toFixed(2) };
    expect(Math.abs(a1 - a2)).toBeLessThan(0.9);
  });

  it('modificar aspectos de títulos ya valorados cambia las recomendaciones', () => {
    const th = keysOf('thriller'), sc = keysOf('scifi');
    // Historial que muestra que el suspenso pesa en tus notas (la general acompaña al suspenso)
    const hist = [...keysOf('comedy').slice(0, 5), ...keysOf('romance').slice(0, 5)].map((k, i) => { const v = 4 + (i % 6); return R(k, v, { suspense: v }); });
    const base = [...hist, ...th.slice(0, 5).map((k) => R(k, 8, { suspense: 8 })), ...sc.slice(0, 5).map((k) => R(k, 8))];
    const lowSuspense = [...hist, ...th.slice(0, 5).map((k) => R(k, 8, { suspense: 3 })), ...sc.slice(0, 5).map((k) => R(k, 8))];
    const highScifi = [...hist, ...th.slice(0, 5).map((k) => R(k, 8, { suspense: 8 })), ...sc.slice(0, 5).map((k) => R(k, 8, { suspense: 10 }))];
    const cands = [...th.slice(5), ...sc.slice(5)];
    const top = (rs: Rating[]) => rank({ profile: buildProfile(rs, metas), ratings: rs, titles: metas, candidates: cands, limit: 10 });
    const share = (items: { key: TitleKey }[]) => items.filter((i) => byKey.get(i.key)!.cluster === 'scifi').length;
    const r = {
      pesoDelSuspenso: +buildProfile(base, metas).dimensions.find((d) => d.id === 'suspense')!.importance.toFixed(2),
      thrillers: { base: avgPred(base, th.slice(5)), suspensoBajadoA3: avgPred(lowSuspense, th.slice(5)) },
      cienciaFiccion: { base: avgPred(base, sc.slice(5)), suspensoSubidoA10: avgPred(highScifi, sc.slice(5)) },
      cienciaFiccionEnTop10: { base: share(top(base)), suspensoBajoEnThrillers: share(top(lowSuspense)), suspensoAltoEnCienciaFiccion: share(top(highScifi)) },
    };
    report['Escenario 5: editar el suspenso de títulos ya valorados (con historial donde el suspenso pesa)'] = r;
    expect(r.thrillers.suspensoBajadoA3).toBeLessThan(r.thrillers.base - 0.2);
    expect(r.cienciaFiccion.suspensoSubidoA10).toBeGreaterThan(r.cienciaFiccion.base + 0.2);
    expect(top(base).map((i) => i.key).join()).not.toBe(top(lowSuspense).map((i) => i.key).join());
    expect(r.cienciaFiccionEnTop10.suspensoBajoEnThrillers).toBeGreaterThanOrEqual(r.cienciaFiccionEnTop10.base);
  });

  it('las explicaciones mencionan aspectos reales del historial y estiman notas por aspecto', () => {
    const th = keysOf('thriller');
    const rs = th.slice(0, 8).map((k) => R(k, 9, { suspense: 10, ending: 9 }));
    const items = rank({ profile: buildProfile(rs, metas), ratings: rs, titles: metas, candidates: th.slice(8), limit: 5 });
    expect(items[0].dimensionEstimates?.suspense).toBeGreaterThan(4); // estrellas
    expect(items[0].explanation.join(' ')).toMatch(/suspenso o intriga/);
    expect(items[0].explanation.join(' ')).not.toMatch(/actuaciones/); // nunca puntuado
  });

  it('«vista» sin nota no es una señal de gusto', () => {
    const hor = keysOf('horror');
    const p = buildProfile(hor.slice(0, 6).map((k) => R(k, undefined)), metas);
    expect(p.signals).toHaveLength(0);
    expect(p.features.size).toBe(0);
  });

  it('una valoración sólo con aspectos cuenta, con menos peso que una general', () => {
    const k = keysOf('comedy')[0];
    const p = buildProfile([R(k, undefined, { story: 9, emotion: 9 }, { watched: false })], metas);
    expect(p.signals[0]).toMatchObject({ kind: 'aspects' });
    expect(p.signals[0].weight).toBeLessThan(1);
  });

  it('escribe el informe de escenarios', () => {
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/dimension-scenarios.json', JSON.stringify({ aviso: 'Escenarios sintéticos: muestran cómo responde el motor, no validan su precisión con usuarios reales.', escenarios: report }, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 2));
    expect(Object.keys(report).length).toBeGreaterThanOrEqual(5);
  });
});

it('la base nueva abre vacía sin errores (versión 4 desde Cine Match 4.0)', async () => {
  const d = new CineDB(`fresh-${Date.now()}`);
  await d.open();
  expect(d.verno).toBe(4);
  d.close();
});
