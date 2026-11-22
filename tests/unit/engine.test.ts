import { beforeAll, describe, expect, it } from 'vitest';
import { buildProfile } from '../../src/engine/profile';
import { rank, ALGORITHM_VERSION, hybridEngine } from '../../src/engine/recommender';
import type { Rating, TitleKey, TitleMeta } from '../../src/types';
import { syntheticMetas, simulateHistory, USERS } from '../fixtures/synthetic';
import type { FakeTitle } from '../fixtures/fakeTmdb';

let metas: Map<TitleKey, TitleMeta>, catalog: FakeTitle[], byKey: Map<TitleKey, FakeTitle>;
beforeAll(async () => ({ metas, catalog, byKey } = await syntheticMetas(20)));
const keysOf = (c: string) => [...byKey].filter(([, t]) => t.cluster === c).map(([k]) => k);
const R = (key: TitleKey, overall: number, extra: Partial<Rating> = {}): Rating => ({ id: `p|${key}`, profileId: 'p', key, status: 'rated', overall, dimensions: {}, createdAt: 0, updatedAt: 0, ...extra });
const genreAff = (p: ReturnType<typeof buildProfile>, g: number) => p.features.get(`g:${g}`)?.affinity ?? 0;

describe('Actualización de preferencias', () => {
  it('una valoración alta sube la afinidad de sus rasgos y una baja la reduce', () => {
    const [a, b] = keysOf('thriller');
    const p0 = buildProfile([R(a, 9)], metas);
    const p1 = buildProfile([R(a, 9), R(b, 10)], metas);
    expect(genreAff(p1, 53)).toBeGreaterThan(genreAff(p0, 53));
    const c = keysOf('comedy')[0];
    const pNeg = buildProfile([R(a, 9), R(c, 2)], metas);
    expect(genreAff(pNeg, 35)).toBeLessThan(0);
  });
  it('una sola valoración extrema no distorsiona el perfil', () => {
    const th = keysOf('thriller');
    const base = th.slice(0, 8).map((k) => R(k, 9));
    const p = buildProfile(base, metas);
    const p2 = buildProfile([...base, R(th[8], 1)], metas);
    expect(genreAff(p2, 53)).toBeGreaterThan(0);
    expect(Math.abs(genreAff(p2, 53) - genreAff(p, 53))).toBeLessThan(0.8);
    const single = buildProfile([R(keysOf('horror')[0], 10)], metas);
    expect(genreAff(single, 27)).toBeLessThan(2.5); // contracción: una nota no da afinidad máxima
  });
  it('señales implícitas: abandonada y "no me interesa" cuentan como negativas', () => {
    const k = keysOf('horror')[0];
    const p = buildProfile([R(keysOf('comedy')[0], 8), { ...R(k, 0), overall: undefined, status: 'not_interested' }], metas);
    expect(genreAff(p, 27)).toBeLessThan(0);
    const p2 = buildProfile([R(keysOf('comedy')[0], 8), { ...R(k, 0), overall: undefined, status: 'abandoned', abandonReason: 'Ritmo muy lento' }], metas);
    expect(genreAff(p2, 27)).toBeLessThan(genreAff(p, 27));
  });
  it('aprende la importancia de cada dimensión a partir de la nota general', () => {
    const ks = [...metas.keys()].slice(0, 8);
    const rs = ks.map((k, i) => R(k, 3 + (i % 6), { dimensions: { suspense: 3 + (i % 6), visuals: 7 } }));
    const p = buildProfile(rs, metas);
    const sus = p.dimensions.find((d) => d.id === 'suspense')!;
    const vis = p.dimensions.find((d) => d.id === 'visuals')!;
    expect(sus.importance).toBeGreaterThan(vis.importance);
  });
  it('los pesos manuales por dimensión se aplican', () => {
    const ks = [...metas.keys()].slice(0, 3);
    const p = buildProfile(ks.map((k) => R(k, 7, { dimensions: { ending: 8 } })), metas, { ending: 2 });
    expect(p.dimensions.find((d) => d.id === 'ending')!.importance).toBe(2);
  });
});

describe('Generación del ranking', () => {
  const ranked = (ratings: Rating[], extra: object = {}) => {
    const profile = buildProfile(ratings, metas);
    return rank({ profile, ratings, titles: metas, candidates: [...metas.keys()], limit: 20, ...extra });
  };
  it('cada ítem tiene posición, nota, confianza y explicación', () => {
    const items = ranked(keysOf('thriller').slice(0, 6).map((k) => R(k, 9)));
    expect(items).toHaveLength(20);
    items.forEach((it, i) => {
      expect(it.rank).toBe(i + 1);
      expect(it.score).toBeGreaterThanOrEqual(1); expect(it.score).toBeLessThanOrEqual(10);
      expect(it.confidence).toBeGreaterThanOrEqual(0); expect(it.confidence).toBeLessThanOrEqual(1);
      expect(it.explanation.length).toBeGreaterThan(0);
    });
    expect(ALGORITHM_VERSION).toMatch(/^hybrid/);
    expect(hybridEngine.version).toBe(ALGORITHM_VERSION);
  });
  it('excluye vistas, pendientes y rechazadas', () => {
    const rs = [...keysOf('thriller').slice(0, 5).map((k) => R(k, 9)), { ...R(keysOf('thriller')[6], 0), overall: undefined, status: 'not_interested' as const }, { ...R(keysOf('thriller')[7], 0), overall: undefined, status: 'want' as const }];
    const items = ranked(rs, { limit: 200 });
    const excluded = new Set(rs.map((r) => r.key));
    expect(items.some((i) => excluded.has(i.key))).toBe(false);
  });
  it('excluye géneros que el usuario no quiere ver', () => {
    const items = ranked(keysOf('thriller').slice(0, 5).map((k) => R(k, 9)), { settings: { excludedGenres: [27] }, limit: 100 });
    expect(items.some((i) => metas.get(i.key)!.genres.some((g) => g.id === 27))).toBe(false);
  });
  it('las explicaciones citan títulos reales del historial, sin spoilers', () => {
    const liked = keysOf('thriller').slice(0, 6);
    const items = ranked(liked.map((k) => R(k, 9)));
    const names = liked.map((k) => metas.get(k)!.title);
    const text = items.slice(0, 5).flatMap((i) => i.explanation).join(' ');
    expect(names.some((n) => text.includes(n))).toBe(true);
    expect(text).not.toMatch(/plot twist|giro/i);
    // Nunca menciona títulos no valorados como "que puntuaste"
    for (const it of items) for (const line of it.explanation.filter((l) => l.startsWith('Se parece a'))) {
      const cited = [...metas.values()].filter((m) => line.includes(m.title + ' (') || line.includes(m.title + ','));
      for (const c of cited) expect(liked).toContain(c.key);
    }
  });
  it('con pocas valoraciones marca la recomendación como provisional', () => {
    const items = ranked([R(keysOf('comedy')[0], 8)]);
    expect(items.every((i) => i.provisional)).toBe(true);
    expect(items[0].explanation.join(' ')).toMatch(/provisional/);
  });
  it('arranque en frío: sin valoraciones igual produce ranking', () => {
    const items = ranked([]);
    expect(items.length).toBe(20);
    expect(items.every((i) => i.confidenceLabel === 'baja')).toBe(true);
  });
  it('la confianza crece con más información', () => {
    const th = keysOf('thriller');
    const few = ranked(th.slice(0, 2).map((k) => R(k, 9)));
    const many = ranked(th.slice(0, 12).map((k) => R(k, 9)));
    const avg = (xs: { confidence: number }[]) => xs.slice(0, 10).reduce((a, x) => a + x.confidence, 0) / 10;
    expect(avg(many)).toBeGreaterThan(avg(few));
  });
  it('reserva espacios de exploración marcados y diversifica', () => {
    const items = ranked(keysOf('thriller').slice(0, 10).map((k) => R(k, 9)), { limit: 18 });
    const exp = items.filter((i) => i.exploration);
    expect(exp.length).toBeGreaterThan(0);
    expect(exp.every((e) => e.explanation[0].startsWith('Exploración'))).toBe(true);
    const clusters = new Set(items.map((i) => byKey.get(i.key)!.cluster));
    expect(clusters.size).toBeGreaterThan(1);
  });
  it('el ranking cambia tras una nueva valoración', () => {
    const base = keysOf('thriller').slice(0, 4).map((k) => R(k, 8));
    const a = ranked(base).map((i) => i.key);
    const b = ranked([...base, ...keysOf('animation').slice(0, 3).map((k) => R(k, 10))]).map((i) => i.key);
    expect(a.join()).not.toBe(b.join());
  });
  it('maneja títulos con datos incompletos', () => {
    const incomplete: TitleMeta = { key: 'movie:1', type: 'movie', tmdbId: 1, title: 'Incompleto', genres: [], keywords: [], cast: [], directors: [], completeness: 'basic', missing: ['todo'], source: 'TMDB', fetchedAt: 0 };
    const m = new Map(metas); m.set(incomplete.key, incomplete);
    const profile = buildProfile([R(keysOf('thriller')[0], 9), R('movie:1', 7)], m);
    const items = rank({ profile, ratings: [], titles: m, candidates: ['movie:1', ...keysOf('comedy')], limit: 50 });
    expect(items.find((i) => i.key === 'movie:1')).toBeDefined();
  });
});

describe('Perfiles sintéticos: rankings coherentes y diferenciados', () => {
  it('cada perfil recibe sobre todo su tipo de contenido y los top-10 difieren', () => {
    const tops = USERS.map((u, i) => {
      const { ratings } = simulateHistory(u, catalog, 30, 100 + i);
      const r = ratings.map((x) => ({ ...x, profileId: 'p' }));
      const items = rank({ profile: buildProfile(r, metas), ratings: r, titles: metas, candidates: [...metas.keys()], limit: 10 });
      return { u, keys: items.map((x) => x.key) };
    });
    for (const { u, keys } of tops) {
      const liked = Object.entries(u.clusters).filter(([, v]) => v! >= 1).map(([c]) => c);
      const share = keys.filter((k) => liked.includes(byKey.get(k)!.cluster)).length / keys.length;
      expect(share, u.name).toBeGreaterThanOrEqual(0.5);
    }
    for (let i = 0; i < tops.length; i++) for (let j = i + 1; j < tops.length; j++) {
      const overlap = tops[i].keys.filter((k) => tops[j].keys.includes(k)).length;
      expect(overlap, `${tops[i].u.name} vs ${tops[j].u.name}`).toBeLessThanOrEqual(3);
    }
  });
});
