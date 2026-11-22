import { COMMENT_MAX } from '../constants';
import type { DimensionId, DimensionScores, LegacyRatingData, LegacyStatus, ListStatus, Rating, SeasonRating, TitleKey } from '../types';

/** Aspectos vigentes (v2.1). */
export const DIM_IDS: DimensionId[] = ['story', 'acting', 'ending', 'emotion', 'visuals', 'pacing', 'suspense'];
/** Todos los aspectos que existieron en escala 1-10 (v1/v2), incluidos los retirados. */
const DIM_IDS_10 = ['story', 'pacing', 'characters', 'suspense', 'originality', 'emotion', 'acting', 'visuals', 'ending'];
const LISTS: ListStatus[] = ['want', 'watching', 'abandoned'];

export const CURRENT_SCHEMA = 3;

const score10 = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(10, Math.max(1, Math.round(v * 2) / 2)) : undefined;
const stars = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(5, Math.max(1, Math.round(v))) : undefined;

/**
 * Conversión documentada de la escala 1-10 a estrellas 1-5:
 *   estrellas = redondear(1 + (nota − 1) × 4 / 9)
 * Es una transformación lineal que lleva 1 → 1 y 10 → 5 (conserva los extremos) y es monótona
 * (nunca invierte el orden; dos notas cercanas pueden compartir estrella).
 *   1→1 · 2→1 · 3→2 · 4→2 · 5→3 · 6→3 · 7→4 · 8→4 · 9→5 · 10→5  (5,5→3 · 8,5→4 · 9,5→5)
 */
export function tenToStars(v: number): number {
  return Math.min(5, Math.max(1, Math.round(1 + ((v - 1) * 4) / 9)));
}

/** Inversa usada por el motor para trabajar en la misma escala que la nota general: 1→1, 3→5,5, 5→10. */
export function starsToTen(s: number): number {
  return 1 + ((s - 1) * 9) / 4;
}

/** Limpia aspectos ya expresados en estrellas (v3). */
export function cleanDimensions(d: unknown): DimensionScores {
  const out: DimensionScores = {};
  if (!d || typeof d !== 'object') return out;
  for (const id of DIM_IDS) { const v = stars((d as Record<string, unknown>)[id]); if (v !== undefined) out[id] = v; }
  return out;
}

function clean10(d: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!d || typeof d !== 'object') return out;
  for (const id of DIM_IDS_10) { const v = score10((d as Record<string, unknown>)[id]); if (v !== undefined) out[id] = v; }
  return out;
}

function convert10(d10: Record<string, number>): DimensionScores {
  const out: DimensionScores = {};
  for (const id of DIM_IDS) if (d10[id] !== undefined) out[id] = tenToStars(d10[id]);
  return out;
}

const cleanComment = (c: unknown) => (typeof c === 'string' && c.trim() ? c.trim().slice(0, COMMENT_MAX) : undefined);

function convertSeasons(seasons: unknown, from10: boolean): SeasonRating[] | undefined {
  if (!Array.isArray(seasons)) return undefined;
  return seasons.filter((s) => s && typeof s.season === 'number').map((s) => ({
    season: s.season,
    overall: score10(s.overall),
    dimensions: from10 ? convert10(clean10(s.dimensions)) : cleanDimensions(s.dimensions),
    updatedAt: s.updatedAt ?? Date.now(),
  }));
}

/**
 * Convierte un registro de cualquier versión al esquema v3 sin perder datos. Es idempotente.
 *
 * v1 (sin `schema`) guardaba un único `status`:
 *  - rated / watched → watched = true
 *  - want / watching / abandoned → list
 *  - not_interested → notInterested = true
 * v2 (`schema: 2`) tenía `list` (incluía not_interested) y aspectos 1-10 (9 aspectos).
 * v3: siete aspectos en estrellas 1-5; «No me interesa» es un campo propio.
 *
 * Al pasar de 1-10 a estrellas, los valores originales (incluidos Personajes y Originalidad) se copian a
 * `legacy.dimensions10` para poder recuperarlos. La nota general nunca se modifica.
 */
export function migrateRating(raw: any): Rating {
  if (raw?.schema === 3) {
    const r: Rating = {
      ...raw,
      watched: Boolean(raw.watched),
      list: LISTS.includes(raw.list) ? raw.list : undefined,
      notInterested: raw.notInterested ? true : undefined,
      overall: score10(raw.overall),
      dimensions: cleanDimensions(raw.dimensions),
      comment: cleanComment(raw.comment),
    };
    if (!r.notInterested) delete r.notInterestedAt;
    return r;
  }
  const isV2 = raw?.schema === 2 && typeof raw.watched === 'boolean';
  const status = isV2 ? undefined : (raw?.status as LegacyStatus | undefined);
  const watched = isV2 ? raw.watched : status === 'rated' || status === 'watched';
  const rawList = isV2 ? raw.list : status;
  const list = LISTS.includes(rawList) ? (rawList as ListStatus) : undefined;
  const notInterested = rawList === 'not_interested';
  const d10 = clean10(raw?.dimensions);
  const now = Date.now();
  const legacy: LegacyRatingData | undefined = Object.keys(d10).length || status
    ? { ...(raw?.legacy ?? {}), dimensions10: Object.keys(d10).length ? d10 : undefined, fromSchema: isV2 ? 2 : 1, migratedAt: now, status: status || undefined }
    : raw?.legacy;
  if (legacy) for (const k of Object.keys(legacy) as (keyof LegacyRatingData)[]) if (legacy[k] === undefined) delete legacy[k];
  const { status: _drop, ...rest } = raw ?? {};
  const out: Rating = {
    ...rest,
    id: raw.id,
    profileId: raw.profileId,
    key: raw.key as TitleKey,
    watched,
    watchedAt: watched ? raw.watchedAt ?? raw.updatedAt ?? raw.createdAt : undefined,
    list,
    notInterested: notInterested || undefined,
    notInterestedAt: notInterested ? raw.updatedAt ?? raw.createdAt ?? now : undefined,
    overall: score10(raw.overall),
    dimensions: convert10(d10),
    comment: cleanComment(raw.comment),
    abandonReason: list === 'abandoned' ? raw.abandonReason : undefined,
    seasons: convertSeasons(raw.seasons, true),
    legacy,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? now,
    schema: 3,
  };
  for (const k of Object.keys(out) as (keyof Rating)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export const hasScore = (r: Pick<Rating, 'overall' | 'dimensions'>) => r.overall !== undefined || Object.keys(r.dimensions ?? {}).length > 0;

/** Porcentaje de aspectos completados: aspectos con estrellas / 7 × 100 (sin nota general ni «Otros»). */
export function aspectCompletion(r: Pick<Rating, 'dimensions'>): { done: number; total: number; percent: number } {
  const done = DIM_IDS.filter((d) => r.dimensions?.[d] !== undefined).length;
  return { done, total: DIM_IDS.length, percent: Math.round((done / DIM_IDS.length) * 100) };
}
