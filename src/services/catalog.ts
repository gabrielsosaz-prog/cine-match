import { db } from '../db/db';
import { getConfig } from '../db/repo';
import { METADATA_TTL_MS } from '../constants';
import { ProviderError } from '../providers/errors';
import { META_VERSION, TmdbClient, metaFromSearch, type SearchResult, type FetchLike } from '../providers/tmdb';
import type { AvailabilitySnapshot, MediaType, Named, TitleKey, TitleMeta } from '../types';
import { parseKey } from '../types';
import { diffAvailability, needsRefresh } from './availability';

let fetchOverride: FetchLike | undefined;
/** Para pruebas: inyectar un fetch simulado */
export function setFetch(f?: FetchLike) { fetchOverride = f; clientCache = undefined; }

let clientCache: { sig: string; client: TmdbClient } | undefined;
export async function getClient(): Promise<TmdbClient> {
  const cfg = await getConfig();
  const sig = `${cfg.tmdbToken ?? ''}|${cfg.proxyUrl ?? ''}`;
  if (!clientCache || clientCache.sig !== sig) {
    clientCache = { sig, client: new TmdbClient({ token: cfg.tmdbToken, proxyUrl: cfg.proxyUrl }, fetchOverride) };
  }
  return clientCache.client;
}

const genreCache = new Map<string, Map<number, string>>();
export async function genreNames(language: string): Promise<Map<number, string>> {
  if (genreCache.has(language)) return genreCache.get(language)!;
  const client = await getClient();
  const map = new Map<number, string>();
  try {
    const [m, t] = await Promise.all([client.genres('movie', language), client.genres('tv', language)]);
    for (const g of [...m, ...t]) map.set(g.id, g.name);
    genreCache.set(language, map);
  } catch { /* sin nombres: se muestran ids */ }
  return map;
}

export interface SearchHit extends SearchResult { genres: Named[] }

/** Búsqueda por nombre. Película y serie con el mismo nombre se devuelven como títulos distintos. */
export async function searchTitles(query: string, language: string): Promise<SearchHit[]> {
  const client = await getClient();
  const [results, names] = await Promise.all([client.search(query, language), genreNames(language)]);
  // Guardar metadata básica para poder mostrarlos offline, sin pisar fichas completas
  const existing = await db.titles.bulkGet(results.map((r) => r.key));
  const toPut = results.filter((_, i) => !existing[i]).map((r) => metaFromSearch(r, names));
  if (toPut.length) await db.titles.bulkPut(toPut);
  return results.map((r) => ({ ...r, genres: r.genreIds.map((id) => ({ id, name: names.get(id) ?? `Género ${id}` })) }));
}

export async function saveAvailability(snap: AvailabilitySnapshot) {
  const prev = await db.availability.get(snap.id);
  // Un error no borra la última verificación válida
  if (snap.status === 'error' && prev && prev.status === 'ok') return prev;
  const events = diffAvailability(prev, snap);
  await db.transaction('rw', db.availability, db.availabilityEvents, async () => {
    await db.availability.put(snap);
    if (events.length) await db.availabilityEvents.bulkAdd(events);
  });
  return snap;
}

/** Ficha completa con caché local. Si el proveedor falla, devuelve lo guardado. */
export async function getTitle(key: TitleKey, opts: { language: string; country: string; force?: boolean }): Promise<{ meta?: TitleMeta; availability?: AvailabilitySnapshot; error?: unknown }> {
  const cached = await db.titles.get(key);
  const avail = await db.availability.get(`${key}|${opts.country}`);
  const fresh = cached && cached.completeness === 'full' && (cached.metaVersion ?? 1) >= META_VERSION && Date.now() - cached.fetchedAt < METADATA_TTL_MS;
  if (fresh && !opts.force && !needsRefresh(avail)) return { meta: cached, availability: avail };
  try {
    const { type, id } = parseKey(key);
    const client = await getClient();
    const { meta, availability, related } = await client.details(type, id, opts.language, opts.country);
    await db.titles.put(meta);
    if (related.length) {
      const names = await genreNames(opts.language);
      const have = await db.titles.bulkGet(related.map((r) => r.key));
      const fresh = related.filter((_, i) => !have[i]).map((r) => metaFromSearch(r, names));
      if (fresh.length) await db.titles.bulkPut(fresh);
    }
    const saved = await saveAvailability(availability);
    return { meta, availability: saved };
  } catch (error) {
    return { meta: cached, availability: avail, error };
  }
}

export async function ensureFullTitles(keys: TitleKey[], opts: { language: string; country: string }, limit = 40): Promise<TitleMeta[]> {
  const out: TitleMeta[] = [];
  let failures = 0;
  await Promise.all(keys.slice(0, limit).map(async (k) => {
    const r = await getTitle(k, opts);
    if (r.error) failures++;
    if (r.meta) out.push(r.meta);
  }));
  if (failures && !out.length) throw new ProviderError('network', 'No se pudo obtener ningún título');
  return out;
}

/** Refresca disponibilidad vencida (actualización automática según capacidades del proveedor). */
export async function refreshAvailability(keys: TitleKey[], country: string, max = 30): Promise<{ checked: number; failed: number }> {
  const client = await getClient();
  if (!client.configured) return { checked: 0, failed: 0 };
  const snaps = await db.availability.bulkGet(keys.map((k) => `${k}|${country}`));
  const stale = keys.filter((_, i) => needsRefresh(snaps[i])).slice(0, max);
  let failed = 0;
  await Promise.all(stale.map(async (k) => {
    const { type, id } = parseKey(k);
    try {
      await saveAvailability(await client.availability(type, id, country));
    } catch (e) {
      failed++;
      await saveAvailability({ id: `${k}|${country}`, key: k, country, offers: [], status: 'error', source: 'TMDB / JustWatch', checkedAt: Date.now(), errorMessage: (e as Error).message });
    }
  }));
  return { checked: stale.length, failed };
}

export async function discoverCandidates(opts: { type: MediaType; language: string; country: string; providerIds: number[]; genres?: number[]; page?: number; sort?: string; minVotes?: number; extra?: Record<string, string | number | undefined> }): Promise<SearchResult[]> {
  const client = await getClient();
  const results = await client.discover(opts.type, {
    language: opts.language,
    watch_region: opts.country,
    with_watch_providers: opts.providerIds.length ? opts.providerIds.join('|') : undefined,
    with_watch_monetization_types: opts.providerIds.length ? 'flatrate|ads|free' : undefined,
    with_genres: opts.genres?.length ? opts.genres.join('|') : undefined,
    sort_by: opts.sort ?? 'popularity.desc',
    'vote_count.gte': opts.minVotes ?? 150,
    page: opts.page ?? 1,
    ...(opts.extra ?? {}),
  });
  const names = await genreNames(opts.language);
  const have = await db.titles.bulkGet(results.map((r) => r.key));
  const fresh = results.filter((_, i) => !have[i]).map((r) => metaFromSearch(r, names));
  if (fresh.length) await db.titles.bulkPut(fresh);
  return results;
}
