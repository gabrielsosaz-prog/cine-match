/**
 * Carga perezosa del catálogo narrativo precalculado (public/catalog/<versión>/).
 * Si no está disponible (sin conexión la primera vez, o en pruebas), el motor sigue funcionando
 * sin el componente semántico: los datos faltantes se tratan como desconocidos.
 */
import { NarrativeIndex, type CatalogMeta } from '../engine/narrative';
import type { TitleKey, TitleMeta } from '../types';

let current: NarrativeIndex | undefined;
let loading: Promise<NarrativeIndex | undefined> | undefined;
let lastError: string | undefined;

export interface CatalogManifest { version: string; meta: string; emb: string; titles: number; embedded: number; model: string; attractionFlags?: string }

async function fetchCatalog(): Promise<NarrativeIndex | undefined> {
  if (typeof fetch === 'undefined' || typeof location === 'undefined') return undefined;
  try {
    const man = (await (await fetch('catalog/manifest.json', { cache: 'no-cache' })).json()) as CatalogManifest;
    const [meta, emb] = await Promise.all([
      fetch(`catalog/${man.meta}`).then((r) => { if (!r.ok) throw new Error(`catálogo ${r.status}`); return r.json() as Promise<CatalogMeta>; }),
      fetch(`catalog/${man.emb}`).then((r) => { if (!r.ok) throw new Error(`vectores ${r.status}`); return r.arrayBuffer(); }),
    ]);
    lastError = undefined;
    return new NarrativeIndex(meta, new Int8Array(emb));
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return undefined;
  }
}

/** Devuelve el índice (cargándolo una vez). Nunca lanza. */
export function loadNarrativeIndex(): Promise<NarrativeIndex | undefined> {
  if (current) return Promise.resolve(current);
  loading ??= fetchCatalog().then((idx) => { current = idx; if (!idx) loading = undefined; return idx; });
  return loading;
}
export const getNarrativeIndex = () => current;
export const narrativeCatalogError = () => lastError;
/** Pruebas: inyectar un índice (o quitarlo). */
export function setNarrativeIndex(idx: NarrativeIndex | undefined) { current = idx; loading = undefined; }

/** Ficha básica a partir del catálogo (título en español, año, géneros, palabras clave, póster). */
export function metaFromCatalog(idx: NarrativeIndex, key: TitleKey, names: Map<number, string>): TitleMeta | undefined {
  const c = idx.get(key);
  if (!c) return undefined;
  const [type, id] = key.split(':');
  return {
    key, type: type as 'movie' | 'tv', tmdbId: Number(id), title: c.title, year: c.year, posterPath: c.poster ?? null,
    genres: c.genres.map((g) => ({ id: g, name: names.get(g) ?? `Género ${g}` })), keywords: c.kw.map((k) => ({ id: k, name: idx.kwName(k) ?? '' })),
    cast: [], directors: [], runtime: c.runtime, numberOfSeasons: c.seasons, originalLanguage: c.lang, originCountry: c.countries,
    voteAverage: c.vote, voteCount: c.votes, popularity: c.pop, collection: c.collection ? { id: c.collection, name: '' } : undefined,
    completeness: 'basic', missing: ['ficha completa'], source: 'Catálogo Cine Match (TMDB)', fetchedAt: Date.now(),
  };
}


// ── v4.0: marcas de categorías (Wikipedia) que usa el motor de atractivo ──
let flags: Map<TitleKey, Set<string>> | undefined;
let flagsLoading: Promise<Map<TitleKey, Set<string>>> | undefined;
/** Carga attraction-flags.json una vez. Sin conexión o sin archivo: mapa vacío (las reglas usan sólo palabras clave). */
export function loadAttractionFlags(): Promise<Map<TitleKey, Set<string>>> {
  if (flags) return Promise.resolve(flags);
  flagsLoading ??= (async () => {
    try {
      if (typeof fetch === 'undefined' || typeof location === 'undefined') return new Map();
      const man = (await (await fetch('catalog/manifest.json', { cache: 'no-cache' })).json()) as CatalogManifest;
      if (!man.attractionFlags) return new Map();
      const r = await fetch(`catalog/${man.attractionFlags}`);
      if (!r.ok) throw new Error(`marcas ${r.status}`);
      const d = (await r.json()) as { flags: Record<string, string[]> };
      flags = new Map(Object.entries(d.flags).map(([k, v]) => [k as TitleKey, new Set(v)]));
      return flags;
    } catch { flagsLoading = undefined; return new Map(); }
  })();
  return flagsLoading;
}
/** Pruebas: inyectar marcas. */
export function setAttractionFlags(f: Map<TitleKey, Set<string>> | undefined) { flags = f; flagsLoading = undefined; }
