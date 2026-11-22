import type { TitleMeta } from '../types';
import { keywordLabel, SPOILER_PATTERN } from './keywordsEs';

/** Vector disperso de características: nombre → peso */
export type FeatureVec = Map<string, number>;

/** Peso relativo de cada familia de características (ajustable). */
export const FAMILY_WEIGHT: Record<string, number> = {
  g: 1.0, // género / subgénero
  k: 0.9, // temáticas y elementos narrativos (palabras clave)
  d: 0.8, // dirección / creación
  c: 0.45, // reparto principal
  t: 0.3, // película o serie
  era: 0.25, // década
  len: 0.3, // duración (ritmo/compromiso)
  lang: 0.35, // idioma original
  seas: 0.25, // extensión de la serie (complejidad/compromiso)
  end: 0.5, // características del final derivadas de palabras clave de TMDB (nunca se muestran: spoilers)
};

/**
 * Características del final que TMDB publica como palabras clave (fuente verificable, curada por la
 * comunidad). Sólo se usan para aprender del aspecto «Final o desenlace» y nunca se muestran.
 * Si un título no tiene ninguna, ese componente simplemente no existe para él.
 */
export const ENDING_TRAITS: { id: string; pattern: RegExp }[] = [
  { id: 'twist', pattern: /plot twist|twist ending|surprise ending|shocking ending|unexpected ending|twist$/i },
  { id: 'open', pattern: /open ending|open-ended|inconclusive ending/i },
  { id: 'ambiguous', pattern: /ambiguous ending|ambiguity/i },
  { id: 'tragic', pattern: /tragic ending|sad ending|downer ending|unhappy ending/i },
  { id: 'happy', pattern: /happy ending|uplifting ending|feel-good ending/i },
  { id: 'bittersweet', pattern: /bittersweet/i },
  { id: 'cliffhanger', pattern: /cliffhanger/i },
  { id: 'emotional', pattern: /emotional ending|tearjerker|tear jerker/i },
];

export function endingTraits(t: Pick<TitleMeta, 'keywords'>): string[] {
  const out = new Set<string>();
  for (const k of t.keywords) for (const e of ENDING_TRAITS) if (e.pattern.test(k.name)) out.add(e.id);
  return [...out];
}

export const family = (f: string) => f.slice(0, f.indexOf(':'));

export interface FeatureInfo { label: string; family: string; spoiler: boolean }

/** Representación estructurada de un título. */
export function rawFeatures(t: TitleMeta): string[] {
  const fs = new Set<string>();
  for (const g of t.genres) fs.add(`g:${g.id}`);
  for (const k of t.keywords.slice(0, 25)) fs.add(`k:${k.id}`);
  for (const d of t.directors.slice(0, 3)) fs.add(`d:${d.id}`);
  for (const c of t.cast.slice(0, 5)) fs.add(`c:${c.id}`);
  for (const e of endingTraits(t)) fs.add(`end:${e}`);
  fs.add(`t:${t.type}`);
  if (t.year) fs.add(`era:${Math.floor(t.year / 10) * 10}`);
  if (t.runtime) {
    if (t.type === 'movie') fs.add(`len:${t.runtime < 95 ? 'corta' : t.runtime <= 135 ? 'media' : 'larga'}`);
    else fs.add(`len:${t.runtime < 35 ? 'episodios-cortos' : 'episodios-largos'}`);
  }
  if (t.type === 'tv' && t.numberOfSeasons) fs.add(`seas:${t.numberOfSeasons === 1 ? 'una' : t.numberOfSeasons <= 3 ? 'pocas' : 'muchas'}`);
  if (t.originalLanguage) fs.add(`lang:${t.originalLanguage}`);
  return [...fs];
}

const LANG: Record<string, string> = { en: 'inglés', es: 'español', ko: 'coreano', ja: 'japonés', fr: 'francés', de: 'alemán', it: 'italiano', pt: 'portugués', da: 'danés', sv: 'sueco', no: 'noruego', tr: 'turco', hi: 'hindi', zh: 'chino' };
const LEN: Record<string, string> = { corta: 'películas cortas', media: 'duración media', larga: 'películas largas', 'episodios-cortos': 'episodios cortos', 'episodios-largos': 'episodios largos' };
const SEAS: Record<string, string> = { una: 'series de una temporada', pocas: 'series de pocas temporadas', muchas: 'series largas' };

export function describeFeatures(titles: TitleMeta[]): Map<string, FeatureInfo> {
  const info = new Map<string, FeatureInfo>();
  for (const t of titles) {
    for (const g of t.genres) info.set(`g:${g.id}`, { label: g.name, family: 'g', spoiler: false });
    for (const k of t.keywords) info.set(`k:${k.id}`, { label: keywordLabel(k.name), family: 'k', spoiler: SPOILER_PATTERN.test(k.name) });
    for (const d of t.directors) info.set(`d:${d.id}`, { label: d.name, family: 'd', spoiler: false });
    for (const c of t.cast) info.set(`c:${c.id}`, { label: c.name, family: 'c', spoiler: false });
  }
  info.set('t:movie', { label: 'películas', family: 't', spoiler: false });
  info.set('t:tv', { label: 'series', family: 't', spoiler: false });
  return info;
}

export function featureLabel(f: string, info: Map<string, FeatureInfo>): string {
  const known = info.get(f);
  if (known) return known.label;
  const [fam, v] = [family(f), f.slice(f.indexOf(':') + 1)];
  if (fam === 'era') return `los ${v}`;
  if (fam === 'lang') return `idioma ${LANG[v] ?? v}`;
  if (fam === 'len') return LEN[v] ?? v;
  if (fam === 'seas') return SEAS[v] ?? v;
  return f;
}

/** IDF sobre el corpus conocido: rasgos muy comunes pesan menos. */
export function computeIdf(corpus: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const fs of corpus) for (const f of fs) df.set(f, (df.get(f) ?? 0) + 1);
  const n = Math.max(1, corpus.length);
  const idf = new Map<string, number>();
  for (const [f, c] of df) idf.set(f, Math.log(1 + n / c));
  return idf;
}

export function weightedVector(fs: string[], idf: Map<string, number>): FeatureVec {
  const v: FeatureVec = new Map();
  for (const f of fs) v.set(f, (FAMILY_WEIGHT[family(f)] ?? 0.3) * (idf.get(f) ?? 1));
  return v;
}

export function cosine(a: FeatureVec, b: FeatureVec): number {
  let dot = 0, na = 0, nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [f, x] of small) { const y = big.get(f); if (y) dot += x * y; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
