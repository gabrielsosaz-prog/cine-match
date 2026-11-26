/**
 * v4.0 · Motor «Atractivo personalizado» (experimental).
 *
 * Reproduce EXACTAMENTE el método «atractivo puro» que ganó la segunda cata a ciegas (6 de 7 títulos no vistos con
 * «Me interesa» o más). No se cambiaron pesos ni se agregaron optimizaciones. El método:
 *
 *   orden = A + 0,3 · S
 *   A (atractivo previo) = 6 · E + reglas (las positivas suman como máximo +1,4)
 *     E = parecido semántico (catálogo narrativo) a lo que te atrae menos parecido a lo que te aleja:
 *         promedio de los 4 mayores (coseno × peso) contra cada conjunto.
 *         Atrae: notas ≥ 8 (1), «Muchas ganas»/«Me interesa» (1), «Podría interesarme» (0,5), vistas con nota ≥ 8
 *         (1), títulos de referencia del perfil (1,5). Aleja: «No me interesa» (1), notas ≤ 5 (0,5), vistas con nota
 *         ≤ 5 (0,5).
 *     reglas = preferencias del perfil de gustos (antigüedad, duración, formato, géneros, rasgos narrativos).
 *   S (satisfacción estimada) = tu media + 0,5 · (calidad pública bayesiana − 6,8) + rasgos (giros, ritmo).
 *   Una sola entrega por saga. Sin reordenamiento por diversidad (el prototipo no lo tenía).
 *
 * A NO es una probabilidad: es un puntaje relativo para ordenar. S tiene fiabilidad baja hasta que haya notas
 * posteriores de títulos recomendados por este motor.
 */
import type { CatalogTitle, NarrativeIndex } from './narrative';
import type { InterestAnswer, InterestRecord, Rating, TasteProfile, TasteLevel, TitleKey } from '../types';

export const ATTRACTION_ENGINE_VERSION = 'attraction-4.0.0';
export const ATTRACTION_PARAMS = { embWeight: 6, topK: 4, positiveCap: 1.4, satisfactionWeight: 0.3, minVotes: 80, anchorWeight: 1.5 };

/** Categorías de Wikipedia (normalizadas) que usa el prototipo; se precalculan en attraction-flags.json. */
export const ATTRACTION_TAG_FLAGS: Record<string, RegExp> = {
  superhero: /superhero|marvel|dc comics/,
  spaceOpera: /space opera|star wars/,
  epicFantasy: /epic fantasy|high fantasy|sword and sorcery/,
  war: /war films|world war/,
  procedural: /procedural/,
  plausibleScifi: /dystopian|artificial intelligence|simulated reality/,
};

// ───────── Preferencias del perfil de gustos ─────────
/**
 * Cada preferencia corresponde a una regla del prototipo, con su peso original. Niveles:
 *  - 'off': no se aplica;
 *  - 'on': preferencia FLEXIBLE (suma o resta el peso del prototipo; nunca quita títulos);
 *  - 'strict': EXCLUSIÓN estricta (sólo en las que alejan; quita los títulos que la cumplen). Nunca se activa sola.
 */
export type PrefId =
  | 'modern' | 'shortMovies' | 'shortSeries' | 'noProcedural' | 'noWar' | 'noAnimation' | 'noKids' | 'noSuperhero'
  | 'noSpaceOpera' | 'noEpicFantasy' | 'noSlowFantasy' | 'noTeen' | 'twists' | 'psychThriller' | 'serialMystery'
  | 'investigation' | 'plausibleScifi' | 'emotionalTime' | 'moralDescent' | 'horror' | 'fastPace' | 'noSlowPace';
export interface PrefDef { id: PrefId; label: string; detail: string; kind: 'avoid' | 'like'; group: string; strictLabel?: string; source?: string }
export const PREFS: PrefDef[] = [
  { id: 'modern', label: 'Prefiero títulos modernos', detail: 'Antes de 1990 −1,5 · años 90 −0,8 · años 2000 −0,3 · desde 2015 +0,2', kind: 'avoid', group: 'Época y duración', strictLabel: 'Excluir lo anterior al 2000', source: 'q01, q02, q28' },
  { id: 'shortMovies', label: 'Películas no muy largas', detail: 'Más de 2 h 30 −1 · más de 2 h 10 −0,5 · hasta 1 h 50 +0,2', kind: 'avoid', group: 'Época y duración', strictLabel: 'Excluir películas de más de 2 h 30', source: 'q14' },
  { id: 'shortSeries', label: 'Series de pocas temporadas', detail: '9 o más −1 · 6 a 8 −0,6 · 2 o 3 temporadas +0,4', kind: 'avoid', group: 'Época y duración', strictLabel: 'Excluir series de 6 o más temporadas', source: 'q15, q24' },
  { id: 'noProcedural', label: 'Evitar series de un caso por capítulo', detail: 'Procedimentales −1', kind: 'avoid', group: 'Formato y géneros', strictLabel: 'Excluir procedimentales', source: 'q05' },
  { id: 'noWar', label: 'Evitar películas de guerra', detail: 'Bélicas −1,2', kind: 'avoid', group: 'Formato y géneros', strictLabel: 'Excluir guerra', source: 'q03' },
  { id: 'noAnimation', label: 'Evitar animación', detail: 'Animación −1,5', kind: 'avoid', group: 'Formato y géneros', strictLabel: 'Excluir animación', source: 'q04' },
  { id: 'noKids', label: 'Evitar lo familiar o infantil', detail: 'Familiar o infantil −1', kind: 'avoid', group: 'Formato y géneros', strictLabel: 'Excluir familiar e infantil', source: 'descartes' },
  { id: 'noSuperhero', label: 'Evitar superhéroes', detail: 'Superhéroes o cómic −2', kind: 'avoid', group: 'Formato y géneros', strictLabel: 'Excluir superhéroes', source: 'descartes' },
  { id: 'noSpaceOpera', label: 'Evitar ópera espacial', detail: 'Space opera −1,5', kind: 'avoid', group: 'Formato y géneros', strictLabel: 'Excluir ópera espacial', source: 'descartes' },
  { id: 'noEpicFantasy', label: 'Evitar fantasía épica', detail: 'Fantasía épica −1,2', kind: 'avoid', group: 'Formato y géneros', strictLabel: 'Excluir fantasía épica', source: 'descartes' },
  { id: 'noSlowFantasy', label: 'Evitar fantasía lenta', detail: 'Fantasía con ritmo lento −0,8', kind: 'avoid', group: 'Formato y géneros', strictLabel: 'Excluir fantasía lenta', source: 'q26' },
  { id: 'noTeen', label: 'Evitar historias adolescentes', detail: 'Adolescentes −0,6', kind: 'avoid', group: 'Formato y géneros', strictLabel: 'Excluir historias adolescentes', source: 'q27' },
  { id: 'twists', label: 'Giros y rompecabezas', detail: '+0,8', kind: 'like', group: 'Lo que me atrae', source: 'q23' },
  { id: 'psychThriller', label: 'Thriller psicológico', detail: '+0,6', kind: 'like', group: 'Lo que me atrae', source: 'q13' },
  { id: 'serialMystery', label: 'Series de misterio con una sola trama', detail: '+0,5', kind: 'like', group: 'Lo que me atrae', source: 'q11' },
  { id: 'investigation', label: 'Investigaciones obsesivas (películas)', detail: '+0,3', kind: 'like', group: 'Lo que me atrae', source: 'q06' },
  { id: 'plausibleScifi', label: 'Ciencia ficción que se siente posible', detail: '+0,8', kind: 'like', group: 'Lo que me atrae', source: 'q09, q26' },
  { id: 'emotionalTime', label: 'Viajes en el tiempo con corazón', detail: '+0,6', kind: 'like', group: 'Lo que me atrae', source: 'q07' },
  { id: 'moralDescent', label: 'Descenso moral de una persona común', detail: '+0,5', kind: 'like', group: 'Lo que me atrae', source: 'q08' },
  { id: 'horror', label: 'Terror', detail: '+0,2', kind: 'like', group: 'Lo que me atrae', source: 'q21' },
  { id: 'fastPace', label: 'Ritmo ágil', detail: '+0,3', kind: 'like', group: 'Ritmo', source: 'q23' },
  { id: 'noSlowPace', label: 'Evitar ritmo lento', detail: 'Ritmo lento −0,3', kind: 'avoid', group: 'Ritmo', strictLabel: 'Excluir ritmo lento', source: 'q16' },
];
export const PREF = new Map(PREFS.map((p) => [p.id, p]));
/** Perfil neutro (nuevo usuario): ninguna preferencia aplicada. Las del dueño se importan desde un archivo privado. */
export function emptyTasteProfile(profileId: string): TasteProfile {
  return { profileId, version: 1, prefs: {}, anchors: [], notes: [], updatedAt: 0 };
}

// ───────── Reglas ─────────
export interface RuleHit { pref: PrefId; w: number; label: string }
const kwSet = (idx: NarrativeIndex, c: CatalogTitle) => c.kw.map((id) => (idx.kwName(id) ?? '').toLowerCase());
const has = (xs: Iterable<string>, re: RegExp) => { for (const x of xs) if (re.test(x)) return true; return false; };
const facetMap = (c: CatalogTitle) => new Map<string, number>(c.facets.map((f) => [f[0], f[1]]));

/** Reglas del prototipo (mismo orden, mismas condiciones, mismos pesos) filtradas por las preferencias activas. */
export function ruleHits(idx: NarrativeIndex, c: CatalogTitle, flags: Set<string>, prefs: Partial<Record<PrefId, TasteLevel>>): { hits: RuleHit[]; excludedBy?: PrefId } {
  const kw = kwSet(idx, c), g = new Set(c.genres), fc = facetMap(c);
  const tv = c.key.startsWith('tv:'), y = c.year ?? 2000;
  const hits: RuleHit[] = [];
  let excludedBy: PrefId | undefined;
  const on = (p: PrefId) => (prefs[p] ?? 'off') !== 'off';
  const add = (p: PrefId, w: number, label: string) => { if (on(p)) hits.push({ pref: p, w, label }); };
  const strict = (p: PrefId, cond: boolean) => { if (cond && prefs[p] === 'strict' && !excludedBy) excludedBy = p; };
  if (y < 1990) add('modern', -1.5, 'anterior a 1990'); else if (y < 2000) add('modern', -0.8, 'de los años 90'); else if (y < 2010) add('modern', -0.3, 'de los años 2000'); else if (y >= 2015) add('modern', 0.2, 'reciente');
  strict('modern', y < 2000);
  if (!tv && c.runtime) { if (c.runtime > 150) add('shortMovies', -1.0, 'dura más de 2 h 30'); else if (c.runtime > 130) add('shortMovies', -0.5, 'dura más de 2 h 10'); else if (c.runtime <= 110) add('shortMovies', 0.2, 'corta'); }
  strict('shortMovies', !tv && (c.runtime ?? 0) > 150);
  if (tv) { const s = c.seasons ?? 1; if (s >= 9) add('shortSeries', -1.0, `${s} temporadas`); else if (s >= 6) add('shortSeries', -0.6, `${s} temporadas`); else if (s >= 2 && s <= 3) add('shortSeries', 0.4, `${s} temporadas`); }
  strict('shortSeries', tv && (c.seasons ?? 1) >= 6);
  const procedural = tv && (has(kw, /procedural|case of the week/) || flags.has('procedural'));
  if (procedural) add('noProcedural', -1.0, 'un caso por capítulo'); strict('noProcedural', procedural);
  const war = g.has(10752) || has(kw, /^(world war (i|ii)|war|battlefield|soldier)$/) || flags.has('war');
  if (war) add('noWar', -1.2, 'guerra'); strict('noWar', war);
  if (g.has(16)) add('noAnimation', -1.5, 'animación'); strict('noAnimation', g.has(16));
  const kids = g.has(10751) || g.has(10762);
  if (kids) add('noKids', -1.0, 'familiar o infantil'); strict('noKids', kids);
  const hero = has(kw, /superhero|based on comic|marvel cinematic universe|dc extended universe/) || flags.has('superhero');
  if (hero) add('noSuperhero', -2.0, 'superhéroes'); strict('noSuperhero', hero);
  const space = has(kw, /space opera/) || flags.has('spaceOpera');
  if (space) add('noSpaceOpera', -1.5, 'ópera espacial'); strict('noSpaceOpera', space);
  const epic = flags.has('epicFantasy') || has(kw, /epic fantasy|high fantasy|sword and sorcery/);
  if (epic) add('noEpicFantasy', -1.2, 'fantasía épica'); strict('noEpicFantasy', epic);
  const slowFantasy = (g.has(14) || g.has(10765)) && (fc.get('pace.slow-burn') ?? 0) > 0.3;
  if (slowFantasy) add('noSlowFantasy', -0.8, 'fantasía de ritmo lento'); strict('noSlowFantasy', slowFantasy);
  const teen = has(kw, /high school|teenager|teen drama|teen/) || (fc.get('th.coming-of-age') ?? 0) > 0.5;
  if (teen) add('noTeen', -0.6, 'historia adolescente'); strict('noTeen', teen);
  if ((fc.get('cx.puzzle') ?? 0) > 0.4 || has(kw, /plot twist|twist ending|unreliable narrator/)) add('twists', 0.8, 'giros o rompecabezas');
  if ((fc.get('mys.psych') ?? 0) > 0.4 || has(kw, /psychological thriller/)) add('psychThriller', 0.6, 'thriller psicológico');
  if (tv && (fc.get('mys.missing') ?? 0) > 0.4) add('serialMystery', 0.5, 'misterio con una sola trama');
  if (!tv && (fc.get('mys.investigation') ?? 0) > 0.5) add('investigation', 0.3, 'investigación obsesiva');
  if (has(kw, /simulated reality|artificial intelligence|memory|near future|dystopia|surveillance|virtual reality|cloning|mind control/) || flags.has('plausibleScifi')) add('plausibleScifi', 0.8, 'ciencia ficción que se siente posible');
  if (has(kw, /time travel|time loop|time paradox|alternate timeline/) && (g.has(18) || g.has(10749))) add('emotionalTime', 0.6, 'tiempo con corazón');
  if (has(kw, /money laundering|drug (dealer|cartel|trade|lord)|antihero|moral ambiguity|double life/)) add('moralDescent', 0.5, 'descenso moral');
  if (g.has(27)) add('horror', 0.2, 'terror');
  if ((fc.get('pace.fast') ?? 0) > 0.4) add('fastPace', 0.3, 'ritmo ágil');
  const slow = (fc.get('pace.slow-burn') ?? 0) > 0.5;
  if (slow) add('noSlowPace', -0.3, 'ritmo lento'); strict('noSlowPace', slow);
  return { hits, excludedBy };
}
/** Suma de reglas con tope a las positivas (prototipo: capRules). */
export function capRules(hits: RuleHit[]) {
  let pos = 0, neg = 0;
  for (const h of hits) { if (h.w > 0) pos += h.w; else neg += h.w; }
  return Math.min(pos, ATTRACTION_PARAMS.positiveCap) + neg;
}

// ───────── Parecido semántico ─────────
const ANSWER_WEIGHT: Partial<Record<InterestAnswer, number>> = { mucho: 1, si: 1, quiza: 0.5, no: -1 };
interface Anchor { row: number; w: number }
export interface AttractionSets { pos: Anchor[]; neg: Anchor[] }
/**
 * Conjuntos de referencia: notas, descartes, respuestas de interés, vistas con nota y títulos de referencia del perfil.
 * Una respuesta «Ya la vi» con nota se usa sólo si ese título no tiene una valoración propia (no se cuenta dos veces).
 */
export function attractionSets(idx: NarrativeIndex, ratings: Rating[], interests: InterestRecord[], taste: TasteProfile): AttractionSets {
  const pos: Anchor[] = [], neg: Anchor[] = [];
  const row = (k: TitleKey) => idx.get(k)?.row ?? -1;
  const P = (k: TitleKey, w: number) => { const r = row(k); if (r >= 0) pos.push({ row: r, w }); };
  const N = (k: TitleKey, w: number) => { const r = row(k); if (r >= 0) neg.push({ row: r, w }); };
  const ratedKeys = new Set<TitleKey>();
  for (const r of ratings) {
    if (r.notInterested) { N(r.key, 1); continue; }
    if (r.overall === undefined || r.overall === null) continue;
    ratedKeys.add(r.key);
    if (r.overall >= 8) P(r.key, 1); else if (r.overall <= 5) N(r.key, 0.5);
  }
  const discarded = new Set(ratings.filter((r) => r.notInterested).map((r) => r.key));
  for (const it of latestInterests(interests).values()) {
    if (ratedKeys.has(it.key) || discarded.has(it.key)) continue;
    if (it.answer === 'visto') { if (it.seenRating !== undefined) { if (it.seenRating >= 8) P(it.key, 1); else if (it.seenRating <= 5) N(it.key, 0.5); } continue; }
    const w = ANSWER_WEIGHT[it.answer];
    if (w === undefined) continue;
    if (w > 0) P(it.key, w); else N(it.key, -w);
  }
  for (const k of taste.anchors) P(k, ATTRACTION_PARAMS.anchorWeight);
  return { pos, neg };
}
/** Última respuesta por título (las respuestas se guardan como historial; vale la más reciente). */
export function latestInterests(interests: InterestRecord[]): Map<TitleKey, InterestRecord> {
  const m = new Map<TitleKey, InterestRecord>();
  for (const it of [...interests].sort((a, b) => a.at - b.at)) m.set(it.key, it);
  return m;
}
/** Normas de los vectores int8 del catálogo: el prototipo normaliza cada vector antes del coseno (exactitud). */
const normCache = new WeakMap<NarrativeIndex, Float32Array>();
function norms(idx: NarrativeIndex): Float32Array {
  let n = normCache.get(idx);
  if (!n) {
    const e = idx.emb!, d = idx.meta.dim, rows = Math.floor(e.length / d);
    n = new Float32Array(rows);
    for (let r = 0; r < rows; r++) { let s = 0; for (let i = 0; i < d; i++) { const x = e[r * d + i] / 127; s += x * x; } n[r] = Math.sqrt(s) || 1; }
    normCache.set(idx, n);
  }
  return n;
}
/** Coseno exacto entre dos filas (vectores normalizados), como el prototipo. */
export function cosine(idx: NarrativeIndex, a: number, b: number) { const n = norms(idx); return idx.cosRows(a, b) / (n[a] * n[b]); }
function topMean(idx: NarrativeIndex, row: number, set: Anchor[], k: number) {
  if (!set.length) return 0;
  const xs = set.map((a) => cosine(idx, row, a.row) * a.w).sort((a, b) => b - a).slice(0, k);
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// ───────── Puntajes ─────────
export interface AttractionScore {
  key: TitleKey;
  /** Orden: A + 0,3·S (método ganador) */
  order: number;
  /** Atractivo previo A (puntaje relativo, NO probabilidad) */
  attraction: number;
  /** Parecido semántico E (sin el factor 6) */
  similarity: number;
  /** Reglas aplicadas, con su peso */
  rules: RuleHit[];
  /** Satisfacción estimada S (escala de nota) */
  satisfaction: number;
  /** Rasgos que más aportaron a S */
  satisfactionNotes: string[];
  excludedBy?: PrefId;
}
export interface AttractionContext {
  idx: NarrativeIndex;
  flags: Map<TitleKey, Set<string>>;
  ratings: Rating[];
  interests: InterestRecord[];
  taste: TasteProfile;
}
const bayesQuality = (vote = 0, votes = 0) => (votes * vote + 300 * 6.4) / (votes + 300);
export function ratedMean(ratings: Rating[]) {
  const rs = ratings.filter((r) => r.overall !== undefined && r.overall !== null && !r.notInterested);
  return rs.reduce((a, r) => a + r.overall!, 0) / Math.max(1, rs.length);
}
/** Puntúa títulos del catálogo (los que no están en el catálogo no se pueden puntuar con este método). */
export function scoreAttraction(ctx: AttractionContext, keys: TitleKey[]): AttractionScore[] {
  const { idx } = ctx;
  const sets = attractionSets(idx, ctx.ratings, ctx.interests, ctx.taste);
  const mean = ratedMean(ctx.ratings);
  const out: AttractionScore[] = [];
  for (const key of keys) {
    const c = idx.get(key);
    if (!c) continue;
    const sim = c.row >= 0 && idx.emb ? topMean(idx, c.row, sets.pos, ATTRACTION_PARAMS.topK) - topMean(idx, c.row, sets.neg, ATTRACTION_PARAMS.topK) : 0;
    const { hits, excludedBy } = ruleHits(idx, c, ctx.flags.get(key) ?? new Set(), ctx.taste.prefs);
    const attraction = ATTRACTION_PARAMS.embWeight * sim + capRules(hits);
    const fc = facetMap(c);
    const q = bayesQuality(c.vote, c.votes);
    const puzzle = fc.get('cx.puzzle') ?? 0, fast = fc.get('pace.fast') ?? 0, slow = fc.get('pace.slow-burn') ?? 0;
    const satisfaction = mean + 0.5 * (q - 6.8) + 0.3 * puzzle + 0.2 * fast - 0.3 * slow;
    const notes: string[] = [];
    if (puzzle > 0.4) notes.push('giros'); if (fast > 0.4) notes.push('ritmo ágil'); if (slow > 0.5) notes.push('ritmo lento');
    out.push({ key, order: attraction + ATTRACTION_PARAMS.satisfactionWeight * satisfaction, attraction, similarity: sim, rules: hits, satisfaction, satisfactionNotes: notes, excludedBy });
  }
  return out;
}

/**
 * Candidatos del método ganador: títulos del catálogo en tus plataformas (según el catálogo), con ≥ 80 votos,
 * que no tienen ningún registro tuyo (valorados, vistos, descartados o en tu lista) ni respuesta «No me interesa» o
 * «Ya la vi».
 */
export function catalogCandidates(idx: NarrativeIndex, providerIds: number[], ratings: Rating[], interests: InterestRecord[]): TitleKey[] {
  const mine = new Set(providerIds);
  const history = new Set(ratings.map((r) => r.key));
  const answered = latestInterests(interests);
  return idx.titles.filter((c) => !history.has(c.key) && c.votes >= ATTRACTION_PARAMS.minVotes && c.provAR.some((p) => mine.has(p))
    && !['no', 'visto'].includes(answered.get(c.key)?.answer ?? '')).map((c) => c.key);
}

/** Orden final: mayor a menor, una sola entrega por saga (como el prototipo); las exclusiones estrictas quedan fuera. */
export function rankAttraction(scores: AttractionScore[], idx: NarrativeIndex, limit = 200): AttractionScore[] {
  const seen = new Set<number>(); const out: AttractionScore[] = [];
  for (const s of [...scores].filter((x) => !x.excludedBy).sort((a, b) => b.order - a.order)) {
    const coll = idx.get(s.key)?.collection;
    if (coll) { if (seen.has(coll)) continue; seen.add(coll); }
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// ───────── Presentación ─────────
/** Nivel de compatibilidad relativo a los candidatos de esta tanda (no es una probabilidad). */
export function compatibilityLevel(percentile: number): 'muy alta' | 'alta' | 'media' | 'baja' {
  return percentile >= 0.95 ? 'muy alta' : percentile >= 0.8 ? 'alta' : percentile >= 0.5 ? 'media' : 'baja';
}
/**
 * Explicación a partir de datos verificables: reglas del perfil que se cumplen (con su dato) y los títulos de tu
 * historial más parecidos. Sin sinopsis (no hay spoilers) ni frases genéricas.
 */
export function makeExplainer(ctx: AttractionContext, titleOf: (k: TitleKey) => string | undefined) {
  const sets = attractionSets(ctx.idx, ctx.ratings, ctx.interests, ctx.taste);
  const rowKey = new Map(ctx.idx.titles.filter((t) => t.row >= 0).map((t) => [t.row, t.key]));
  return (s: AttractionScore): { pros: string[]; cons: string[]; similar: string[] } => {
    const pros = s.rules.filter((h) => h.w > 0).sort((a, b) => b.w - a.w).map((h) => cap(h.label));
    const cons = s.rules.filter((h) => h.w < 0).sort((a, b) => a.w - b.w).map((h) => cap(h.label));
    const similar: string[] = [];
    const c = ctx.idx.get(s.key);
    if (c && c.row >= 0 && ctx.idx.emb) {
      // sólo referencias con peso completo (notas altas, «Me interesa» o más, títulos de referencia)
      const best = sets.pos.filter((a) => a.w >= 1).map((a) => ({ k: rowKey.get(a.row)!, v: cosine(ctx.idx, c.row, a.row) })).sort((a, b) => b.v - a.v);
      for (const b of best) { const t = titleOf(b.k) ?? ctx.idx.get(b.k)?.title; if (t && !similar.includes(t)) similar.push(t); if (similar.length >= 2) break; }
    }
    return { pros, cons, similar };
  };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
