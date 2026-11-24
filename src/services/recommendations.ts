import { PLATFORMS } from '../constants';
import { db } from '../db/db';
import { getSettings, listRatings } from '../db/repo';
import { featureLabel, describeFeatures } from '../engine/features';
import { hybridEngine, setDefaultNarrative, type RecommenderEngine } from '../engine/recommender';
import { personalEngine } from '../engine/personalEngine';
import { getNarrativeIndex, loadNarrativeIndex, metaFromCatalog } from './narrativeCatalog';
import type { NarrativeIndex } from '../engine/narrative';
import { friendlyError } from '../providers/errors';
import { META_VERSION } from '../providers/tmdb';
import type { EngineChoice, MediaType, PlatformId, ProfileSettings, Rating, RecommendationItem, RecommendationRun, TitleKey, TitleMeta } from '../types';
import { peopleSets, type PeopleSets } from './peopleFilter';
import { countriesOf, dataGaps, diagnose, keywordNames, matchesContent, matchesWatched, smartNeeds, type Candidate, type DataGaps, type RankFilters } from './filters';
import { prefAdjust, reorderByPrefs } from './preferences';
import { loadAudienceData } from './audience';
import { loadWestern } from './regions';
import { matchesPlatforms } from './availability';
import { discoverCandidates, ensureFullTitles, genreNames, getTitle, personFilmography, refreshAvailability } from './catalog';
import type { UserProfile } from '../engine/profile';

/** v3.5: motores que se pueden elegir en Ajustes («Motor de recomendaciones»). v3.4 es el predeterminado. */
export const ENGINES: Record<EngineChoice, RecommenderEngine> = { 'v3.4': hybridEngine, 'v3.5': personalEngine };
export const ENGINE_LABEL: Record<string, EngineChoice> = { [hybridEngine.version]: 'v3.4', [personalEngine.version]: 'v3.5' };
let override: RecommenderEngine | undefined;
/** Permite sustituir el motor en pruebas sin tocar el resto de la app (tiene prioridad sobre la elección del perfil) */
export function setEngine(e: RecommenderEngine | undefined) { override = e; }
/** Motor elegido por el perfil (v3.4 si no eligió). */
export function engineFor(settings?: Partial<ProfileSettings>): RecommenderEngine { return override ?? ENGINES[settings?.engine ?? 'v3.4'] ?? hybridEngine; }
export function getEngine() { return override ?? hybridEngine; }

const providerIds = (s: ProfileSettings) => PLATFORMS.filter((p) => s.platforms.includes(p.id)).flatMap((p) => p.tmdbIds);

async function titleMap(keys: TitleKey[]): Promise<Map<TitleKey, TitleMeta>> {
  const metas = await db.titles.bulkGet([...new Set(keys)]);
  return new Map(metas.filter((m): m is TitleMeta => Boolean(m)).map((m) => [m.key, m]));
}

/**
 * v3.0 — Actores como fuente de candidatos. Antes, las películas de un actor que te gustó sólo podían aparecer si
 * TMDB las listaba como «relacionadas» con algo que puntuaste (casi nunca: p. ej. Volver al futuro → otras de
 * Michael J. Fox). Ahora, para los actores con afinidad positiva y evidencia repetida (≥ 2 títulos), se consulta su
 * filmografía en TMDB (por id único) y se suman sus títulos de ficción más votados. Con tope por actor y por
 * cantidad de actores para que no monopolicen; el ranking además limita títulos por actor en el top 10.
 */
export const ACTOR_DISCOVERY = { maxActors: 4, perActor: 8, minAffinity: 0.2, minCount: 2, minVotes: 80 };
export async function actorCandidates(profile: UserProfile, settings: ProfileSettings): Promise<{ keys: TitleKey[]; actors: { id: number; name: string; added: number }[]; warning?: string }> {
  const top = [...profile.actors.values()].filter((a) => a.affinity >= ACTOR_DISCOVERY.minAffinity && a.count >= ACTOR_DISCOVERY.minCount)
    .sort((a, b) => b.affinity * Math.log(1 + b.count) - a.affinity * Math.log(1 + a.count)).slice(0, ACTOR_DISCOVERY.maxActors);
  const keys: TitleKey[] = [];
  const actors: { id: number; name: string; added: number }[] = [];
  let warning: string | undefined;
  for (const a of top) {
    try {
      const credits = await personFilmography(a.id, settings.language, { role: 'cast', fiction: true });
      // Papeles relevantes primero (orden en los créditos / episodios), luego los más votados
      const pick = credits.filter((c) => (c.voteCount ?? 0) >= ACTOR_DISCOVERY.minVotes)
        .map((c) => ({ c, s: (c.voteCount ?? 0) * (c.order === undefined || c.order <= 4 || (c.episodes ?? 0) >= 8 ? 1 : 0.25) }))
        .sort((x, y) => y.s - x.s).map((x) => x.c.key);
      const uniq = [...new Set(pick)].slice(0, ACTOR_DISCOVERY.perActor);
      keys.push(...uniq);
      actors.push({ id: a.id, name: a.name, added: uniq.length });
    } catch (e) { warning ??= friendlyError(e); }
  }
  return { keys: [...new Set(keys)], actors, warning };
}

/** Genera el conjunto de candidatos: relacionados de lo que te gustó + descubrimiento por plataforma + actores. */
async function buildPool(ratings: Rating[], settings: ProfileSettings, titles: Map<TitleKey, TitleMeta>, nidx?: NarrativeIndex): Promise<{ pool: TitleKey[]; warning?: string; priority: TitleKey[] }> {
  const opts = { language: settings.language, country: settings.country };
  const pool = new Set<TitleKey>();
  let warning: string | undefined;
  const profile = engineFor(settings).buildProfile(ratings, titles, settings);
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
  const act = await actorCandidates(profile, settings);
  for (const k of act.keys) pool.add(k);
  warning ??= act.warning;
  // v3.1: vecinos narrativos (catálogo precalculado) de lo que más te gustó; no depende de la popularidad
  const narrKeys = nidx ? narrativeNeighbors(nidx, liked.map((s) => s.key), settings, 90) : [];
  for (const k of narrKeys) pool.add(k);
  if (narrKeys.length && nidx) {
    const names = await genreNames(settings.language).catch(() => new Map<number, string>());
    const have = await db.titles.bulkGet(narrKeys);
    const add = narrKeys.filter((_, i) => !have[i]).map((k) => metaFromCatalog(nidx, k, names)).filter((m): m is TitleMeta => Boolean(m));
    if (add.length) await db.titles.bulkPut(add).catch(() => undefined);
  }
  return { pool: [...pool], warning, priority: [...act.keys, ...narrKeys.slice(0, 30)] };
}

/**
 * Vecinos semánticos en el catálogo de los títulos que más te gustaron. La disponibilidad del catálogo es sólo una
 * pista (de la fecha de construcción): la real se verifica después con TMDB.
 */
export function narrativeNeighbors(idx: NarrativeIndex, liked: TitleKey[], settings: ProfileSettings, max: number): TitleKey[] {
  if (!idx.emb) return [];
  const mine = new Set(PLATFORMS.filter((p) => settings.platforms.includes(p.id)).flatMap((p) => p.tmdbIds));
  const rows = liked.map((k) => idx.get(k)?.row ?? -1).filter((r) => r >= 0);
  if (!rows.length) return [];
  const skip = new Set(liked);
  const best = new Map<TitleKey, number>();
  for (const r of rows.slice(0, 15)) {
    const top: [TitleKey, number][] = [];
    for (const c of idx.titles) {
      if (c.row < 0 || skip.has(c.key) || (mine.size && c.provAR.length && !c.provAR.some((p) => mine.has(p)))) continue;
      top.push([c.key, idx.cosRows(r, c.row)]);
    }
    top.sort((a, b) => b[1] - a[1]);
    for (const [k, v] of top.slice(0, 12)) best.set(k, Math.max(best.get(k) ?? 0, v));
  }
  return [...best].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
}

/** Búsqueda adicional en TMDB para los filtros avanzados (p. ej. «series de ciencia ficción desde 2015 en Netflix»). */
export interface DiscoverHints { types: MediaType[]; genres: number[]; excludeGenres: number[]; yearMin?: number; yearMax?: number; platforms: PlatformId[]; runtimeMin?: number; runtimeMax?: number; countries?: string[] }
export interface RefreshOptions { trigger: string; rebuildPool?: boolean; extraKeys?: TitleKey[]; discover?: DiscoverHints; actorDiscovery?: boolean }

async function discoverWithHints(h: DiscoverHints, settings: ProfileSettings, pages = 1): Promise<TitleKey[]> {
  const plats = h.platforms.length ? h.platforms : settings.platforms;
  const ids = PLATFORMS.filter((p) => plats.includes(p.id)).flatMap((p) => p.tmdbIds);
  const out: TitleKey[] = [];
  const types = h.types.length ? h.types : (['movie', 'tv'] as MediaType[]);
  const pageList = Array.from({ length: Math.max(1, Math.min(3, pages)) }, (_, i) => i + 1);
  await Promise.all(types.flatMap((type) => ['vote_average.desc', 'popularity.desc'].flatMap((sort) => pageList.map(async (page) => {
    const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    const r = await discoverCandidates({
      type, language: settings.language, country: settings.country, providerIds: ids, genres: h.genres, sort, minVotes: sort === 'vote_average.desc' ? 200 : 50, page,
      extra: {
        [`${dateField}.gte`]: h.yearMin ? `${h.yearMin}-01-01` : undefined,
        [`${dateField}.lte`]: h.yearMax ? `${h.yearMax}-12-31` : undefined,
        without_genres: h.excludeGenres.length ? h.excludeGenres.join(',') : undefined,
        'with_runtime.gte': h.runtimeMin, 'with_runtime.lte': h.runtimeMax,
        with_origin_country: h.countries?.length ? h.countries.join('|') : undefined,
      },
    });
    out.push(...r.map((x) => x.key));
  }))));
  return [...new Set(out)];
}

/**
 * Aprendizaje continuo: recalcula perfil y ranking. Se llama después de cada valoración
 * (reutilizando candidatos en caché) y al abrir la app (reconstruye candidatos una vez por día).
 */
/** Catálogo narrativo con tope de espera: si no llega a tiempo, el ranking sigue sin el canal semántico. */
export async function narrativeReady(ms = 6000): Promise<NarrativeIndex | undefined> {
  const idx = await Promise.race([loadNarrativeIndex(), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  if (idx) setDefaultNarrative(idx);
  return idx;
}

export async function refreshRecommendations(profileId: string, o: RefreshOptions): Promise<RecommendationRun> {
  const nidx = await narrativeReady();
  const settings = await getSettings(profileId);
  // v3.5: el motor elegido en Ajustes (v3.4 por defecto); el ranking queda marcado con su versión
  const engine = engineFor(settings);
  const opts = { language: settings.language, country: settings.country };
  const ratings = await listRatings(profileId);
  const last = await latestRun(profileId);
  // Asegurar fichas completas del historial (rasgos para aprender)
  const histKeys = ratings.map((r) => r.key);
  let titles = await titleMap(histKeys);
  const needFull = histKeys.filter((k) => titles.get(k)?.completeness !== 'full' || (titles.get(k)?.metaVersion ?? 1) < META_VERSION);
  if (needFull.length) { try { await ensureFullTitles(needFull, opts, 25); } catch { /* se usan datos básicos */ } titles = await titleMap(histKeys); }

  let pool: TitleKey[] = last?.pool ?? [];
  let warning: string | undefined;
  let priority: TitleKey[] = [];
  const stalePool = !last || Date.now() - last.createdAt > 24 * 3600 * 1000 || last.country !== settings.country || pool.length < 20;
  if (o.rebuildPool || stalePool) {
    const built = await buildPool(ratings, settings, titles, nidx);
    if (built.pool.length) pool = [...new Set([...built.pool, ...(last?.country === settings.country ? (last?.pool ?? []).slice(0, 150) : [])])];
    warning = built.warning;
    priority = built.priority;
  } else if (o.actorDiscovery) {
    const act = await actorCandidates(engine.buildProfile(ratings, titles, settings), settings);
    priority = act.keys;
    pool = [...new Set([...pool, ...act.keys])];
  }
  for (const k of o.extraKeys ?? []) for (const r of titles.get(k)?.related ?? []) if (!pool.includes(r)) pool.push(r);
  let hinted: TitleKey[] = [];
  if (o.discover) {
    try { hinted = await discoverWithHints(o.discover, settings); } catch (e) { warning ??= friendlyError(e); }
    pool = [...new Set([...hinted, ...pool])];
  }
  // Descartadas y abandonadas fuera; vistas y puntuadas se evalúan aparte para el filtro «vistos»
  const blocked = new Set(ratings.filter((r) => r.notInterested || r.list === 'abandoned').map((r) => r.key));
  const watchedKeys = ratings.filter((r) => r.watched && !blocked.has(r.key)).map((r) => r.key);
  pool = [...new Set([...pool, ...ratings.filter((r) => !r.watched).map((r) => r.key)])].filter((k) => !blocked.has(k));

  // Preselección con datos disponibles y luego ficha completa sólo para los mejores
  let all = await titleMap([...histKeys, ...pool]);
  const profile = engine.buildProfile(ratings, all, settings);
  // v3.0: preselección más amplia (120) para que los filtros tengan dónde elegir sin perder títulos
  // v3.5: la preselección (qué fichas completar y qué disponibilidad consultar) es la misma con cualquier motor elegido:
  // une los 120 mejores de cada motor. Así cambiar de motor no cambia el conjunto de candidatos, sólo el orden.
  const preIn = { profile, ratings, titles: all, candidates: pool.filter((k) => all.has(k)), settings, limit: 120 };
  const pre = override ? override.rank(preIn) : [...new Map([...hybridEngine.rank(preIn), ...personalEngine.rank(preIn)].map((p) => [p.key, p])).values()];
  const unknown = pool.filter((k) => !all.has(k)).slice(0, 25);
  const notFull = (k: TitleKey) => all.get(k)?.completeness !== 'full' || (all.get(k)?.metaVersion ?? 1) < META_VERSION;
  const toFetch = [...new Set([...priority.filter(notFull).slice(0, 16), ...hinted.filter(notFull).slice(0, 20), ...pre.map((p) => p.key).filter(notFull), ...unknown])].slice(0, 80);
  if (toFetch.length) {
    try { await ensureFullTitles(toFetch, opts, 80); } catch (e) { warning ??= friendlyError(e); }
    all = await titleMap([...histKeys, ...pool]);
  }
  const keysForAvail = [...new Set([...priority, ...hinted.slice(0, 40), ...pre.map((p) => p.key), ...unknown, ...watchedKeys])];
  try { await refreshAvailability(keysForAvail, settings.country, 100); } catch (e) { warning ??= friendlyError(e); }
  const snaps = await db.availability.bulkGet(keysForAvail.map((k) => `${k}|${settings.country}`));
  const availOk = new Set(keysForAvail.filter((_, i) => matchesPlatforms(snaps[i], settings.platforms, settings.includeUnconfirmed)));

  const profile2 = engine.buildProfile(ratings, all, settings);
  await yieldToUi(); // v3.5 es más pesado: deja pintar la interfaz antes de cada ranking largo
  const seed = Math.floor(Date.now() / 86400000) + profileId.length;
  // v3.0: se guarda un ranking largo (se muestra de a 10 con «Ver más»), no sólo los primeros 60
  const unwatched = engine.rank({ profile: profile2, ratings, titles: all, candidates: [...availOk], settings, limit: 200, seed });
  await yieldToUi();
  const watchedSet = new Set(watchedKeys);
  const watchedRanked = engine.rank({ profile: profile2, ratings, titles: all, candidates: watchedKeys.filter((k) => availOk.has(k)), settings, limit: 80, seed, includeWatched: true })
    .filter((i) => watchedSet.has(i.key)).map((i) => ({ ...i, exploration: false }));
  const items = [...unwatched, ...watchedRanked];

  const run: RecommendationRun = {
    profileId, algorithmVersion: engine.version, createdAt: Date.now(), trigger: o.trigger,
    ratingsCount: profile2.ratedCount, country: settings.country, items, pool, warning,
    eligible: [...availOk].filter((k) => !blocked.has(k)),
  };
  run.id = await db.runs.add(run);
  // Mantener sólo los últimos 5 cálculos (cada uno guarda el conjunto de candidatos); se borran por clave
  const ids = await db.runs.where('profileId').equals(profileId).primaryKeys();
  if (ids.length > 5) await db.runs.bulkDelete(ids.slice(0, ids.length - 5));
  await recordSnapshot(profileId, profile2, all, engine.version);
  await db.logs.add({ profileId, at: Date.now(), type: 'recs_updated', algorithmVersion: engine.version, detail: `${o.trigger}: ${items.length} recomendaciones` });
  return run;
}

/** Último ranking: lectura directa por índice (no carga todos los cálculos guardados). */
export async function latestRun(profileId: string): Promise<RecommendationRun | undefined> {
  return db.runs.where('profileId').equals(profileId).last();
}
/**
 * v3.5: último ranking calculado con el motor elegido y después del último cambio de motor. Así un ranking de un
 * motor nunca se muestra como si fuera del otro, y al volver a un motor se recalcula (caché invalidada).
 */
export async function currentRun(profileId: string, settings?: Partial<ProfileSettings>): Promise<RecommendationRun | undefined> {
  const s = settings ?? await getSettings(profileId);
  const version = engineFor(s).version, since = s.engineChangedAt ?? 0;
  const runs = await db.runs.where('profileId').equals(profileId).reverse().toArray();
  return runs.find((r) => r.algorithmVersion === version && r.createdAt >= since);
}
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

async function recordSnapshot(profileId: string, profile: ReturnType<RecommenderEngine['buildProfile']>, titles: Map<TitleKey, TitleMeta>, version: string) {
  const info = describeFeatures([...titles.values()]);
  const top = [...profile.features].filter(([f, a]) => (f.startsWith('g:') || f.startsWith('k:')) && a.count >= 2)
    .sort((a, b) => Math.abs(b[1].affinity) - Math.abs(a[1].affinity)).slice(0, 16)
    .map(([feature, a]) => ({ feature, label: featureLabel(feature, info), affinity: Math.round(a.affinity * 100) / 100 }));
  await db.snapshots.add({ profileId, at: Date.now(), algorithmVersion: version, ratingsCount: profile.ratedCount, mean: profile.mean, topFeatures: top });
}

/** Ficha + títulos similares (TMDB relacionados, ordenados con el modelo de rasgos propio). */
export async function loadTitleWithRelated(key: TitleKey, settings: ProfileSettings) {
  const res = await getTitle(key, { language: settings.language, country: settings.country });
  return res;
}

export function hintsFromFilters(f: RankFilters): DiscoverHints {
  return { types: f.types, genres: f.includeGenres, excludeGenres: f.excludeGenres, yearMin: f.yearMin, yearMax: f.yearMax, platforms: f.platforms, runtimeMin: f.runtimeMin, runtimeMax: f.runtimeMax, countries: f.includeCountries };
}

/** Por debajo de esta cantidad de candidatos filtrados se busca automáticamente en TMDB */
export const FEW_CANDIDATES = 20;
const discoverCache = new Map<string, { at: number; keys: TitleKey[] }>();

export interface FilteredResult {
  /** v3.2: títulos de cada persona incluida y total que cumple la inclusión (antes de los demás filtros) */
  perPerson?: { person: { id: number; name: string }; count: number }[];
  peopleTotal?: number;
  items: RecommendationItem[];
  candidates: number;
  diagnostics: { id: string; count: number }[];
  /** títulos sumados por búsqueda automática en TMDB para estos filtros */
  discovered: number;
  /** v3.3: candidatos sin el dato que pide un filtro (para no confundir «sin datos» con «no coincide») */
  dataGaps?: DataGaps;
  /** títulos de la persona elegida que no están en tus plataformas (no se muestran) */
  outsidePlatforms?: number;
  warning?: string;
}

/**
 * Ranking con filtros avanzados. v3.0 separa:
 *  1. DESCUBRIMIENTO: el conjunto de candidatos (ranking guardado + elegibles; si quedan pocos, búsqueda en TMDB
 *     con los mismos filtros, respetando paginación y límites; si se eligió una persona, su filmografía);
 *  2. FILTRADO: los filtros sólo seleccionan, nunca recortan por posición;
 *  3. AFINIDAD: el mismo motor y el mismo perfil puntúan a todos los que pasan;
 *  4. ORDEN: se ordena TODO el subconjunto (sin tope), así un título que cumple el filtro nunca desaparece por
 *     cambiar de vista. La pantalla lo muestra de a 10.
 * No guarda nada ni cambia lo aprendido: es una vista temporal.
 */
export async function rankWithFilters(profileId: string, run: RecommendationRun, f: RankFilters, opts: { discover?: boolean; anyPlatform?: boolean } = {}): Promise<FilteredResult> {
  loadWestern(profileId);
  const settings = await getSettings(profileId);
  const engine = engineFor(settings);
  const ratings = await listRatings(profileId);
  const byKey = new Map(ratings.map((r) => [r.key, r]));
  let warning: string | undefined;
  let base: TitleKey[];
  let outsidePlatforms: number | undefined;
  const lowEvidence = new Set<TitleKey>();
  let people: PeopleSets | undefined;
  try { people = await peopleSets(f, settings.language); } catch (e) { warning = friendlyError(e); }
  if (people?.allow) {
    // Personas incluidas: candidatos = sus filmografías (no sólo el ranking), combinables con el resto de los filtros
    const credits = [...people.allow];
    const metas0 = await titleMap(credits);
    credits.sort((a, b) => (metas0.get(b)?.voteCount ?? 0) - (metas0.get(a)?.voteCount ?? 0));
    try { await refreshAvailability(credits, settings.country, 80); } catch (e) { warning ??= friendlyError(e); }
    if (f.anyPlatform || opts.anyPlatform) base = credits;
    else {
      const snaps0 = await db.availability.bulkGet(credits.map((k) => `${k}|${settings.country}`));
      base = credits.filter((_, i) => matchesPlatforms(snaps0[i], settings.platforms, settings.includeUnconfirmed));
      outsidePlatforms = credits.length - base.length;
    }
  } else {
    base = [...new Set([...(run.eligible ?? []), ...run.items.map((i) => i.key)])];
  }
  if (people) base = base.filter((k) => !people!.deny.has(k));
  let all = await titleMap([...ratings.map((r) => r.key), ...base]);
  // Filtro por país: las listas de TMDB (descubrir, tendencias) no traen el país de las películas. Antes de filtrar
  // se completa con el catálogo narrativo y, si falta, con la ficha completa (hasta 60 por vez). Lo que siga sin
  // datos se trata según la regla explícita (no pasa «incluir», sí pasa «excluir»).
  const needs = smartNeeds(f);
  if (needs.audience) await loadAudienceData();
  const fillCountries = async (keys: TitleKey[]) => {
    if (!needs.countries && !needs.keywords) return;
    const idx = getNarrativeIndex() ?? (await narrativeReady(5000));
    const missing: TitleKey[] = [];
    for (const k of keys) {
      const m = all.get(k);
      if (!m) continue;
      // v3.3: público y temas necesitan palabras clave (de la ficha o del catálogo); si no hay, ficha completa
      if (needs.keywords && !m.keywords.length && m.completeness !== 'full' && !idx?.get(k)?.kw.length) { missing.push(k); continue; }
      if (!needs.countries || countriesOf(m).length) continue;
      const c = idx?.get(k)?.countries;
      if (c?.length) all.set(k, { ...m, productionCountries: c });
      else missing.push(k);
    }
    if (missing.length) {
      try { await ensureFullTitles(missing, { language: settings.language, country: settings.country }, people?.allow ? 100 : 60); } catch (e) { warning ??= friendlyError(e); }
      const fresh = await titleMap(missing.slice(0, 100));
      for (const [k, m] of fresh) if (countriesOf(m).length) all.set(k, m);
    }
  };
  await fillCountries(base);
  const candidatesOf = async (keys: TitleKey[]) => {
    const snaps = await db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`));
    return keys.map((k, i) => ({ meta: all.get(k)!, snap: snaps[i], rating: byKey.get(k) }) as Candidate)
      .filter((c) => c.meta && !c.rating?.notInterested && c.rating?.list !== 'abandoned');
  };
  let cands = await candidatesOf(base);
  let pass = cands.filter((c) => matchesContent(c, f) && matchesWatched(c, f));
  let discovered = 0;
  if (!people?.allow && pass.length < FEW_CANDIDATES && opts.discover !== false) {
    // Pocos candidatos locales (p. ej. sólo Terror sin historial de terror): buscar en TMDB con estos filtros
    const ck = `${settings.country}|${settings.platforms.join(',')}|${JSON.stringify(hintsFromFilters(f))}`;
    let found = discoverCache.get(ck);
    if (!found || Date.now() - found.at > 3600 * 1000) {
      try { found = { at: Date.now(), keys: await discoverWithHints(hintsFromFilters(f), settings, 2) }; discoverCache.set(ck, found); }
      catch (e) { warning ??= friendlyError(e); }
    }
    const extra = (found?.keys ?? []).filter((k) => !base.includes(k) && !people?.deny.has(k));
    if (extra.length) {
      try { await refreshAvailability(extra, settings.country, 60); } catch (e) { warning ??= friendlyError(e); }
      base = [...base, ...extra];
      all = await titleMap([...ratings.map((r) => r.key), ...base]);
      await fillCountries(base);
      cands = await candidatesOf(base);
      const okAvail = new Set(cands.filter((c) => extra.includes(c.meta.key) && matchesPlatforms(c.snap, settings.platforms, settings.includeUnconfirmed)).map((c) => c.meta.key));
      cands = cands.filter((c) => !extra.includes(c.meta.key) || okAvail.has(c.meta.key));
      pass = cands.filter((c) => matchesContent(c, f) && matchesWatched(c, f));
      for (const k of okAvail) lowEvidence.add(k);
      discovered = pass.filter((c) => okAvail.has(c.meta.key)).length;
    }
  }
  const profile = engine.buildProfile(ratings, all, settings);
  const seed = Math.floor(Date.now() / 86400000) + profileId.length;
  let items = engine.rank({ profile, ratings, titles: all, candidates: pass.map((c) => c.meta.key), settings, limit: pass.length, seed, includeWatched: f.watched !== 'unwatched', lowEvidence });
  if (f.minScore) items = items.filter((i) => i.score >= f.minScore!);
  // v3.4: preferencias flexibles del texto: reordenan con evidencia explícita, nunca quitan títulos
  const prefs = f.text?.prefs?.filter((p) => p.applied);
  if (prefs?.length) {
    items = reorderByPrefs(items.map((it, i) => ({ ...it, engineRank: i + 1, prefs: prefAdjust(prefs, all.get(it.key)!, keywordNames(all.get(it.key)!)) })), (it) => it.prefs!.delta);
  }
  items = items.map((it, i) => ({ ...it, rank: i + 1 }));
  let diagnostics: { id: string; count: number }[] = [];
  if (!items.length) {
    const scores = new Map(engine.rank({ profile, ratings, titles: all, candidates: cands.map((c) => c.meta.key), settings, limit: 400, includeWatched: true }).map((i) => [i.key, i.score]));
    diagnostics = diagnose(cands.map((c) => ({ ...c, score: scores.get(c.meta.key) })), f);
  }
  return { items, candidates: pass.length, diagnostics, discovered, outsidePlatforms, warning, perPerson: people?.perPerson, peopleTotal: people?.allow?.size, dataGaps: dataGaps(cands, f) };
}

/**
 * Estimación «Para vos» de títulos puntuales (ficha, Similares). Con `holdOut`, el título se estima SIN su propia
 * valoración (así la estimación de algo que ya puntuaste no es un eco de tu nota).
 */
export async function predictFor(profileId: string, keys: TitleKey[], o: { holdOut?: boolean } = {}): Promise<Map<TitleKey, RecommendationItem>> {
  const settings = await getSettings(profileId);
  // La estimación puntual es la nota de v3.4 con cualquier motor (v3.5 sólo cambia el orden de «Para vos»)
  const engine = getEngine();
  const ratings = await listRatings(profileId);
  const target = new Set(keys);
  const train = o.holdOut ? ratings.filter((r) => !target.has(r.key)) : ratings;
  const all = await titleMap([...ratings.map((r) => r.key), ...keys]);
  const profile = engine.buildProfile(train, all, settings);
  // Para estimar no se excluyen vistos/descartados: la exclusión es del ranking, no de la estimación
  const neutral = train.filter((r) => !target.has(r.key));
  const items = engine.rank({ profile, ratings: neutral, titles: all, candidates: keys.filter((k) => all.has(k)), settings, limit: keys.length, includeWatched: true });
  return new Map(items.map((i) => [i.key, i]));
}
