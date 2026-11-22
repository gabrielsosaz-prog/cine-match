import type { DimensionId, DimensionScores, LegacyStatus, ListStatus, Rating, TitleKey } from '../types';

const DIM_IDS: DimensionId[] = ['story', 'pacing', 'characters', 'suspense', 'originality', 'emotion', 'acting', 'visuals', 'ending'];
const LISTS: ListStatus[] = ['want', 'watching', 'abandoned', 'not_interested'];

const score = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(10, Math.max(1, Math.round(v * 2) / 2)) : undefined;

export function cleanDimensions(d: unknown): DimensionScores {
  const out: DimensionScores = {};
  if (!d || typeof d !== 'object') return out;
  for (const id of DIM_IDS) { const v = score((d as Record<string, unknown>)[id]); if (v !== undefined) out[id] = v; }
  return out;
}

/**
 * Convierte un registro de cualquier versión al esquema v2 sin perder datos.
 * v1 guardaba un único `status`:
 *  - rated / watched → watched = true (en la v1 «puntuada» significaba «vista y puntuada»)
 *  - want / watching / abandoned / not_interested → watched = false y list = ese estado
 * Nota general, aspectos, motivo de abandono, temporadas y fechas se conservan tal cual.
 */
export function migrateRating(raw: any): Rating {
  if (raw?.schema === 2 && typeof raw.watched === 'boolean') {
    return { ...raw, dimensions: cleanDimensions(raw.dimensions), overall: score(raw.overall), list: LISTS.includes(raw.list) ? raw.list : undefined };
  }
  const status = raw?.status as LegacyStatus | undefined;
  const watched = status === 'rated' || status === 'watched';
  const list = status && (LISTS as string[]).includes(status) ? (status as ListStatus) : undefined;
  const { status: _drop, ...rest } = raw ?? {};
  return {
    ...rest,
    id: raw.id,
    profileId: raw.profileId,
    key: raw.key as TitleKey,
    watched,
    watchedAt: watched ? raw.updatedAt ?? raw.createdAt : undefined,
    list,
    overall: score(raw.overall),
    dimensions: cleanDimensions(raw.dimensions),
    abandonReason: list === 'abandoned' ? raw.abandonReason : undefined,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? Date.now(),
    schema: 2,
  };
}

export const hasScore = (r: Pick<Rating, 'overall' | 'dimensions'>) => r.overall !== undefined || Object.keys(r.dimensions ?? {}).length > 0;
