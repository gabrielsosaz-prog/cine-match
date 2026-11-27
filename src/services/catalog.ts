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

/**
 * Ficha completa SÓLO para mostrar (sinopsis, dirección, países): usa la caché si ya está completa y, si no, la pide
 * a TMDB sin guardarla. Así mirar una lista no cambia los datos con que se calcula el próximo ranking.
 */
export async function peekFullTitle(key: TitleKey, opts: { language: string; country: string }): Promise<TitleMeta | undefined> {
  const cached = await db.titles.get(key);
  if (cached && cached.completeness === 'full' && (cached.metaVersion ?? 1) >= META_VERSION) return cached;
  const { type, id } = parseKey(key);
  const client = await getClient();
  return (await client.details(type, id, opts.language, opts.country)).meta;
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

// ───────────── v3.0: personas (actores, dirección) ─────────────
export type { PersonHit, PersonCredit } from '../providers/tmdb';
import type { PersonCredit, PersonHit } from '../providers/tmdb';

/** v3.2: búsqueda de personas tolerante a iniciales, tildes y errores menores (ver services/peopleSearch.ts). */
export async function searchPeople(query: string, language: string): Promise<RankedPerson[]> {
  const client = await getClient();
  return (await tolerantPeopleSearch(query, (q) => client.searchPerson(q, language))).people;
}

/** Créditos que no son actuaciones de ficción: talk shows, noticieros, galas, apariciones como sí mismo. */
const NON_FICTION_GENRES = new Set([10767, 10763, 99]);
const isSelf = (c: PersonCredit) => /\b(self|himself|herself|themselves|host|narrator \(voice\)|archive footage)\b/i.test(c.character ?? '');

const creditCache = new Map<string, { at: number; credits: PersonCredit[] }>();
const CREDIT_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Filmografía de una persona por id único (desambigua homónimos). Guarda metadata básica de cada título para
 * poder ordenarlos y mostrarlos. Se cachea 7 días en memoria y en el dispositivo.
 */
export async function personFilmography(personId: number, language: string, opts: { role?: 'cast' | 'crew' | 'any'; fiction?: boolean } = {}): Promise<PersonCredit[]> {
  const ck = `${personId}|${language}`;
  let credits = creditCache.get(ck);
  if (!credits) {
    try { const raw = localStorage.getItem(`cine-match:credits:${ck}`); if (raw) { const v = JSON.parse(raw); if (Date.now() - v.at < CREDIT_TTL_MS) credits = v; } } catch { /* sin almacenamiento */ }
  }
  if (!credits || Date.now() - credits.at > CREDIT_TTL_MS) {
    const client = await getClient();
    credits = { at: Date.now(), credits: await client.personCredits(personId, language) };
    creditCache.set(ck, credits);
    try { localStorage.setItem(`cine-match:credits:${ck}`, JSON.stringify(credits)); } catch { /* cuota llena: queda en memoria */ }
  }
  // v3.2: aunque la filmografía venga de la caché, sus títulos tienen que existir en la base (si no, no se muestran)
  const uniq = [...new Map(credits.credits.map((c) => [c.key, c])).values()];
  const have = await db.titles.bulkGet(uniq.map((c) => c.key));
  if (have.some((h) => !h)) {
    const names = await genreNames(language);
    const fresh = uniq.filter((_, i) => !have[i]).map((r) => metaFromSearch(r, names));
    await db.titles.bulkPut(fresh);
  }
  const role = opts.role ?? 'any';
  return credits.credits.filter((c) => (role === 'any' || c.kind === role) && (!opts.fiction || (!isSelf(c) && !c.genreIds.some((g) => NON_FICTION_GENRES.has(g)))));
}

// ───────────── v3.1: búsqueda unificada y personas ─────────────
import { normName, tolerantPeopleSearch, type RankedPerson } from './peopleSearch';
import type { PersonInfo } from '../providers/tmdb';
export type { PersonInfo };
const deaccent = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Variantes razonables de escritura: sin tildes, espacios normalizados, sin puntos de iniciales. */
export function queryVariants(q: string): string[] {
  const base = q.trim().replace(/\s+/g, ' ');
  return [...new Set([base, deaccent(base), base.replace(/\./g, '').replace(/\s+/g, ' '), deaccent(base).replace(/(.)\1+/g, '$1')])].filter((x) => x.length >= 2);
}

export interface UnifiedSearch { titles: SearchHit[]; people: RankedPerson[]; peopleFirst: boolean; usedQuery: string; correctedPerson?: string }

/**
 * Búsqueda unificada (v3.2): películas, series y personas. Se consultan /search/multi y /search/person a la vez
 * (en /search/multi las personas suelen quedar detrás de títulos que las mencionan, p. ej. «The Michael J. Fox Show»).
 * Personas: id único, ordenadas por coincidencia del nombre y popularidad, con corrección de errores menores.
 * Las personas van primero cuando lo escrito coincide con el nombre de alguien conocido y no es el título de una obra.
 */
export async function searchAll(query: string, language: string): Promise<UnifiedSearch> {
  const client = await getClient();
  const names = await genreNames(language);
  let titlesRaw: SearchResult[] = [];
  let usedQuery = query.trim();
  let peopleBase: PersonHit[] = [];
  for (const q of queryVariants(query)) {
    const [r, p] = await Promise.all([client.searchMultiAll(q, language), client.searchPerson(q, language).catch(() => [] as PersonHit[])]);
    titlesRaw = r.titles; peopleBase = [...p, ...r.people]; usedQuery = q;
    if (r.titles.length || peopleBase.length) break;
  }
  const { people, corrected } = await tolerantPeopleSearch(query, (q) => client.searchPerson(q, language), peopleBase);
  const existing = await db.titles.bulkGet(titlesRaw.map((x) => x.key));
  const toPut = titlesRaw.filter((_, i) => !existing[i]).map((x) => metaFromSearch(x, names));
  if (toPut.length) await db.titles.bulkPut(toPut);
  const titles = titlesRaw.map((x) => ({ ...x, genres: x.genreIds.map((id) => ({ id, name: names.get(id) ?? `Género ${id}` })) }));
  const nq = normName(query);
  // Un título con ese nombre exacto manda sólo si es conocido (un documental con 3 votos llamado «Michael J. Fox» no
  // debe tapar a la persona)
  const isTitle = titles.some((t) => (normName(t.title) === nq || normName(t.originalTitle ?? '') === nq) && (t.voteCount ?? 0) >= 100);
  const top = people[0];
  const peopleFirst = Boolean(top && top.match >= 0.9 && (top.popularity ?? 0) >= 0.5 && !isTitle);
  return { titles, people: people.slice(0, 8), peopleFirst, usedQuery, correctedPerson: corrected };
}

const personCache = new Map<string, PersonInfo>();
export async function getPerson(id: number, language: string): Promise<PersonInfo> {
  const ck = `${id}|${language}`;
  const c = personCache.get(ck);
  if (c) return c;
  const client = await getClient();
  const p = await client.personDetails(id, language);
  personCache.set(ck, p);
  return p;
}
