import type { AvailabilitySnapshot, MediaType, PlatformId, Rating, TitleMeta } from '../types';
import { streamingPlatforms } from './availability';
import { audienceDataVersion, audienceMatch, audienceName, classifyAudience, matchesAudience, type AudienceFilter, type AudienceId, type AudienceProfile } from './audience';
import { getNarrativeIndex } from './narrativeCatalog';
import { expandRegions, regionCountries, regionName, type RegionId } from './regions';
import { condLabel, groupLabel, matchesText, type ParsedText, type TextContext } from './textFilter';

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
  /**
   * v3.3: regiones (se expanden a países: services/regions.ts). Se combinan con los países con la misma regla:
   * incluir = al menos un país del título está en algún país o región incluida; excluir = se quita si participa un
   * país o región excluida (coproducciones incluidas); la exclusión manda; sin países conocidos = desconocido
   * (no pasa una inclusión, no se quita por una exclusión).
   */
  includeRegions?: RegionId[];
  excludeRegions?: RegionId[];
  /** v3.3: público objetivo (services/audience.ts). Incluir = alguna; excluir = se quita si alguna; la exclusión manda. */
  audience?: AudienceFilter;
  /**
   * v3.3: texto libre ya interpretado y confirmado (services/textFilter.ts). Se suma a los demás filtros (Y lógico);
   * una exclusión de cualquier lado manda; rangos de años: se usa la intersección. Las contradicciones se avisan
   * antes de aplicar (contradictions()).
   */
  text?: ParsedText;
}
export interface PersonRef { id: number; name: string; department?: string }
export type CountryField = 'both' | 'origin' | 'production';

/** Personas incluidas (compatibilidad: el filtro de una sola persona de v3.0 cuenta como incluida). */
export const includedPeople = (f: RankFilters): PersonRef[] => f.includePeople ?? (f.person ? [f.person] : []);

/** Países de un título: origen (series y películas) + producción (películas). */
export const countriesOf = (t: TitleMeta, field: CountryField = 'both'): string[] => [...new Set([...(field !== 'production' ? t.originCountry ?? [] : []), ...(field !== 'origin' ? t.productionCountries ?? [] : [])])];

/** «Recomendaciones generales» */
export const DEFAULT_FILTERS: RankFilters = { types: [], includeGenres: [], excludeGenres: [], platforms: [], watched: 'unwatched' };

type FilterId = 'types' | 'includeGenres' | 'excludeGenres' | 'yearMin' | 'yearMax' | 'platforms' | 'runtime' | 'minScore' | 'person' | 'includeCountries' | 'excludeCountries' | 'includePeople' | 'excludePeople'
  | 'includeRegions' | 'excludeRegions' | 'includeAudience' | 'excludeAudience' | 'text';
/** Grupos del panel (v3.3), para limpiarlos por separado */
export const FILTER_GROUPS: Record<'text' | 'audience' | 'places' | 'other', FilterId[]> = {
  text: ['text'], audience: ['includeAudience', 'excludeAudience'], places: ['includeCountries', 'excludeCountries', 'includeRegions', 'excludeRegions'],
  other: ['types', 'includeGenres', 'excludeGenres', 'yearMin', 'yearMax', 'platforms', 'runtime', 'minScore', 'includePeople', 'excludePeople'],
};
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
  if (f.includeRegions?.length) out.push('includeRegions');
  if (f.excludeRegions?.length) out.push('excludeRegions');
  if (f.audience?.include.length) out.push('includeAudience');
  if (f.audience?.exclude.length) out.push('excludeAudience');
  if (f.text && (f.text.include.length || f.text.exclude.length)) out.push('text');
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
  if (id === 'includeRegions') g.includeRegions = [];
  if (id === 'excludeRegions') g.excludeRegions = [];
  if (id === 'includeAudience' && g.audience) g.audience = { ...g.audience, include: [] };
  if (id === 'excludeAudience' && g.audience) g.audience = { ...g.audience, exclude: [] };
  if (id === 'text') g.text = undefined;
  return g;
};
/** v3.3: quita un grupo entero del panel sin tocar los demás. */
export const withoutGroup = (f: RankFilters, group: keyof typeof FILTER_GROUPS): RankFilters => FILTER_GROUPS[group].reduce((g, id) => without(g, id), f);

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
    case 'includeRegions': return `Regiones incluidas: ${joinY(f.includeRegions!.map(regionName), 'o')}${fieldNote(f)}`;
    case 'excludeRegions': return `Regiones excluidas: ${joinY(f.excludeRegions!.map(regionName))}${fieldNote(f)}`;
    case 'includeAudience': return `Público incluido: ${joinY(f.audience!.include.map(audienceName), 'o')} (aprox.)`;
    case 'excludeAudience': return `Público excluido: ${joinY(f.audience!.exclude.map(audienceName))} (aprox.)`;
    case 'text': return `Texto: «${f.text!.text.length > 40 ? f.text!.text.slice(0, 40) + '…' : f.text!.text}»`;
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
  const { inc, exc } = placeSets(f);
  if (inc.length || exc.length) {
    const cs = countriesOf(t, f.countryField);
    // La exclusión manda: una coproducción con un país (o región) excluido no pasa aunque tenga uno incluido
    if (exc.length && cs.some((c) => exc.includes(c))) return false;
    if (inc.length && !cs.some((c) => inc.includes(c))) return false;
  }
  if (f.audience && (f.audience.include.length || f.audience.exclude.length) && !matchesAudience(audienceOf(t, f.audience.threshold), f.audience)) return false;
  if (f.text && !matchesText(f.text, t, textContext(f))) return false;
  return true;
}

/** v3.3: países incluidos y excluidos después de expandir las regiones. */
export function placeSets(f: RankFilters): { inc: string[]; exc: string[] } {
  return { inc: [...new Set([...(f.includeCountries ?? []), ...expandRegions(f.includeRegions)])], exc: [...new Set([...(f.excludeCountries ?? []), ...expandRegions(f.excludeRegions)])] };
}
/** Palabras clave del título: de la ficha o, si es básica, del catálogo narrativo (undefined = sin datos). */
export function keywordNames(t: TitleMeta): string[] | undefined {
  if (t.keywords.length) return t.keywords.map((k) => k.name);
  const idx = getNarrativeIndex();
  const c = idx?.get(t.key);
  if (c?.kw.length) return c.kw.map((k) => idx!.kwName(k) ?? '').filter(Boolean);
  return t.completeness === 'full' ? [] : undefined;
}
const audCache = new WeakMap<TitleMeta, Map<string, AudienceProfile>>();
/** Público objetivo del título (memorizado por ficha y umbral). */
export function audienceOf(t: TitleMeta, threshold?: number): AudienceProfile {
  const th = threshold ?? 0.5;
  let m = audCache.get(t);
  if (!m) { m = new Map(); audCache.set(t, m); }
  const ck = `${th}|${audienceDataVersion() ?? ''}|${getNarrativeIndex() ? 1 : 0}`;
  let p = m.get(ck);
  if (!p) {
    const kw = t.keywords.length ? [] : keywordNames(t) ?? [];
    p = classifyAudience(t, kw, th);
    m.set(ck, p);
  }
  return p;
}
export function textContext(f: RankFilters): TextContext {
  return {
    kw: keywordNames,
    countries: (t) => countriesOf(t, f.countryField),
    regionCountries,
    audience: (t, id: AudienceId) => { const s = audienceOf(t, f.audience?.threshold).scores[id]; return s.status === 'unknown' || s.status === 'disabled' ? undefined : audienceMatch(s, f.audience?.uncertainAsMatch); },
    publicScore: (t) => (t.voteAverage && (t.voteCount ?? 0) >= 20 ? t.voteAverage : undefined),
  };
}

/**
 * v3.3: contradicciones entre el texto y el panel (o dentro del texto). No se resuelven en silencio: se muestran
 * antes de aplicar. Regla al aplicar igual: la exclusión manda y los rangos se intersecan (puede quedar vacío).
 */
export function contradictions(f: RankFilters, p?: ParsedText): string[] {
  const out: string[] = [];
  if (!p) return out;
  const types = p.include.filter((c) => c.k === 'type').map((c) => c.v as MediaType);
  if (new Set(types).size > 1) out.push('El texto pide películas y series a la vez: se aceptan ambas.');
  if (types.length === 1 && f.types.length === 1 && f.types[0] !== types[0]) out.push(`El panel pide ${f.types[0] === 'movie' ? 'películas' : 'series'} y el texto ${types[0] === 'movie' ? 'películas' : 'series'}: no puede haber resultados.`);
  const yMin = Math.max(f.yearMin ?? 0, ...p.include.filter((c) => c.k === 'yearMin').map((c) => c.v as number));
  const yMax = Math.min(f.yearMax ?? 9999, ...p.include.filter((c) => c.k === 'yearMax').map((c) => c.v as number));
  if (yMin > yMax) out.push(`Años imposibles: desde ${yMin} y hasta ${yMax}.`);
  for (const c of p.include) {
    if (c.k === 'genre' && c.v.every((g) => f.excludeGenres.includes(g))) out.push(`El texto pide «${c.name}» y el panel lo excluye: manda la exclusión.`);
    if (c.k === 'audience' && f.audience?.exclude.includes(c.v)) out.push(`El texto pide público «${audienceName(c.v)}» y el panel lo excluye: manda la exclusión.`);
    if (p.exclude.some((g) => g.length === 1 && g[0].k === c.k && JSON.stringify(g[0].v) === JSON.stringify(c.v))) out.push(`El texto incluye y excluye «${condLabel(c)}»: manda la exclusión.`);
  }
  const { inc, exc } = placeSets(f);
  const tInc = [...new Set(p.include.flatMap((c) => (c.k === 'country' ? [c.v] : c.k === 'region' ? regionCountries(c.v) : [])))];
  const tExc = [...new Set(p.exclude.filter((g) => g.length === 1).flatMap((g) => (g[0].k === 'country' ? [g[0].v as string] : g[0].k === 'region' ? regionCountries(g[0].v as RegionId) : [])))];
  if (tInc.length && tInc.every((c) => exc.includes(c) || tExc.includes(c))) out.push('Todos los países pedidos en el texto están excluidos: manda la exclusión.');
  if (inc.length && tInc.length && !tInc.some((c) => inc.includes(c))) out.push('Los países del texto y los del panel no se superponen: no puede haber resultados.');
  for (const g of p.exclude) if (g.length > 1) continue; else if (g[0]?.k === 'type' && types.includes(g[0].v as MediaType)) out.push(`El texto pide y excluye ${g[0].v === 'movie' ? 'películas' : 'series'}.`);
  return [...new Set(out)];
}
export { groupLabel };

/** v3.3: qué datos necesitan los filtros activos. */
export function smartNeeds(f: RankFilters) {
  const all = [...(f.text?.include ?? []), ...(f.text?.exclude.flat() ?? [])];
  const audience = Boolean(f.audience?.include.length || f.audience?.exclude.length || all.some((c) => c.k === 'audience'));
  return {
    audience,
    keywords: audience || all.some((c) => c.k === 'theme'),
    countries: Boolean(f.includeCountries?.length || f.excludeCountries?.length || f.includeRegions?.length || f.excludeRegions?.length || all.some((c) => c.k === 'region' || c.k === 'country')),
  };
}
export interface DataGaps { total: number; noCountries: number; noAudience: number; noKeywords: number }
/** Cuántos candidatos no tienen el dato que pide un filtro (ausencia de datos ≠ ausencia de coincidencia). */
export function dataGaps(cands: Candidate[], f: RankFilters): DataGaps | undefined {
  const n = smartNeeds(f);
  if (!n.audience && !n.keywords && !n.countries) return undefined;
  return {
    total: cands.length,
    noCountries: n.countries ? cands.filter((c) => !countriesOf(c.meta, f.countryField).length).length : 0,
    noAudience: n.audience ? cands.filter((c) => !audienceOf(c.meta, f.audience?.threshold).hasData).length : 0,
    noKeywords: n.keywords ? cands.filter((c) => keywordNames(c.meta) === undefined).length : 0,
  };
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
