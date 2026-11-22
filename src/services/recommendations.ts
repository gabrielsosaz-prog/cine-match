import { PLATFORMS } from '../constants';
import { db } from '../db/db';
import { getSettings, listRatings } from '../db/repo';
import { featureLabel, describeFeatures } from '../engine/features';
import { hybridEngine, type RecommenderEngine } from '../engine/recommender';
import { friendlyError } from '../providers/errors';
import type { ProfileSettings, Rating, RecommendationRun, TitleKey, TitleMeta } from '../types';
import { matchesPlatforms } from './availability';
import { discoverCandidates, ensureFullTitles, getTitle, refreshAvailability } from './catalog';

let engine: RecommenderEngine = hybridEngine;
/** Permite sustituir el motor sin tocar el resto de la app */
export function setEngine(e: RecommenderEngine) { engine = e; }
export function getEngine() { return engine; }

const providerIds = (s: ProfileSettings) => PLATFORMS.filter((p) => s.platforms.includes(p.id)).flatMap((p) => p.tmdbIds);

async function titleMap(keys: TitleKey[]): Promise<Map<TitleKey, TitleMeta>> {
  const metas = await db.titles.bulkGet([...new Set(keys)]);
  return new Map(metas.filter((m): m is TitleMeta => Boolean(m)).map((m) => [m.key, m]));
}

/** Genera el conjunto de candidatos: relacionados de lo que te gustó + descubrimiento por plataforma. */
async function buildPool(ratings: Rating[], settings: ProfileSettings, titles: Map<TitleKey, TitleMeta>): Promise<{ pool: TitleKey[]; warning?: string }> {
  const opts = { language: settings.language, country: settings.country };
  const pool = new Set<TitleKey>();
  let warning: string | undefined;
  const profile = engine.buildProfile(ratings, titles, settings);
  const liked = profile.signals.filter((s) => s.value >= profile.mean + 0.5).sort((a, b) => b.value - a.value).slice(0, 15);
  for (const s of liked) for (const k of titles.get(s.key)?.related ?? []) pool.add(k);

  const topGenres = (type: 'movie' | 'tv') =>
    [...profile.features].filter(([f, a]) => f.startsWith('g:') && a.affinity > 0.2)
      .sort((a, b) => b[1].affinity - a[1].affinity).slice(0, 3).map(([f]) => Number(f.slice(2)))
      .filter((g) => [...titles.values()].some((t) => t.type === type && t.genres.some((x) => x.id === g)));
  const ids = providerIds(settings);
  const jobs: Promise<unknown>[] = [];
  for (const type of ['movie', 'tv'] as const) {
    const genres = topGenres(type);
    for (const g of genres) jobs.push(discoverCandidates({ ...opts, type, providerIds: ids, genres: [g], sort: 'vote_average.desc', minVotes: 300 }).then((r) => r.forEach((x) => pool.add(x.key))));
    jobs.push(discoverCandidates({ ...opts, type, providerIds: ids, sort: 'popularity.desc' }).then((r) => r.forEach((x) => pool.add(x.key))));
    jobs.push(discoverCandidates({ ...opts, type, providerIds: ids, sort: 'vote_average.desc', minVotes: 1500 }).then((r) => r.forEach((x) => pool.add(x.key))));
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  if (failed.length) warning = friendlyError(failed[0].reason);
  return { pool: [...pool], warning };
}

export interface RefreshOptions { trigger: string; rebuildPool?: boolean; extraKeys?: TitleKey[] }

/**
 * Aprendizaje continuo: recalcula perfil y ranking. Se llama después de cada valoración
 * (reutilizando candidatos en caché) y al abrir la app (reconstruye candidatos una vez por día).
 */
export async function refreshRecommendations(profileId: string, o: RefreshOptions): Promise<RecommendationRun> {
  const settings = await getSettings(profileId);
  const opts = { language: settings.language, country: settings.country };
  const ratings = await listRatings(profileId);
  const last = await latestRun(profileId);
  // Asegurar fichas completas del historial (rasgos para aprender)
  const histKeys = ratings.map((r) => r.key);
  let titles = await titleMap(histKeys);
  const needFull = histKeys.filter((k) => titles.get(k)?.completeness !== 'full');
  if (needFull.length) { try { await ensureFullTitles(needFull, opts, 25); } catch { /* se usan datos básicos */ } titles = await titleMap(histKeys); }

  let pool: TitleKey[] = last?.pool ?? [];
  let warning: string | undefined;
  const stalePool = !last || Date.now() - last.createdAt > 24 * 3600 * 1000 || last.country !== settings.country || pool.length < 20;
  if (o.rebuildPool || stalePool) {
    const built = await buildPool(ratings, settings, titles);
    if (built.pool.length) pool = built.pool;
    warning = built.warning;
  }
  for (const k of o.extraKeys ?? []) for (const r of titles.get(k)?.related ?? []) if (!pool.includes(r)) pool.push(r);
  // Rechazadas/abandonadas fuera; vistas y puntuadas se evalúan aparte para el filtro «vistos»
  const blocked = new Set(ratings.filter((r) => r.list === 'not_interested' || r.list === 'abandoned').map((r) => r.key));
  const watchedKeys = ratings.filter((r) => r.watched && !blocked.has(r.key)).map((r) => r.key);
  pool = [...new Set([...pool, ...ratings.filter((r) => !r.watched).map((r) => r.key)])].filter((k) => !blocked.has(k));

  // Preselección con datos disponibles y luego ficha completa sólo para los mejores
  let all = await titleMap([...histKeys, ...pool]);
  const profile = engine.buildProfile(ratings, all, settings);
  const pre = engine.rank({ profile, ratings, titles: all, candidates: pool.filter((k) => all.has(k)), settings, limit: 60 });
  const unknown = pool.filter((k) => !all.has(k)).slice(0, 25);
  const toFetch = [...pre.map((p) => p.key).filter((k) => all.get(k)?.completeness !== 'full'), ...unknown].slice(0, 45);
  if (toFetch.length) {
    try { await ensureFullTitles(toFetch, opts, 45); } catch (e) { warning ??= friendlyError(e); }
    all = await titleMap([...histKeys, ...pool]);
  }
  const keysForAvail = [...new Set([...pre.map((p) => p.key), ...unknown, ...watchedKeys])];
  try { await refreshAvailability(keysForAvail, settings.country, 40); } catch (e) { warning ??= friendlyError(e); }
  const snaps = await db.availability.bulkGet(keysForAvail.map((k) => `${k}|${settings.country}`));
  const availOk = new Set(keysForAvail.filter((_, i) => matchesPlatforms(snaps[i], settings.platforms, settings.includeUnconfirmed)));

  const profile2 = engine.buildProfile(ratings, all, settings);
  const seed = Math.floor(Date.now() / 86400000) + profileId.length;
  const unwatched = engine.rank({ profile: profile2, ratings, titles: all, candidates: [...availOk], settings, limit: 40, seed });
  const watchedSet = new Set(watchedKeys);
  const watchedRanked = engine.rank({ profile: profile2, ratings, titles: all, candidates: watchedKeys.filter((k) => availOk.has(k)), settings, limit: 40, seed, includeWatched: true })
    .filter((i) => watchedSet.has(i.key)).map((i) => ({ ...i, exploration: false }));
  const items = [...unwatched, ...watchedRanked];

  const run: RecommendationRun = {
    profileId, algorithmVersion: engine.version, createdAt: Date.now(), trigger: o.trigger,
    ratingsCount: profile2.ratedCount, country: settings.country, items, pool, warning,
  };
  run.id = await db.runs.add(run);
  // Mantener sólo los últimos 20 cálculos
  const old = await db.runs.where('profileId').equals(profileId).sortBy('createdAt');
  if (old.length > 20) await db.runs.bulkDelete(old.slice(0, old.length - 20).map((r) => r.id!));
  await recordSnapshot(profileId, profile2, all);
  await db.logs.add({ profileId, at: Date.now(), type: 'recs_updated', algorithmVersion: engine.version, detail: `${o.trigger}: ${items.length} recomendaciones` });
  return run;
}

export async function latestRun(profileId: string): Promise<RecommendationRun | undefined> {
  const runs = await db.runs.where('profileId').equals(profileId).sortBy('createdAt');
  return runs[runs.length - 1];
}

async function recordSnapshot(profileId: string, profile: ReturnType<RecommenderEngine['buildProfile']>, titles: Map<TitleKey, TitleMeta>) {
  const info = describeFeatures([...titles.values()]);
  const top = [...profile.features].filter(([f, a]) => (f.startsWith('g:') || f.startsWith('k:')) && a.count >= 2)
    .sort((a, b) => Math.abs(b[1].affinity) - Math.abs(a[1].affinity)).slice(0, 16)
    .map(([feature, a]) => ({ feature, label: featureLabel(feature, info), affinity: Math.round(a.affinity * 100) / 100 }));
  await db.snapshots.add({ profileId, at: Date.now(), algorithmVersion: engine.version, ratingsCount: profile.ratedCount, mean: profile.mean, topFeatures: top });
}

/** Ficha + títulos similares (TMDB relacionados, ordenados con el modelo de rasgos propio). */
export async function loadTitleWithRelated(key: TitleKey, settings: ProfileSettings) {
  const res = await getTitle(key, { language: settings.language, country: settings.country });
  return res;
}
