import { PLATFORMS } from '../constants';
import type {
  AvailabilitySnapshot, MediaType, Named, OfferKind, Person, PlatformId, ProviderOffer, TitleKey, TitleMeta,
} from '../types';
import { titleKey } from '../types';
import { ProviderError } from './errors';

export const TMDB_SOURCE = 'TMDB';
export const AVAILABILITY_SOURCE = 'TMDB / JustWatch';
const API = 'https://api.themoviedb.org/3';
export const IMG = 'https://image.tmdb.org/t/p/';
/** Proxy integrado (mismo dominio que la app): la credencial vive en el servidor. */
export const BUILTIN_PROXY = '/api/tmdb';

/** Consulta al servidor si tiene el token configurado y TMDB responde. */
export async function checkServer(fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<{ available: boolean; tokenConfigured: boolean; ok: boolean; tmdbStatus?: number }> {
  try {
    const r = await fetchImpl('/api/health', { headers: { Accept: 'application/json' } });
    const ct = r.headers.get('Content-Type') ?? '';
    if (!ct.includes('json')) return { available: false, tokenConfigured: false, ok: false };
    const j = await r.json();
    return { available: true, tokenConfigured: Boolean(j.tokenConfigured), ok: Boolean(j.ok), tmdbStatus: j.tmdbStatus };
  } catch {
    return { available: false, tokenConfigured: false, ok: false };
  }
}

export interface TmdbAuth {
  /** Token v4 ("eyJ...") o clave v3 de 32 caracteres. Se guarda sólo en el dispositivo. */
  token?: string;
  /** Proxy propio que agrega la credencial del lado servidor (recomendado para varios usuarios). */
  proxyUrl?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SearchResult {
  key: TitleKey;
  type: MediaType;
  tmdbId: number;
  title: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  posterPath?: string | null;
  genreIds: number[];
  voteAverage?: number;
  voteCount?: number;
  popularity?: number;
  originalLanguage?: string;
}

/** Tiempo máximo de una consulta a TMDB */
export const REQUEST_TIMEOUT_MS = 15000;

export interface PersonHit { id: number; name: string; department?: string; profilePath?: string | null; popularity?: number; knownFor: string[] }
export interface PersonCredit extends SearchResult { kind: 'cast' | 'crew'; character?: string; job?: string; order?: number; episodes?: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function platformOf(providerId: number, providerName: string): PlatformId | null {
  for (const p of PLATFORMS) {
    if (p.tmdbIds.includes(providerId) || p.match.test(providerName)) {
      // Excluir canales de Amazon ("Paramount+ Amazon Channel") que no son Prime Video en sí
      if (/channel/i.test(providerName)) return null;
      return p.id;
    }
  }
  return null;
}

const yearOf = (d?: string) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : undefined);

export class TmdbClient {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private auth: TmdbAuth, private fetchImpl: FetchLike = (u, i) => fetch(u, i), private maxConcurrent = 6) {}

  get configured() {
    return Boolean(this.auth.token || this.auth.proxyUrl);
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  async get<T = any>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    if (!this.configured) throw new ProviderError('config', 'TMDB sin credenciales');
    const base = this.auth.proxyUrl ? this.auth.proxyUrl.replace(/\/$/, '') : API;
    const url = new URL(base + path, typeof location !== 'undefined' ? location.origin : 'http://localhost');
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.auth.token?.trim();
    if (!this.auth.proxyUrl && token) {
      if (/^[a-f0-9]{32}$/i.test(token)) url.searchParams.set('api_key', token);
      else headers.Authorization = `Bearer ${token}`;
    }
    return this.slot(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let res: Response;
        // Tiempo máximo por consulta: una conexión colgada (frecuente en redes móviles) no puede bloquear
        // la cola de consultas ni dejar la app «procesando» para siempre.
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
        const timer = setTimeout(() => ctrl?.abort(), REQUEST_TIMEOUT_MS);
        try {
          res = await Promise.race([
            this.fetchImpl(url.toString(), { headers, signal: ctrl?.signal }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tiempo de espera agotado')), REQUEST_TIMEOUT_MS + 50)),
          ]);
        } catch (e) {
          clearTimeout(timer);
          if (attempt < 1) { await sleep(400); continue; }
          throw new ProviderError('network', `Fallo de red: ${(e as Error).message}`);
        }
        clearTimeout(timer);
        if (res.ok) {
          try { return (await res.json()) as T; } catch { throw new ProviderError('bad_response', 'JSON inválido'); }
        }
        if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'Credencial inválida', res.status);
        if (res.status === 404) throw new ProviderError('not_found', 'No encontrado', 404);
        if (res.status === 429) {
          const wait = Number(res.headers.get('Retry-After') ?? 1) * 1000;
          if (attempt < 2) { await sleep(Math.min(wait, 5000)); continue; }
          throw new ProviderError('rate_limit', 'Límite de consultas', 429);
        }
        if (res.status >= 500) {
          if (attempt < 1) { await sleep(600); continue; }
          throw new ProviderError('server', `Error ${res.status}`, res.status);
        }
        throw new ProviderError('bad_response', `Respuesta ${res.status}`, res.status);
      }
      throw new ProviderError('network', 'Reintentos agotados');
    });
  }

  /** Búsqueda por nombre de películas y series (descarta personas). */
  async search(query: string, language: string, page = 1): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const data = await this.get<any>('/search/multi', { query: q, language, include_adult: false, page });
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    return results
      .filter((r) => r && (r.media_type === 'movie' || r.media_type === 'tv') && typeof r.id === 'number')
      .map((r) => mapListItem(r, r.media_type));
  }

  async discover(type: MediaType, params: Record<string, string | number | boolean | undefined>): Promise<SearchResult[]> {
    const data = await this.get<any>(`/discover/${type}`, { include_adult: false, ...params });
    return (Array.isArray(data?.results) ? data.results : []).filter((r: any) => typeof r?.id === 'number').map((r: any) => mapListItem(r, type));
  }

  async trending(type: MediaType, language: string): Promise<SearchResult[]> {
    const data = await this.get<any>(`/trending/${type}/week`, { language });
    return (Array.isArray(data?.results) ? data.results : []).map((r: any) => mapListItem(r, type));
  }

  async genres(type: MediaType, language: string): Promise<Named[]> {
    const data = await this.get<any>(`/genre/${type}/list`, { language });
    return Array.isArray(data?.genres) ? data.genres : [];
  }

  /**
   * Ficha completa + disponibilidad en una sola llamada (append_to_response).
   * Devuelve metadata y snapshot de disponibilidad por separado.
   */
  async details(type: MediaType, id: number, language: string, country: string): Promise<{ meta: TitleMeta; availability: AvailabilitySnapshot; related: SearchResult[] }> {
    // Series: aggregate_credits informa en cuántos episodios participó cada actor (participación real)
    const append = ['keywords', type === 'tv' ? 'aggregate_credits' : 'credits', 'recommendations', 'similar', 'watch/providers'].join(',');
    const d = await this.get<any>(`/${type}/${id}`, { language, append_to_response: append });
    if (!d || typeof d.id !== 'number') throw new ProviderError('bad_response', 'Ficha sin id');
    const meta = mapDetails(d, type, language);
    if (!meta.overview && !language.startsWith('en')) {
      try {
        const en = await this.get<any>(`/${type}/${id}`, { language: 'en-US' });
        if (en?.overview) { meta.overview = en.overview; meta.overviewLang = 'en'; meta.missing = meta.missing.filter((m) => m !== 'sinopsis'); }
      } catch { /* se conserva como faltante */ }
    }
    const related: SearchResult[] = [];
    for (const list of [d.recommendations?.results, d.similar?.results]) {
      if (Array.isArray(list)) for (const r of list.slice(0, 12)) if (typeof r?.id === 'number') related.push(mapListItem(r, type));
    }
    return { meta, availability: mapProviders(meta.key, d['watch/providers'], country), related };
  }

  /** v3.0: búsqueda de personas (actores, directores). Se distinguen por id único de TMDB, no por nombre. */
  async searchPerson(query: string, language: string): Promise<PersonHit[]> {
    const q = query.trim();
    if (!q) return [];
    const data = await this.get<any>('/search/person', { query: q, language, include_adult: false, page: 1 });
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    return results.filter((r) => typeof r?.id === 'number' && r.name).map((r) => ({
      id: r.id, name: r.name, department: r.known_for_department || undefined, profilePath: r.profile_path ?? null, popularity: r.popularity,
      knownFor: (Array.isArray(r.known_for) ? r.known_for : []).filter((k: any) => k?.media_type === 'movie' || k?.media_type === 'tv')
        .slice(0, 3).map((k: any) => `${k.title ?? k.name}${(k.release_date ?? k.first_air_date ?? '').slice(0, 4) ? ` (${(k.release_date ?? k.first_air_date).slice(0, 4)})` : ''}`),
    }));
  }

  /** v3.0: filmografía completa (películas y series) de una persona por su id único. */
  async personCredits(personId: number, language: string): Promise<PersonCredit[]> {
    const data = await this.get<any>(`/person/${personId}/combined_credits`, { language });
    const out: PersonCredit[] = [];
    for (const [list, kind] of [[data?.cast, 'cast'], [data?.crew, 'crew']] as const) {
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if ((c?.media_type !== 'movie' && c?.media_type !== 'tv') || typeof c.id !== 'number') continue;
        out.push({ ...mapListItem(c, c.media_type), kind, character: c.character, job: c.job, order: typeof c.order === 'number' ? c.order : undefined, episodes: typeof c.episode_count === 'number' ? c.episode_count : undefined });
      }
    }
    return out;
  }

  /** Sólo disponibilidad (para refrescos periódicos baratos). */
  async availability(type: MediaType, id: number, country: string): Promise<AvailabilitySnapshot> {
    const d = await this.get<any>(`/${type}/${id}/watch/providers`);
    return mapProviders(titleKey(type, id), d, country);
  }
}

export function mapListItem(r: any, type: MediaType): SearchResult {
  const title = (type === 'movie' ? r.title : r.name) ?? r.original_title ?? r.original_name ?? 'Sin título';
  return {
    key: titleKey(type, r.id),
    type,
    tmdbId: r.id,
    title,
    originalTitle: (type === 'movie' ? r.original_title : r.original_name) || undefined,
    year: yearOf(type === 'movie' ? r.release_date : r.first_air_date),
    overview: r.overview || undefined,
    posterPath: r.poster_path ?? null,
    genreIds: Array.isArray(r.genre_ids) ? r.genre_ids : [],
    voteAverage: typeof r.vote_average === 'number' ? r.vote_average : undefined,
    voteCount: typeof r.vote_count === 'number' ? r.vote_count : undefined,
    popularity: typeof r.popularity === 'number' ? r.popularity : undefined,
    originalLanguage: r.original_language,
  };
}

/** Convierte un resultado de búsqueda en metadata básica (completeness='basic'). */
export function metaFromSearch(r: SearchResult, genreNames: Map<number, string>): TitleMeta {
  return {
    key: r.key, type: r.type, tmdbId: r.tmdbId, title: r.title, originalTitle: r.originalTitle, year: r.year,
    overview: r.overview, posterPath: r.posterPath,
    genres: r.genreIds.map((id) => ({ id, name: genreNames.get(id) ?? `Género ${id}` })),
    keywords: [], cast: [], directors: [],
    voteAverage: r.voteAverage, voteCount: r.voteCount, popularity: r.popularity, originalLanguage: r.originalLanguage,
    completeness: 'basic', missing: ['palabras clave', 'reparto', 'dirección'], source: TMDB_SOURCE, fetchedAt: Date.now(),
  };
}

/** Versión del mapeo de fichas: las guardadas con una versión menor se vuelven a pedir. */
export const META_VERSION = 3;

export function mapDetails(d: any, type: MediaType, language: string): TitleMeta {
  const missing: string[] = [];
  const genres: Named[] = Array.isArray(d.genres) ? d.genres.filter((g: any) => g?.id) : [];
  const kwRaw = type === 'movie' ? d.keywords?.keywords : d.keywords?.results;
  const keywords: Named[] = Array.isArray(kwRaw) ? kwRaw.filter((k: any) => k?.id) : [];
  const agg = type === 'tv' && Array.isArray(d.aggregate_credits?.cast) ? d.aggregate_credits.cast : null;
  const castRaw: any[] = agg ?? (Array.isArray(d.credits?.cast) ? d.credits.cast : []);
  const cast: Person[] = castRaw
    .filter((c: any) => typeof c?.id === 'number')
    .map((c: any, i: number) => ({
      id: c.id, name: c.name,
      role: c.character ?? c.roles?.[0]?.character,
      order: typeof c.order === 'number' ? c.order : i,
      episodes: typeof c.total_episode_count === 'number' ? c.total_episode_count : undefined,
    }))
    .sort((a, b) => a.order - b.order)
    .slice(0, 8);
  let directors: Person[] = [];
  if (type === 'movie') {
    directors = (d.credits?.crew ?? []).filter((c: any) => c.job === 'Director').map((c: any) => ({ id: c.id, name: c.name, role: 'Dirección' }));
  } else {
    directors = (d.created_by ?? []).map((c: any) => ({ id: c.id, name: c.name, role: 'Creación' }));
  }
  // Guion y autoría: créditos de TMDB del departamento «Writing» (series: aggregate_credits con varios trabajos)
  const crewRaw: any[] = type === 'tv' && Array.isArray(d.aggregate_credits?.crew) ? d.aggregate_credits.crew : Array.isArray(d.credits?.crew) ? d.credits.crew : [];
  const WRITING = /^(Screenplay|Writer|Story|Novel|Author|Characters|Teleplay|Head Writer|Original Story|Book)$/i;
  const seenW = new Set<number>();
  const writers: Person[] = [];
  for (const c of crewRaw) {
    if (typeof c?.id !== 'number' || seenW.has(c.id)) continue;
    const jobs: string[] = Array.isArray(c.jobs) ? c.jobs.map((j: any) => j?.job).filter(Boolean) : c.job ? [c.job] : [];
    const job = jobs.find((j) => WRITING.test(j));
    if (c.department !== 'Writing' && !job) continue;
    seenW.add(c.id);
    writers.push({ id: c.id, name: c.name, role: job ?? 'Guion', episodes: typeof c.total_episode_count === 'number' ? c.total_episode_count : undefined });
  }
  writers.sort((a, b) => (b.episodes ?? 0) - (a.episodes ?? 0));
  const runtime = type === 'movie' ? d.runtime || undefined : (Array.isArray(d.episode_run_time) && d.episode_run_time[0]) || d.last_episode_to_air?.runtime || undefined;
  const overview: string | undefined = d.overview || undefined;
  if (!overview) missing.push('sinopsis');
  if (!genres.length) missing.push('géneros');
  if (!keywords.length) missing.push('palabras clave');
  if (!cast.length) missing.push('reparto');
  if (!directors.length) missing.push(type === 'movie' ? 'dirección' : 'creadores');
  if (!runtime) missing.push('duración');
  if (!d.poster_path) missing.push('póster');
  const releaseDate = type === 'movie' ? d.release_date : d.first_air_date;
  if (!releaseDate) missing.push('fecha de estreno');
  const related: TitleKey[] = [];
  for (const list of [d.recommendations?.results, d.similar?.results]) {
    if (Array.isArray(list)) for (const r of list.slice(0, 12)) if (typeof r?.id === 'number') related.push(titleKey(type, r.id));
  }
  return {
    key: titleKey(type, d.id), type, tmdbId: d.id,
    title: (type === 'movie' ? d.title : d.name) ?? d.original_title ?? d.original_name ?? 'Sin título',
    originalTitle: (type === 'movie' ? d.original_title : d.original_name) || undefined,
    year: yearOf(releaseDate), releaseDate: releaseDate || undefined,
    overview, overviewLang: overview ? language.slice(0, 2) : undefined,
    posterPath: d.poster_path ?? null, backdropPath: d.backdrop_path ?? null,
    genres, keywords, cast, directors, writers: writers.slice(0, 6), runtime,
    seasons: type === 'tv' && Array.isArray(d.seasons)
      ? d.seasons.filter((s: any) => s.season_number > 0).map((s: any) => ({ number: s.season_number, name: s.name, episodes: s.episode_count, airDate: s.air_date || undefined }))
      : undefined,
    numberOfSeasons: type === 'tv' ? d.number_of_seasons : undefined,
    status: d.status,
    originalLanguage: d.original_language,
    originCountry: d.origin_country ?? (Array.isArray(d.production_countries) ? d.production_countries.map((c: any) => c.iso_3166_1) : undefined),
    voteAverage: d.vote_average, voteCount: d.vote_count, popularity: d.popularity,
    collection: d.belongs_to_collection?.id ? { id: d.belongs_to_collection.id, name: d.belongs_to_collection.name } : undefined,
    totalEpisodes: type === 'tv' && typeof d.number_of_episodes === 'number' ? d.number_of_episodes : undefined,
    metaVersion: META_VERSION,
    related: [...new Set(related)],
    completeness: 'full', missing, source: TMDB_SOURCE, fetchedAt: Date.now(),
  };
}

export function mapProviders(key: TitleKey, wp: any, country: string): AvailabilitySnapshot {
  const now = Date.now();
  const base = { id: `${key}|${country}`, key, country, source: AVAILABILITY_SOURCE, checkedAt: now };
  if (!wp || typeof wp !== 'object' || !wp.results) return { ...base, offers: [], status: 'error', errorMessage: 'Respuesta sin datos de proveedores' };
  const c = wp.results[country];
  if (!c) return { ...base, offers: [], status: 'no-data' };
  const offers: ProviderOffer[] = [];
  for (const kind of ['flatrate', 'ads', 'free', 'rent', 'buy'] as OfferKind[]) {
    for (const p of c[kind] ?? []) {
      if (typeof p?.provider_id !== 'number') continue;
      offers.push({ providerId: p.provider_id, providerName: p.provider_name, platform: platformOf(p.provider_id, p.provider_name ?? ''), kind, logoPath: p.logo_path });
    }
  }
  return { ...base, offers, status: 'ok', link: c.link };
}
