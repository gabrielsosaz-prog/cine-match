/**
 * v3.4 · Preferencias narrativas flexibles del texto libre (`preferencias-1.0`).
 *
 * A diferencia de las restricciones (textFilter.ts), una preferencia NO filtra: sólo reordena los resultados
 * cuando el título tiene evidencia explícita (palabras clave de TMDB o género). Sin datos, no suma ni resta.
 * Detección por frases en español (reglas, no comprensión del lenguaje).
 *
 * Cada preferencia se validó contra una referencia editorial independiente (categorías de Wikipedia) en el
 * conjunto de DESARROLLO del catálogo y se informa en el de EVALUACIÓN (scripts/eval/preferences.ts,
 * docs/preferences-validation.json). Sólo se APLICAN las que superaron el criterio fijado de antemano:
 * precisión ≥ 0,30 y al menos 3 veces la tasa base. Las demás se muestran como «no aplicada» con el motivo.
 * La similitud semántica del catálogo (rasgos inferidos de sinopsis) se evaluó para esto y no superó el criterio.
 */
import type { TitleMeta } from '../types';

export const PREF_RULES = 'preferencias-1.0';
export interface PrefDef {
  id: string;
  label: string;
  /** frases que la activan (texto normalizado, sin tildes) */
  re: RegExp;
  /** +1 = subir lo que coincide; −1 = bajar lo que coincide */
  polarity: 1 | -1;
  /** palabras clave de TMDB (en inglés) que son evidencia explícita */
  kw: string[];
  genres?: number[];
  /** se aplica (validada) o sólo se informa */
  applied: boolean;
  /** qué se mide en realidad / por qué no se aplica */
  note: string;
}
export const PREFS: PrefDef[] = [
  { id: 'time-travel', label: 'viajes en el tiempo importantes para la trama', polarity: 1, applied: true,
    re: /(?:viajes? (?:en el |por el )?tiempo (?:importantes?|central(?:es)?)|viajes? temporal(?:es)? (?:importantes?|central(?:es)?)|(?:importantes?|central(?:es)?|centrad[ao]s?) (?:en |para )?(?:los |el )?viajes? (?:en el tiempo|temporal(?:es)?))(?: (?:para|en) (?:la )?(?:trama|historia))?/,
    kw: ['time travel', 'time machine', 'time loop', 'time paradox', 'time traveler', 'alternate timeline'],
    note: 'Palabras clave de TMDB sobre viajes en el tiempo. No mide cuánto pesan en la trama, sólo que TMDB los registra.' },
  { id: 'nonlinear', label: 'narración no lineal', polarity: 1, applied: true,
    re: /(?:narracion(?:es)?|estructura|historias?|relatos?) no lineal(?:es)?|no lineal(?:es)?|con flashbacks|saltos temporales|varias lineas temporales/,
    kw: ['nonlinear timeline', 'non linear timeline', 'told in flashback', 'multiple timelines', 'dual timeline', 'parallel timelines', 'flashback', 'flashbacks'],
    note: 'Palabras clave de TMDB de estructura no lineal o flashbacks.' },
  { id: 'unsettling', label: 'atmósfera inquietante', polarity: 1, applied: true,
    re: /atmosferas? (?:inquietantes?|perturbadoras?|opresivas?|tensas?|siniestras?)|inquietantes?|perturbadoras?|opresivas?|escalofriantes?/,
    kw: ['psychological thriller', 'paranoia', 'unreliable narrator', 'gaslighting', 'stalker', 'supernatural horror', 'haunted house', 'psychological horror', 'eerie', 'creepy', 'disturbing', 'suspenseful', 'tense'],
    note: 'Palabras clave de TMDB de suspenso psicológico o terror. La «atmósfera» no se mide: se usan esos temas como aproximación.' },
  { id: 'gradual-mystery', label: 'misterios que se resuelven gradualmente', polarity: 1, applied: true,
    re: /misterios? (?:que se resuelv\w+ (?:de a poco|gradualmente|poco a poco|lentamente)|gradual(?:es)?|lentos?)|se resuelv\w+ (?:gradualmente|de a poco|poco a poco)|investigaciones? (?:lentas?|minuciosas?)/,
    kw: ['whodunit', 'whodunnit', 'murder mystery', 'murder investigation', 'police investigation', 'private detective', 'detective', 'investigation', 'mystery'],
    note: 'Palabras clave de TMDB de misterio e investigación. No se mide si el misterio se resuelve de forma gradual.' },
  { id: 'less-romance', label: 'poco protagonismo del romance', polarity: -1, applied: true,
    re: /poco (?:protagonismo del |de )?romance|(?:sin|no) (?:mucho|demasiado) romance|romance (?:secundario|en segundo plano)|que el romance no (?:sea|domine)|poca? (?:historia de amor|romantica?)/,
    kw: ['romance', 'love story', 'falling in love', 'romantic comedy', 'love triangle', 'romantic drama', 'lovers'], genres: [10749],
    note: 'Baja (no quita) los títulos con género Romance o palabras clave de romance. No mide cuánto pesa el romance en la trama.' },
  { id: 'twists', label: 'giros argumentales', polarity: 1, applied: false,
    re: /giros? (?:argumental(?:es)?|inesperados?|de guion|en la trama)|vueltas? de tuerca|finales? (?:sorpresivos?|inesperados?|sorpresa)|plot twists?/,
    kw: ['plot twist', 'twist ending', 'twist', 'unexpected twists', 'twist reveal', 'surprise ending'],
    note: 'No aplicada: no hay una referencia independiente para comprobar si las palabras clave de «giro» de TMDB son confiables, y pueden revelar el final.' },
  { id: 'complex', label: 'historias complejas', polarity: 1, applied: false,
    re: /(?:historias?|tramas?|argumentos?|peliculas?|series?) (?:complejas?|enrevesadas?|intrincadas?|que hagan pensar)|rompecabezas|complejas?/,
    kw: ['mind-bending', 'puzzle', 'intricate plot', 'complex', 'multiple timelines', 'time loop'],
    note: 'No aplicada: la evidencia disponible (palabras clave «complex», «puzzle»…) no alcanzó la precisión mínima contra la referencia.' },
];

export interface PrefCond { id: string; label: string; polarity: 1 | -1; applied: boolean; note: string }
export const normPref = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[“”«»"¿?¡!()]/g, ' ').replace(/\s+/g, ' ').trim();
/** Detecta preferencias flexibles y devuelve el texto sin esas frases (para el analizador de restricciones). */
export function extractPrefs(text: string): { prefs: PrefCond[]; rest: string } {
  let rest = normPref(text);
  const prefs: PrefCond[] = [];
  for (const p of PREFS) {
    const g = new RegExp(`\\b(?:${p.re.source})\\b`, 'g');
    if (g.test(rest)) {
      prefs.push({ id: p.id, label: p.label, polarity: p.polarity, applied: p.applied, note: p.note });
      rest = rest.replace(new RegExp(`\\b(?:${p.re.source})\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return { prefs, rest };
}
export interface PrefMatch { id: string; label: string; polarity: 1 | -1; evidence: string[] }
/** Coincidencias con evidencia explícita (undefined = no hay datos para decidir). */
export function prefEvidence(p: PrefCond, t: TitleMeta, kwNames: string[] | undefined): PrefMatch | null | undefined {
  const def = PREFS.find((x) => x.id === p.id);
  if (!def) return null;
  const ev: string[] = [];
  for (const g of t.genres) if (def.genres?.includes(g.id)) ev.push(`género ${g.name}`);
  if (kwNames) for (const k of kwNames) if (def.kw.includes(k.toLowerCase())) ev.push(`«${k.toLowerCase()}»`);
  if (!kwNames && !ev.length) return undefined;
  return ev.length ? { id: p.id, label: p.label, polarity: p.polarity, evidence: [...new Set(ev)].slice(0, 3) } : null;
}
/**
 * Cuántas posiciones sube (o baja) un título por cada preferencia aplicada con evidencia.
 * Se mueve RESPECTO DEL ORDEN DEL MOTOR (que ya incluye diversidad) y no sobre la nota: la nota estimada se recorta
 * en 10 y muchos títulos empatan, así que sumar puntos a la nota y reordenar deshacía la diversidad y, en la
 * prueba, hacía SUBIR los títulos románticos con «poco romance» (error encontrado y corregido en v3.4).
 */
export const PREF_SHIFT = 5;
export const PREF_MAX_SHIFT = 10;
export function prefAdjust(prefs: PrefCond[] | undefined, t: TitleMeta, kwNames: string[] | undefined): { delta: number; matches: PrefMatch[]; unknown: string[] } {
  const matches: PrefMatch[] = [];
  const unknown: string[] = [];
  let delta = 0;
  for (const p of prefs ?? []) {
    if (!p.applied) continue;
    const m = prefEvidence(p, t, kwNames);
    if (m === undefined) { unknown.push(p.label); continue; }
    if (m) { matches.push(m); delta += p.polarity * PREF_SHIFT; }
  }
  return { delta: Math.max(-PREF_MAX_SHIFT, Math.min(PREF_MAX_SHIFT, delta)), matches, unknown };
}
/** Reordena una lista ya ordenada por el motor: cada título se desplaza `delta` posiciones (+ sube). Estable. */
export function reorderByPrefs<T>(items: T[], deltaOf: (it: T) => number): T[] {
  return items.map((it, i) => { const d = deltaOf(it); return { it, i, d, k: i - d }; }).sort((a, b) => a.k - b.k || b.d - a.d || a.i - b.i).map((x) => x.it);
}
