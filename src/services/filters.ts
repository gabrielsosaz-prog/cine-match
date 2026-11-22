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
  /**
   * v3.1: país de origen o de producción (códigos ISO 3166-1). No es el idioma original ni la nacionalidad del reparto.
   * Regla: «incluir» exige que al menos uno de los países del título esté en la lista (sin país conocido no pasa);
   * «excluir» quita el título si CUALQUIERA de sus países está en la lista (también coproducciones); sin país
   * conocido, el título se mantiene y se informa.
   */
  includeCountries?: string[];
  excludeCountries?: string[];
  /** v3.2: qué campo de TMDB cuenta como país: origen ∪ producción (predeterminado), sólo origen o sólo producción */
  countryField?: CountryField;
  /**
   * v3.2: personas incluidas y excluidas, por id único de TMDB (homónimos distintos = ids distintos).
   * Actuación: cuenta sólo si tiene un crédito de reparto que no sea «como sí mismo» (ni producción ni equipo técnico).
   * Dirección/guion: cuenta su crédito en ese departamento. Series: cualquier crédito de reparto en la serie,
   * también como invitado (TMDB los agrupa por serie con la cantidad de episodios); «Todos» = todos figuran en la
   * serie, aunque sea en episodios distintos.
   * Incluir «Cualquiera» = al menos uno; «Todos» = todos. Excluir = se quita si figura cualquiera; la exclusión manda.
   */
  includePeople?: PersonRef[];
  excludePeople?: PersonRef[];
  peopleMode?: 'any' | 'all';
  /** v3.2: con filtros de personas, mostrar también los títulos que no están en tus plataformas */
  anyPlatform?: boolean;
}
export interface PersonRef { id: number; name: string; department?: string }
export type CountryField = 'both' | 'origin' | 'production';

/** Personas incluidas (compatibilidad: el filtro de una sola persona de v3.0 cuenta como incluida). */
export const includedPeople = (f: RankFilters): PersonRef[] => f.includePeople ?? (f.person ? [f.person] : []);

/** Países de un título: origen (series y películas) + producción (películas). */
export const countriesOf = (t: TitleMeta, field: CountryField = 'both'): string[] => [...new Set([...(field !== 'production' ? t.originCountry ?? [] : []), ...(field !== 'origin' ? t.productionCountries ?? [] : [])])];

/** «Recomendaciones generales» */
export const DEFAULT_FILTERS: RankFilters = { types: [], includeGenres: [], excludeGenres: [], platforms: [], watched: 'unwatched' };

type FilterId = 'types' | 'includeGenres' | 'excludeGenres' | 'yearMin' | 'yearMax' | 'platforms' | 'runtime' | 'minScore' | 'person' | 'includeCountries' | 'excludeCountries' | 'includePeople' | 'excludePeople';
export type { FilterId };

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
  if (includedPeople(f).length) out.push('includePeople');
  if (f.excludePeople?.length) out.push('excludePeople');
  if (f.includeCountries?.length) out.push('includeCountries');
  if (f.excludeCountries?.length) out.push('excludeCountries');
  return out;
}

export const isGeneral = (f: RankFilters) => activeFilters(f).length === 0 && f.watched === 'unwatched';
export const activeCount = (f: RankFilters) => activeFilters(f).length + (f.watched === 'unwatched' ? 0 : 1);

export const without = (f: RankFilters, id: FilterId): RankFilters => {
  const g = { ...f };
  if (id === 'types') g.types = [];
  if (id === 'includeGenres') g.includeGenres = [];
  if (id === 'excludeGenres') g.excludeGenres = [];
  if (id === 'yearMin') g.yearMin = undefined;
  if (id === 'yearMax') g.yearMax = undefined;
  if (id === 'platforms') g.platforms = [];
  if (id === 'runtime') { g.runtimeMin = undefined; g.runtimeMax = undefined; }
  if (id === 'minScore') g.minScore = undefined;
  if (id === 'person' || id === 'includePeople') { g.person = undefined; g.includePeople = []; }
  if (id === 'excludePeople') g.excludePeople = [];
  if (id === 'includeCountries') g.includeCountries = [];
  if (id === 'excludeCountries') g.excludeCountries = [];
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
    case 'person':
    case 'includePeople': { const ps = includedPeople(f); return ps.length === 1 ? `Actores incluidos: ${ps[0].name}` : `Actores incluidos: ${joinY(ps.map((p) => p.name))} · Coincidencia: ${f.peopleMode === 'all' ? 'Todos' : 'Cualquiera'}`; }
    case 'excludePeople': return `Actores excluidos: ${joinY(f.excludePeople!.map((p) => p.name))}`;
    case 'includeCountries': return `Países incluidos: ${joinY(f.includeCountries!.map(countryName), 'o')}${fieldNote(f)}`;
    case 'excludeCountries': return `Países excluidos: ${joinY(f.excludeCountries!.map(countryName))}${fieldNote(f)}`;
  }
}

const joinY = (xs: string[], y = 'y') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${y} ${xs[xs.length - 1]}`);
const fieldNote = (f: RankFilters) => (f.countryField === 'origin' ? ' (país de origen)' : f.countryField === 'production' ? ' (país de producción)' : '');

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
  if (f.includeCountries?.length || f.excludeCountries?.length) {
    const cs = countriesOf(t, f.countryField);
    // La exclusión manda: una coproducción con un país excluido no pasa aunque tenga uno incluido
    if (f.excludeCountries?.length && cs.some((c) => f.excludeCountries!.includes(c))) return false;
    if (f.includeCountries?.length && !cs.some((c) => f.includeCountries!.includes(c))) return false;
  }
  return true;
}

let regionNames: Intl.DisplayNames | undefined;
/** Nombre del país en español (Intl), con el código si el entorno no lo conoce. */
export function countryName(code: string): string {
  try { regionNames ??= new Intl.DisplayNames(['es'], { type: 'region' }); return regionNames.of(code) ?? code; } catch { return code; }
}
/** Todos los países ISO conocidos por el navegador, con nombre en español, para el buscador del filtro. */
export function allCountries(): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    const n = countryName(code);
    if (n && n !== code && !/^[A-Z]{2}$/.test(n)) out.push({ code, name: n });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name, 'es'));
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
    if (raw) return migrateFilters({ ...DEFAULT_FILTERS, ...JSON.parse(raw) });
  } catch { /* almacenamiento no disponible */ }
  return { ...DEFAULT_FILTERS };
}
/** v3.2: el filtro de una persona (v3.0/v3.1) pasa a «personas incluidas». Idempotente, sólo en lectura. */
export function migrateFilters(f: RankFilters): RankFilters {
  if (f.person && !f.includePeople) { const { person, ...rest } = f; return { ...rest, includePeople: [person] }; }
  return f;
}
export function saveFilters(profileId: string, f: RankFilters) {
  try { localStorage.setItem(KEY(profileId), JSON.stringify(f)); } catch { /* sin almacenamiento */ }
}
