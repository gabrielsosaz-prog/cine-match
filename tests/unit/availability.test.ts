import { describe, expect, it } from 'vitest';
import { availabilityState, diffAvailability, matchesPlatforms, needsRefresh } from '../../src/services/availability';
import type { AvailabilitySnapshot } from '../../src/types';

const snap = (platformIds: [number, string][], over: Partial<AvailabilitySnapshot> = {}): AvailabilitySnapshot => ({
  id: 'movie:1|AR', key: 'movie:1', country: 'AR', status: 'ok', source: 'TMDB / JustWatch', checkedAt: Date.now(),
  offers: platformIds.map(([id, name]) => ({ providerId: id, providerName: name, platform: id === 8 ? 'netflix' : id === 337 ? 'disney' : id === 1899 ? 'max' : id === 119 ? 'prime' : null, kind: 'flatrate' })),
  ...over,
});

describe('Estados de disponibilidad', () => {
  it('confirmada / otras plataformas / sin datos / no verificada', () => {
    expect(availabilityState(snap([[8, 'Netflix']])).kind).toBe('confirmed');
    expect(availabilityState(snap([[167, 'Claro video']])).kind).toBe('not_on_platforms');
    expect(availabilityState(snap([], { status: 'no-data' })).kind).toBe('no_data');
    expect(availabilityState(undefined).kind).toBe('unverified');
    expect(availabilityState(snap([], { status: 'error' })).kind).toBe('unverified');
  });
  it('alquiler/compra no cuentan como incluido en la suscripción', () => {
    const s = snap([]); s.offers = [{ providerId: 119, providerName: 'Amazon Prime Video', platform: 'prime', kind: 'rent' }];
    expect(availabilityState(s).kind).toBe('not_on_platforms');
  });
  it('marca como desactualizada pasados 7 días', () => {
    const st = availabilityState(snap([[8, 'Netflix']], { checkedAt: Date.now() - 8 * 86400000 }));
    expect(st.kind === 'confirmed' && st.stale).toBe(true);
    expect(needsRefresh(snap([[8, 'Netflix']], { checkedAt: Date.now() - 2 * 86400000 }))).toBe(true);
  });
});

describe('Ingresos y salidas de plataformas', () => {
  it('detecta altas y bajas entre verificaciones', () => {
    const prev = snap([[8, 'Netflix'], [337, 'Disney Plus']], { checkedAt: 1000 });
    const next = snap([[8, 'Netflix'], [1899, 'Max']], { checkedAt: 2000 });
    const ev = diffAvailability(prev, next);
    expect(ev).toHaveLength(2);
    expect(ev.find((e) => e.change === 'added')!.platform).toBe('max');
    expect(ev.find((e) => e.change === 'removed')!.platform).toBe('disney');
    expect(ev[0].previousCheckAt).toBe(1000);
  });
  it('un error del proveedor no genera bajas falsas', () => {
    expect(diffAvailability(snap([[8, 'Netflix']]), snap([], { status: 'error' }))).toEqual([]);
  });
});

describe('Filtrado por plataforma', () => {
  it('respeta plataformas seleccionadas e incertidumbre', () => {
    expect(matchesPlatforms(snap([[8, 'Netflix']]), ['netflix'], false)).toBe(true);
    expect(matchesPlatforms(snap([[8, 'Netflix']]), ['disney'], false)).toBe(false);
    expect(matchesPlatforms(undefined, ['netflix'], false)).toBe(false);
    expect(matchesPlatforms(undefined, ['netflix'], true)).toBe(true);
  });
});
