/**
 * Público objetivo (v3.3): a quién está DIRIGIDA una obra, separado de la edad recomendada, la clasificación por
 * contenido, la edad de los protagonistas, el género y la popularidad entre grupos (de esto último no hay datos y no
 * se inventa).
 *
 * No hay en TMDB un campo «público objetivo». Se combinan señales verificables con reglas fijas (versión AUDIENCE_RULES):
 *  - Explícitas (etiquetas editoriales/comunitarias de TMDB): género «Familia» (10751) o «Infantil» (10762, series);
 *    palabras clave que nombran el tipo de obra por su público: «teen movie», «teen drama», «teen comedy»,
 *    «young adult», «based on young adult novel», «kids», «adult animation»…
 *  - Auxiliares: clasificación por edad oficial (EE. UU., y AR/MX/ES si falta). Sólo suma o resta, nunca decide sola:
 *    «R» dice que no es para menores, no que sea «para adultos» como público buscado.
 *  - Protagonistas o ambiente («high school», «teenager», «coming of age»): pesan poco y nunca alcanzan solas el
 *    umbral. Una serie con adolescentes y clasificación para adultos (p. ej. TV-MA) queda incierta, no «adolescente».
 *  - Inferidas: similitud semántica de la sinopsis+argumento con descripciones prototipo (vectores del catálogo).
 * Masculino/femenino: TMDB no tiene evidencia editorial ni demográfica; inferirlo de protagonistas o del género sería
 * un estereotipo. Quedan DESHABILITADAS (siempre «desconocido»).
 *
 * Cada resultado trae categoría, confianza (0-1), fuentes, método y versión. La confianza es una puntuación de
 * evidencia, no una probabilidad calibrada: no se midió su precisión con datos etiquetados por terceros.
 */
import type { TitleKey, TitleMeta } from '../types';

/**
 * v3.4 → 'público-1.1': clasificación «todo público» (G, ATP, Ai, AA…) + animación pasa de 0,3 a 0,55 hacia Infantil.
 * Motivo: TMDB no tiene género «Infantil» para películas, y Toy Story, Frozen o Buscando a Nemo quedaban inciertas.
 * Decidido con el conjunto de desarrollo y confirmado en el de evaluación contra categorías de Wikipedia
 * (docs/audience-validation.md): F1 de Infantil 0,60 → 0,72, precisión sin cambios.
 */
export const AUDIENCE_RULES = 'público-1.1';
export type AudienceId = 'kids' | 'teen' | 'adult' | 'family' | 'male' | 'female';
export const AUDIENCES: { id: AudienceId; name: string; enabled: boolean; note?: string }[] = [
  { id: 'kids', name: 'Infantil', enabled: true },
  { id: 'teen', name: 'Adolescente / juvenil', enabled: true },
  { id: 'adult', name: 'Adulto', enabled: true },
  { id: 'family', name: 'Familiar / público general', enabled: true },
  { id: 'male', name: 'Orientación predominantemente masculina', enabled: false, note: 'Deshabilitada: no hay evidencia editorial ni demográfica verificable; no se infiere de estereotipos.' },
  { id: 'female', name: 'Orientación predominantemente femenina', enabled: false, note: 'Deshabilitada: no hay evidencia editorial ni demográfica verificable; no se infiere de estereotipos.' },
];
export const audienceName = (id: AudienceId) => AUDIENCES.find((a) => a.id === id)?.name ?? id;

export type EvidenceMethod = 'explícita' | 'auxiliar' | 'protagonistas/ambiente' | 'inferida' | 'en contra';
export interface AudienceEvidence { source: string; method: EvidenceMethod; detail: string }
export type AudienceStatus = 'yes' | 'uncertain' | 'no-evidence' | 'unknown' | 'disabled';
export interface AudienceScore { id: AudienceId; confidence: number; status: AudienceStatus; evidence: AudienceEvidence[]; explicit: boolean }
export interface AudienceProfile { key: TitleKey; scores: Record<AudienceId, AudienceScore>; version: string; hasData: boolean }

/** Señales del catálogo (scripts/catalog/audience.mjs): [key, certs, zKids, zTeen, zFamily, zAdult] */
export interface AudienceData { version: string; catalog: string; model: string; entries: [string, Record<string, string>, number | null, number | null, number | null, number | null][] }
export interface CatalogSignals { certs: Record<string, string>; z: { kids: number | null; teen: number | null; family: number | null; adult: number | null } }

let data: Map<string, CatalogSignals> | undefined;
let dataVersion: string | undefined;
let loading: Promise<void> | undefined;
export function setAudienceData(d: AudienceData | undefined) {
  data = d ? new Map(d.entries.map(([k, c, a, b, f, ad]) => [k, { certs: c, z: { kids: a, teen: b, family: f, adult: ad } }])) : undefined;
  dataVersion = d?.version;
}
/** Carga perezosa del archivo de señales (no bloquea el inicio; si falla, se clasifica sin él). */
export function loadAudienceData(): Promise<void> {
  if (data || typeof fetch === 'undefined' || typeof location === 'undefined') return Promise.resolve();
  loading ??= (async () => {
    try {
      const man = await (await fetch('catalog/manifest.json', { cache: 'no-cache' })).json();
      if (!man.audience) return;
      const r = await fetch(`catalog/${man.audience}`);
      if (r.ok) setAudienceData(await r.json());
    } catch { /* sin señales del catálogo */ } finally { loading = undefined; }
  })();
  return loading;
}
export const audienceDataVersion = () => dataVersion;
export const catalogSignals = (k: string) => data?.get(k);

// «young adult» NO está aquí: en TMDB suele describir personajes de veintitantos (p. ej. Friends), no el público
const TEEN_KW = new Set(['teen movie', 'teen drama', 'teen comedy', 'teen horror', 'teen fantasy', 'teen superhero', 'teen adventure', 'teenage romance', 'teen romance', 'based on young adult novel', 'lgbt teen', 'teen sex comedy', 'teen slasher', 'teen musical', 'teen series']);
const TEEN_SETTING_KW = new Set(['high school', 'teenager', 'teenage girl', 'teenage boy', 'coming of age', 'high school student', 'teenage protagonist', 'adolescence', 'japanese high school', 'teenage crush', 'teenage love', 'high school sports', 'youth', 'prom', 'high school dance', 'young adult',
  'teenage life', 'teenage friendship', 'teenage sexuality', 'teenage hero', 'high school romance', 'high school rivalry', 'teen angst', 'teenage rebellion', 'pre-teen', 'trans youth']);
const KIDS_KW = new Set(['kids', "children's series", 'preschool', 'for kids', "children's film", "children's adventure"]);
const KIDS_WEAK_KW = new Set(["based on children's book", 'cartoon']);
const ADULT_KW = new Set(['adult animation']);
const ADULT_WEAK_KW = new Set(['erotic thriller', 'eroticism', 'sex', 'nudity', 'graphic violence', 'erotic movie']);

const RATINGS = {
  kidsTarget: new Set(['TV-Y', 'TV-Y7', 'TV-Y7-FV']),
  general: new Set(['G', 'TV-G', 'ATP', 'A', 'APT', 'APTA', 'AI', 'AA', 'TP']),
  pg: new Set(['PG', 'TV-PG', '7', '+7', 'B']),
  teen: new Set(['PG-13', 'TV-14', '13', '+13', '12', 'B-15', '14', 'SAM 13']),
  adult: new Set(['R', 'NC-17', 'TV-MA', '18', '+18', 'SAM 18', 'C', 'D']),
};
type Rate = keyof typeof RATINGS;
function rating(certs?: Record<string, string>): { code: string; region: string; kind: Rate } | undefined {
  for (const region of ['US', 'AR', 'MX', 'ES']) {
    const code = certs?.[region];
    if (!code) continue;
    const c = code.toUpperCase();
    for (const kind of ['kidsTarget', 'general', 'pg', 'teen', 'adult'] as Rate[]) if (RATINGS[kind].has(c)) return { code, region, kind };
  }
  return undefined;
}

const noisyOr = (ps: number[]) => 1 - ps.reduce((a, p) => a * (1 - p), 1);
/**
 * Similitud semántica: evaluada con 36 títulos conocidos (docs/audience-report.md) y NO es confiable para público
 * (p. ej. Bluey z 0,6 con el prototipo infantil; Padre de familia z 3,0). Se muestra como evidencia, pero no suma.
 */
const SEM_Z = 2.3;
const SEM_W = 0;

export interface AudienceOptions { threshold?: number }
export const DEFAULT_THRESHOLD = 0.5;

/** Clasifica un título. `kwNames` se toman de la ficha o, si no hay, del catálogo. */
export function classifyAudience(meta: Pick<TitleMeta, 'key' | 'genres' | 'keywords' | 'certifications' | 'type'>, extraKeywords: string[] = [], threshold = DEFAULT_THRESHOLD): AudienceProfile {
  const sig = catalogSignals(meta.key);
  const certs = meta.certifications && Object.keys(meta.certifications).length ? meta.certifications : sig?.certs;
  const kw = [...new Set([...meta.keywords.map((k) => k.name.toLowerCase()), ...extraKeywords.map((s) => s.toLowerCase())])].filter(Boolean);
  const g = new Set(meta.genres.map((x) => x.id));
  const r = rating(certs);
  const z = sig?.z;
  const hasData = kw.length > 0 || Boolean(r) || (z?.teen ?? null) !== null;
  const certEv = r ? `clasificación ${r.code} (${r.region})` : '';
  const out = {} as Record<AudienceId, AudienceScore>;
  const finish = (id: AudienceId, pos: { p: number; ev: AudienceEvidence }[], factors: { f: number; ev: AudienceEvidence }[]) => {
    let c = noisyOr(pos.map((x) => x.p));
    for (const x of factors) c *= x.f;
    c = Math.round(Math.min(0.95, c) * 100) / 100;
    const explicit = pos.some((x) => x.ev.method === 'explícita');
    const status: AudienceStatus = !hasData ? 'unknown' : c >= threshold ? 'yes' : c >= 0.2 ? 'uncertain' : 'no-evidence';
    out[id] = { id, confidence: c, status, explicit, evidence: [...pos.map((x) => x.ev), ...factors.map((x) => x.ev)] };
  };
  const kwHits = (set: Set<string>) => kw.filter((n) => set.has(n));
  const TMDB_KW = 'palabras clave de TMDB';
  const TMDB_G = 'géneros de TMDB';
  const CERT = 'clasificación por edad (TMDB)';
  const SEM = `similitud semántica (catálogo ${sig ? dataVersion ?? '' : ''})`.replace(' ()', '');

  // Infantil
  {
    const pos: { p: number; ev: AudienceEvidence }[] = [];
    const fac: { f: number; ev: AudienceEvidence }[] = [];
    if (g.has(10762)) pos.push({ p: 0.85, ev: { source: TMDB_G, method: 'explícita', detail: 'género «Infantil» (Kids)' } });
    for (const h of kwHits(KIDS_KW)) pos.push({ p: 0.4, ev: { source: TMDB_KW, method: 'explícita', detail: `«${h}»` } });
    for (const h of kwHits(KIDS_WEAK_KW)) pos.push({ p: 0.15, ev: { source: TMDB_KW, method: 'inferida', detail: `«${h}» (no indica por sí solo el público)` } });
    if (r?.kind === 'kidsTarget') pos.push({ p: 0.7, ev: { source: CERT, method: 'auxiliar', detail: `${certEv}: diseñada para niños` } });
    if (r?.kind === 'general' && g.has(16)) pos.push({ p: 0.55, ev: { source: CERT, method: 'auxiliar', detail: `${certEv} + animación` } });
    if ((z?.kids ?? 0) >= SEM_Z) pos.push({ p: SEM_W, ev: { source: SEM, method: 'inferida', detail: `sinopsis parecida a obras infantiles (z ${z!.kids}) — no suma: método no confiable` } });
    if (r && (r.kind === 'adult' || r.kind === 'teen')) fac.push({ f: 0.1, ev: { source: CERT, method: 'en contra', detail: `${certEv}: no apta para niños` } });
    if (kwHits(ADULT_KW).length) fac.push({ f: 0.05, ev: { source: TMDB_KW, method: 'en contra', detail: '«adult animation»' } });
    finish('kids', pos, fac);
  }
  // Familiar / público general
  {
    const pos: { p: number; ev: AudienceEvidence }[] = [];
    const fac: { f: number; ev: AudienceEvidence }[] = [];
    if (g.has(10751)) pos.push({ p: 0.7, ev: { source: TMDB_G, method: 'explícita', detail: 'género «Familia»' } });
    if (r?.kind === 'general') pos.push({ p: 0.35, ev: { source: CERT, method: 'auxiliar', detail: `${certEv}: apta para todo público` } });
    if (r?.kind === 'pg' && g.has(16)) pos.push({ p: 0.25, ev: { source: CERT, method: 'auxiliar', detail: `${certEv} + animación` } });
    if ((z?.family ?? 0) >= SEM_Z) pos.push({ p: SEM_W, ev: { source: SEM, method: 'inferida', detail: `sinopsis parecida a obras familiares (z ${z!.family}) — no suma: método no confiable` } });
    if (r?.kind === 'adult') fac.push({ f: 0.1, ev: { source: CERT, method: 'en contra', detail: `${certEv}: sólo adultos` } });
    if (kwHits(ADULT_KW).length) fac.push({ f: 0.05, ev: { source: TMDB_KW, method: 'en contra', detail: '«adult animation»' } });
    finish('family', pos, fac);
  }
  // Adolescente / juvenil
  {
    const pos: { p: number; ev: AudienceEvidence }[] = [];
    const fac: { f: number; ev: AudienceEvidence }[] = [];
    for (const h of kwHits(TEEN_KW)) pos.push({ p: 0.55, ev: { source: TMDB_KW, method: 'explícita', detail: `«${h}»` } });
    const setting = kwHits(TEEN_SETTING_KW);
    if (setting.length) pos.push({ p: Math.min(0.3, 0.12 * setting.length), ev: { source: TMDB_KW, method: 'protagonistas/ambiente', detail: `${setting.map((s) => `«${s}»`).join(', ')}: habla de adolescentes, no indica a quién va dirigida` } });
    if (r?.kind === 'teen' && pos.length) pos.push({ p: 0.15, ev: { source: CERT, method: 'auxiliar', detail: `${certEv}: apta para adolescentes` } });
    if ((z?.teen ?? 0) >= SEM_Z) pos.push({ p: SEM_W, ev: { source: SEM, method: 'inferida', detail: `sinopsis parecida a obras juveniles (z ${z!.teen}) — no suma: método no confiable` } });
    if (r?.kind === 'adult') fac.push({ f: 0.55, ev: { source: CERT, method: 'en contra', detail: `${certEv}: para adultos; puede tener protagonistas adolescentes sin estar dirigida a ese público` } });
    if (g.has(10762)) fac.push({ f: 0.5, ev: { source: TMDB_G, method: 'en contra', detail: 'género «Infantil»' } });
    finish('teen', pos, fac);
  }
  // Adulto
  {
    const pos: { p: number; ev: AudienceEvidence }[] = [];
    const fac: { f: number; ev: AudienceEvidence }[] = [];
    for (const h of kwHits(ADULT_KW)) pos.push({ p: 0.8, ev: { source: TMDB_KW, method: 'explícita', detail: `«${h}»` } });
    for (const h of kwHits(ADULT_WEAK_KW)) pos.push({ p: 0.3, ev: { source: TMDB_KW, method: 'inferida', detail: `«${h}»` } });
    if (r?.kind === 'adult') pos.push({ p: 0.6, ev: { source: CERT, method: 'auxiliar', detail: `${certEv}: restringida a adultos` } });
    if ((z?.adult ?? 0) >= SEM_Z) pos.push({ p: SEM_W, ev: { source: SEM, method: 'inferida', detail: `sinopsis parecida a obras para adultos (z ${z!.adult}) — no suma: método no confiable` } });
    if (g.has(10762) || g.has(10751)) fac.push({ f: 0.3, ev: { source: TMDB_G, method: 'en contra', detail: g.has(10762) ? 'género «Infantil»' : 'género «Familia»' } });
    if (r && (r.kind === 'general' || r.kind === 'kidsTarget' || r.kind === 'pg')) fac.push({ f: 0.3, ev: { source: CERT, method: 'en contra', detail: `${certEv}` } });
    finish('adult', pos, fac);
  }
  for (const id of ['male', 'female'] as const) out[id] = { id, confidence: 0, status: 'disabled', explicit: false, evidence: [{ source: '—', method: 'inferida', detail: 'sin evidencia verificable: categoría deshabilitada' }] };
  return { key: meta.key, scores: out, version: `${AUDIENCE_RULES}${dataVersion ? ` · señales ${dataVersion}` : ''}`, hasData };
}

/** ¿Cuenta como coincidencia con la categoría? */
export const audienceMatch = (s: AudienceScore, uncertainAsMatch = false) => s.status === 'yes' || (uncertainAsMatch && s.status === 'uncertain');

export interface AudienceFilter { include: AudienceId[]; exclude: AudienceId[]; threshold?: number; uncertainAsMatch?: boolean }
/**
 * Regla: incluir = al menos una de las categorías incluidas con evidencia suficiente (sin datos → no pasa);
 * excluir = se quita si alguna categoría excluida tiene evidencia suficiente (sin datos o incierta → se mantiene,
 * salvo que se elija contar las inciertas). La exclusión manda.
 */
export function matchesAudience(p: AudienceProfile, f: AudienceFilter): boolean {
  const u = f.uncertainAsMatch ?? false;
  const inc = f.include.filter((id) => AUDIENCES.find((a) => a.id === id)?.enabled);
  const exc = f.exclude.filter((id) => AUDIENCES.find((a) => a.id === id)?.enabled);
  if (exc.some((id) => audienceMatch(p.scores[id], u))) return false;
  if (inc.length && !inc.some((id) => audienceMatch(p.scores[id], u))) return false;
  return true;
}
