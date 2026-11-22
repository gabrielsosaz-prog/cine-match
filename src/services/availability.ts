import { AVAILABILITY_STALE_MS, AVAILABILITY_TTL_MS, PLATFORMS } from '../constants';
import type { AvailabilityEvent, AvailabilitySnapshot, PlatformId } from '../types';

export const STREAM_KINDS = new Set(['flatrate', 'ads', 'free']);

/** Plataformas (de las 4 principales) donde el título está incluido en la suscripción. */
export function streamingPlatforms(s?: AvailabilitySnapshot | null): PlatformId[] {
  if (!s || s.status !== 'ok') return [];
  const set = new Set<PlatformId>();
  for (const o of s.offers) if (o.platform && STREAM_KINDS.has(o.kind)) set.add(o.platform);
  return PLATFORMS.map((p) => p.id).filter((p) => set.has(p));
}

export type AvailabilityState =
  | { kind: 'confirmed'; platforms: PlatformId[]; checkedAt: number; source: string; stale: boolean }
  | { kind: 'not_on_platforms'; checkedAt: number; source: string; stale: boolean; others: string[] }
  | { kind: 'no_data'; checkedAt: number; source: string }
  | { kind: 'unverified'; reason: string; checkedAt?: number };

export function availabilityState(s: AvailabilitySnapshot | null | undefined, now = Date.now()): AvailabilityState {
  if (!s) return { kind: 'unverified', reason: 'Disponibilidad no verificada todavía' };
  if (s.status === 'error') return { kind: 'unverified', reason: s.errorMessage ?? 'No se pudo verificar', checkedAt: s.checkedAt };
  if (s.status === 'no-data') return { kind: 'no_data', checkedAt: s.checkedAt, source: s.source };
  const stale = now - s.checkedAt > AVAILABILITY_STALE_MS;
  const platforms = streamingPlatforms(s);
  if (platforms.length) return { kind: 'confirmed', platforms, checkedAt: s.checkedAt, source: s.source, stale };
  const others = [...new Set(s.offers.filter((o) => STREAM_KINDS.has(o.kind)).map((o) => o.providerName))];
  return { kind: 'not_on_platforms', checkedAt: s.checkedAt, source: s.source, stale, others };
}

export const needsRefresh = (s: AvailabilitySnapshot | null | undefined, now = Date.now()) =>
  !s || s.status === 'error' || now - s.checkedAt > AVAILABILITY_TTL_MS;

/**
 * Compara dos verificaciones y devuelve altas y bajas por plataforma.
 * El proveedor no informa la fecha exacta del cambio: se registra el intervalo entre verificaciones.
 */
export function diffAvailability(prev: AvailabilitySnapshot | undefined, next: AvailabilitySnapshot): AvailabilityEvent[] {
  if (!prev || prev.status !== 'ok' || next.status !== 'ok' || prev.country !== next.country) return [];
  const a = new Set(streamingPlatforms(prev));
  const b = new Set(streamingPlatforms(next));
  const events: AvailabilityEvent[] = [];
  for (const p of b) if (!a.has(p)) events.push({ key: next.key, country: next.country, platform: p, change: 'added', detectedAt: next.checkedAt, previousCheckAt: prev.checkedAt, source: next.source });
  for (const p of a) if (!b.has(p)) events.push({ key: next.key, country: next.country, platform: p, change: 'removed', detectedAt: next.checkedAt, previousCheckAt: prev.checkedAt, source: next.source });
  return events;
}

/** ¿Pasa el filtro de plataformas del usuario? */
export function matchesPlatforms(s: AvailabilitySnapshot | null | undefined, selected: PlatformId[], includeUnconfirmed: boolean): boolean {
  const st = availabilityState(s);
  if (st.kind === 'confirmed') return st.platforms.some((p) => selected.includes(p));
  if (st.kind === 'unverified' || st.kind === 'no_data') return includeUnconfirmed;
  return false;
}
