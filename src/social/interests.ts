/**
 * v4.3 · Intereses compartidos: categorías, clasificación de coincidencias y orden. Lógica pura (sin red ni base).
 *
 * Reutiliza las cuatro respuestas de interés de siempre (No / Podría / Me interesa / Muchas ganas): no hay un segundo
 * sistema de votación. «Sin responder» y «Privado» son sólo estados de visualización, no respuestas del recomendador.
 * La clasificación debe ser idéntica a `_match_level` de supabase/migrations/0002_shared_interests.sql (se prueba).
 */
import type { InterestAnswer, TitleKey } from '../types';

export type SharedAnswer = 'no' | 'quiza' | 'si' | 'mucho';
export const SHARED_ANSWERS: SharedAnswer[] = ['no', 'quiza', 'si', 'mucho'];
export const isSharedAnswer = (a?: InterestAnswer | string | null): a is SharedAnswer => a === 'no' || a === 'quiza' || a === 'si' || a === 'mucho';

/** Representación común (botones de interés, recuadros compartidos, filtros). */
export const ANSWER_STYLE: Record<SharedAnswer, { icon: string; label: string; short: string; fg: string; bg: string; solid: string; ink: string }> = {
  no: { icon: '👎', label: 'No', short: 'No', fg: '#FCA5A5', bg: 'rgba(248,113,113,0.14)', solid: '#F2A3A3', ink: '#3A0D0D' },
  quiza: { icon: '?', label: 'Podría', short: 'Podría', fg: '#CBD5E1', bg: 'rgba(148,163,184,0.16)', solid: '#B9C3D0', ink: '#141A22' },
  si: { icon: '👍', label: 'Me interesa', short: 'Me interesa', fg: '#FCD34D', bg: 'rgba(250,204,21,0.14)', solid: '#F4B83F', ink: '#1A1205' },
  mucho: { icon: '♥', label: 'Muchas ganas', short: 'Muchas ganas', fg: '#6EE7B7', bg: 'rgba(52,211,153,0.15)', solid: '#4ADE80', ink: '#05210F' },
};

export type MatchLevel = 'maxima' | 'muy_alta' | 'alta' | 'ambos' | 'posible' | 'posible_baja' | 'pendiente' | 'sin' | 'privado';
/** Orden predeterminado de Para ver juntos (menor = primero). */
export const LEVEL_RANK: Record<MatchLevel, number> = { maxima: 1, muy_alta: 2, alta: 3, ambos: 4, posible: 5, posible_baja: 6, pendiente: 7, sin: 8, privado: 9 };
export const LEVEL_LABEL: Record<MatchLevel, string> = {
  maxima: 'Coincidencia máxima', muy_alta: 'Coincidencia muy alta', alta: 'Coincidencia alta', ambos: 'Ambos quieren verla',
  posible: 'Coincidencia posible', posible_baja: 'Coincidencia posible baja', pendiente: 'Pendiente', sin: 'Sin coincidencia', privado: 'Interés privado',
};
/** Interpretación breve bajo los dos recuadros. */
export function interpretation(level: MatchLevel, mineMissing: boolean): string {
  switch (level) {
    case 'maxima': return 'Ambos tienen muchas ganas.';
    case 'muy_alta': case 'alta': return 'Les interesa a ambos.';
    case 'ambos': return 'Ambos quieren verla.';
    case 'posible': case 'posible_baja': return 'Coincidencia posible.';
    case 'sin': return 'No hay coincidencia.';
    case 'privado': return 'Interés privado.';
    default: return mineMissing ? 'Falta tu respuesta.' : 'Esperando respuesta.';
  }
}
export const LEVEL_TONE: Record<MatchLevel, string> = {
  maxima: '#4ADE80', muy_alta: '#86EFAC', alta: '#FCD34D', ambos: '#6EE7B7', posible: '#CBD5E1', posible_baja: '#94A3B8', pendiente: '#7DD3FC', sin: '#FCA5A5', privado: '#94A3B8',
};
export const POSITIVE: MatchLevel[] = ['maxima', 'muy_alta', 'alta', 'ambos'];
export const isPositive = (l: MatchLevel) => POSITIVE.includes(l);

/** Clasificación explícita de dos respuestas (simétrica). undefined = sin responder. */
export function matchLevel(x?: SharedAnswer, y?: SharedAnswer): Exclude<MatchLevel, 'ambos' | 'privado'> {
  if (x === 'no' || y === 'no') return 'sin';
  if (!x || !y) return 'pendiente';
  if (x === 'mucho' && y === 'mucho') return 'maxima';
  if ((x === 'mucho' && y === 'si') || (x === 'si' && y === 'mucho')) return 'muy_alta';
  if (x === 'si' && y === 'si') return 'alta';
  if (x === 'quiza' && y === 'quiza') return 'posible_baja';
  return 'posible';
}

/**
 * Nivel completo de un título con un contacto.
 *  - Un «No» de cualquiera excluye de las positivas, aunque ambos lo tengan en Quiero ver.
 *  - Si ambos lo guardaron en Quiero ver y el interés explícito no alcanza para «alta», queda «Ambos quieren verla».
 *  - Si el interés del otro es privado, no se infiere ni se revela.
 */
export function combinedLevel(o: { mine?: SharedAnswer; theirs?: SharedAnswer; theirsPrivate?: boolean; bothWant?: boolean }): MatchLevel {
  if (o.mine === 'no' || (!o.theirsPrivate && o.theirs === 'no')) return 'sin';
  const explicit: MatchLevel = o.theirsPrivate ? 'privado' : matchLevel(o.mine, o.theirs);
  if (o.bothWant && LEVEL_RANK[explicit] > LEVEL_RANK.ambos) return 'ambos';
  return explicit;
}

/** Puntaje conjunto de v4.2 (sólo con ambos puntajes disponibles y autorizados). */
export const JOINT_PENALTY = 0.25;
export function joint(mine?: number, theirs?: number): number | undefined {
  if (mine === undefined || theirs === undefined || !Number.isFinite(mine) || !Number.isFinite(theirs)) return undefined;
  return (mine + theirs) / 2 - JOINT_PENALTY * Math.abs(mine - theirs);
}

export interface RankItem { key: TitleKey; contact: string; level: MatchLevel; myScore?: number; theirScore?: number; tmdb?: number; at?: number }
/**
 * Orden estable de Para ver juntos: categoría → puntaje conjunto (si ambos existen) → TMDB → fecha → identificador.
 * El interés explícito de ambos pesa más que cualquier predicción. No inventa puntajes.
 */
export function compareMatches(a: RankItem, b: RankItem): number {
  const r = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
  if (r) return r;
  const ja = joint(a.myScore, a.theirScore), jb = joint(b.myScore, b.theirScore);
  if (ja !== undefined || jb !== undefined) { if (ja === undefined) return 1; if (jb === undefined) return -1; if (jb !== ja) return jb - ja; }
  const ta = a.tmdb ?? -1, tb = b.tmdb ?? -1;
  if (tb !== ta) return tb - ta;
  const da = a.at ?? 0, db = b.at ?? 0;
  if (db !== da) return db - da;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : a.contact < b.contact ? -1 : a.contact > b.contact ? 1 : 0;
}

/** Deduplica por contacto + tipo + id TMDB (conserva el de mejor categoría). */
export function dedupeMatches<T extends RankItem>(xs: T[]): T[] {
  const best = new Map<string, T>();
  for (const x of xs) { const k = `${x.contact}|${x.key}`; const p = best.get(k); if (!p || LEVEL_RANK[x.level] < LEVEL_RANK[p.level]) best.set(k, x); }
  return [...best.values()];
}
