import type { AvailabilitySnapshot, MediaType, PlatformId, Rating, TitleMeta } from '../types';
import { streamingPlatforms } from './availability';

export type WatchedFilter = 'unwatched' | 'watched' | 'all';

/**
 * Filtros temporales del ranking. Se aplican al conjunto de candidatos antes de ordenar y nunca
 * modifican las preferencias aprendidas ni los ajustes del perfil.
 */
export interface RankFilters {
  types: MediaType[]; // vacío = películas y series
  includeGenres: number[]; // al menos uno de estos
  excludeGenres: number[];
  yearMin?: number;
  yearMax?: number;
  platforms: PlatformId[]; // vacío = todas tus plataformas
  watched: WatchedFilter;
  runtimeMin?: number; // minutos (en series: duración de episodio)
  runtimeMax?: number;
  minScore?: number; // afinidad estimada mínima (1-10)
  /** v3.0: persona elegida por id único de TMDB (actor, actriz, dirección) */
  person?: { id: number; name: string; department?: string };
}

/** «Recomendaciones generales» */
export const DEFAULT_FILTERS: RankFilters = { types: [], includeGenres: [], excludeGenres: [], platforms: [], watched: 'unwatched' };

type FilterId = 'types' | 'includeGenres' | 'excludeGenres' | 'yearMin' | 'yearMax' | 'platforms' | 'runtime' | 'minScore' | 'person';

/** Filtros que cambian el conjunto de candidatos (el de vistos se maneja aparte, como en v2.0). */
export function activeFilters(f: RankFilters): FilterId[] {
  const out: FilterId[] = [];
  if (f.types.length === 1) out.push('types');
  if (f.includeGenres.length) out.push('includeGenres');
  if (f.excludeGenres.length) out.push('excludeGenres');
  if (f.yearMin) out.push('yearMin');
  if (f.yearMax) out.push('yearMax');
  if (f.platforms.length) out.push('platforms');
  if (f.runtimeMin || f.runtimeMax) out.push('runtime');
  if (f.minScore) out.push('minScore');
  if (f.person) out.push('person');
  return out;
}

export const isGeneral = (f: RankFilters) => activeFilters(f).length === 0 && f.watched === 'unwatched';
export const activeCount = (f: RankFilters) => activeFilters(f).length + (f.watched === 'unwatched' ? 0 : 1);

const without = (f: RankFilters, id: FilterId): RankFilters => {
  const g = { ...f };
  if (id === 'types') g.types = [];
  if (id === 'includeGenres') g.includeGenres = [];
  if (id === 'excludeGenres') g.excludeGenres = [];
  if (id === 'yearMin') g.yearMin = undefined;
  if (id === 'yearMax') g.yearMax = undefined;
  if (id === 'platforms') g.platforms = [];
  if (id === 'runtime') { g.runtimeMin = undefined; g.runtimeMax = undefined; }
  if (id === 'minScore') g.minScore = undefined;
  if (id === 'person') g.person = undefined;
  return g;
};

export function filterLabel(id: FilterId, f: RankFilters, genreName: (id: number) => string, platformName: (id: PlatformId) => string): string {
  switch (id) {
    case 'types': return f.types[0] === 'movie' ? 'Sólo películas' : 'Sólo series';
    case 'includeGenres': return `Géneros: ${f.includeGenres.map(genreName).join(', ')}`;
    case 'excludeGenres': return `Sin ${f.excludeGenres.map(genreName).join(', ')}`;
    case 'yearMin': return `Desde ${f.yearMin}`;
    case 'yearMax': return `Hasta ${f.yearMax}`;
    case 'platforms': return f.platforms.map(platformName).join(' o ');
    case 'runtime': return f.runtimeMin && f.runtimeMax ? `${f.runtimeMin}-${f.runtimeMax} min` : f.runtimeMin ? `Más de ${f.runtimeMin} min` : `Hasta ${f.runtimeMax} min`;
    case 'minScore': return `Para vos ≥ ${f.minScore}`;
    case 'person': return `Con ${f.person?.name}`;
  }
}

export interface Candidate { meta: TitleMeta; snap?: AvailabilitySnapshot | null; rating?: Rating; score?: number }

/** ¿El candidato pasa los filtros de contenido? (sin el de vistos ni la afinidad mínima, que dependen del ranking) */
export function matchesContent(c: Candidate, f: RankFilters): boolean {
  const t = c.meta;
  if (f.types.length === 1 && t.type !== f.types[0]) return false;
  if (f.includeGenres.length && !t.genres.some((g) => f.includeGenres.includes(g.id))) return false;
  if (f.excludeGenres.length && t.genres.some((g) => f.excludeGenres.includes(g.id))) return false;
  if (f.yearMin && !(t.year && t.year >= f.yearMin)) return false;
  if (f.yearMax && !(t.year && t.year <= f.yearMax)) return false;
  if (f.platforms.length && !streamingPlatforms(c.snap).some((p) => f.platforms.includes(p))) return false;
  // Duración: sólo se filtra cuando hay datos; un título sin duración conocida no se descarta por eso
  if (t.runtime && f.runtimeMin && t.runtime < f.runtimeMin) return false;
  if (t.runtime && f.runtimeMax && t.runtime > f.runtimeMax) return false;
  return true;
}

export function matchesWatched(c: Candidate, f: RankFilters): boolean {
  if (f.watched === 'all') return true;
  return (f.watched === 'watched') === Boolean(c.rating?.watched);
}

export function matchesAll(c: Candidate, f: RankFilters): boolean {
  return matchesContent(c, f) && matchesWatched(c, f) && (!f.minScore || (c.score ?? 0) >= f.minScore);
}

/** Si no hay resultados: cuántos habría quitando cada filtro activo, para explicar qué restringe. */
export function diagnose(cands: Candidate[], f: RankFilters): { id: FilterId; count: number }[] {
  return activeFilters(f).map((id) => ({ id, count: cands.filter((c) => matchesAll(c, without(f, id))).length }))
    .filter((d) => d.count > 0).sort((a, b) => b.count - a.count);
}

const KEY = (profileId: string) => `cine-match:filters:${profileId}`;
/** La selección se conserva al navegar y al recargar en este dispositivo (no es una preferencia aprendida). */
export function loadFilters(profileId: string): RankFilters {
  try {
    const raw = localStorage.getItem(KEY(profileId));
    if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch { /* almacenamiento no disponible */ }
  return { ...DEFAULT_FILTERS };
}
export function saveFilters(profileId: string, f: RankFilters) {
  try { localStorage.setItem(KEY(profileId), JSON.stringify(f)); } catch { /* sin almacenamiento */ }
}
