import { mapDetails } from '../../src/providers/tmdb';
import type { Rating, TitleKey, TitleMeta } from '../../src/types';
import { buildCatalog, fakeTmdbHandler, rng, type Cluster, type FakeTitle } from './fakeTmdb';

export async function syntheticMetas(perCluster = 25, seed = 42) {
  const catalog = buildCatalog(perCluster, seed).filter((t) => t.id !== 9000);
  const h = fakeTmdbHandler(catalog);
  const metas = new Map<TitleKey, TitleMeta>();
  const byKey = new Map<TitleKey, FakeTitle>();
  for (const t of catalog) {
    const { body } = await h(`https://api.themoviedb.org/3/${t.type}/${t.id}?language=es-MX`);
    const m = mapDetails(body, t.type, 'es-MX');
    metas.set(m.key, m); byKey.set(m.key, t);
  }
  return { catalog, metas, byKey };
}

export interface SyntheticUser { name: string; clusters: Partial<Record<Cluster, number>>; keywords?: Record<number, number> }

export const USERS: SyntheticUser[] = [
  { name: 'fan del suspenso', clusters: { thriller: 1.5, scifi: 0.6, horror: 0.3, drama: 0.2, comedy: -1, animation: -1.2, romance: -0.8 }, keywords: { 28: 0.8, 2: 0.5 } },
  { name: 'familia y comedia', clusters: { animation: 1.4, comedy: 1.2, romance: 0.4, action: 0.3, thriller: -0.8, horror: -1.5, drama: -0.3 }, keywords: { 8: 0.6 } },
  { name: 'drama y romance', clusters: { drama: 1.3, romance: 1.0, thriller: 0.2, action: -1, scifi: -0.6, horror: -1, animation: -0.3 }, keywords: { 32: 0.6 } },
  { name: 'acción y ciencia ficción', clusters: { action: 1.4, scifi: 1.2, thriller: 0.3, drama: -0.8, romance: -1.2 }, keywords: { 12: 0.8, 25: 0.5 } },
];

export function trueScore(u: SyntheticUser, t: FakeTitle, noise: () => number): number {
  const kw = t.keywords.reduce((a, k) => a + (u.keywords?.[k] ?? 0), 0);
  const s = 6 + 1.6 * (u.clusters[t.cluster] ?? 0) + kw + 0.25 * (t.vote - 7) + noise();
  return Math.max(1, Math.min(10, Math.round(s)));
}

/** Simula un historial: el usuario ve sobre todo lo que le atrae, puntúa y descarta. */
export function simulateHistory(u: SyntheticUser, catalog: FakeTitle[], n: number, seed: number) {
  const r = rng(seed);
  const gauss = () => (r() + r() + r() - 1.5) * 0.9;
  const scores = new Map<TitleKey, number>();
  for (const t of catalog) scores.set(`${t.type}:${t.id}` as TitleKey, trueScore(u, t, gauss));
  const shuffled = [...catalog].sort(() => r() - 0.5);
  const watched = shuffled.filter((t) => r() < 0.35 + 0.25 * Math.max(-1, Math.min(1, u.clusters[t.cluster] ?? 0))).slice(0, n);
  const ratings: Rating[] = watched.map((t) => {
    const key = `${t.type}:${t.id}` as TitleKey;
    const score = scores.get(key)!;
    const abandoned = score <= 3 && r() < 0.4;
    const dims = r() < 0.6 ? { story: Math.max(1, Math.min(10, score + Math.round(gauss()))), suspense: t.cluster === 'thriller' ? Math.min(10, score + 1) : Math.max(1, score - 1) } : {};
    return { id: `u|${key}`, profileId: 'u', key, watched: !abandoned, list: abandoned ? 'abandoned' : undefined, overall: score, dimensions: dims, createdAt: 0, updatedAt: 0, schema: 2 } as Rating;
  });
  return { ratings, scores };
}
