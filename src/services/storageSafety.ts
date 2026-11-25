import { db } from '../db/db';

/**
 * Seguridad del almacenamiento (v3.6, incidente de pérdida de valoraciones).
 *
 * Reglas:
 *  - Un error al leer la base NUNCA se interpreta como «perfil nuevo sin valoraciones».
 *  - Si había valoraciones (según el registro de control) y ahora la base está vacía o mucho más chica, la app entra
 *    en modo recuperación en lugar de empezar de cero. Nada se importa ni se restaura sin que lo pidas.
 *  - Nada de este módulo borra ni sobrescribe valoraciones.
 *
 * El «registro de control» (ledger) vive en localStorage, fuera de IndexedDB: si sólo se pierde o corrompe la base, el
 * registro sobrevive y permite detectarlo. Si el navegador borra todo el sitio (desalojo por espacio, «borrar datos de
 * sitios», límite de 7 días de Safari) también se pierde el registro; contra eso sólo protege una copia fuera del
 * navegador (ver backups.ts).
 */

export const LEDGER_KEY = 'cine-match:ledger';

export interface Ledger {
  /** Valoraciones por perfil en la última lectura confirmada */
  counts: Record<string, number>;
  total: number;
  activeProfileId?: string;
  at: number;
  /** Última copia fuera del dispositivo (descarga o compartir) */
  lastExternalBackupAt?: number;
  /** Cantidad de valoraciones incluidas en esa copia */
  lastExternalBackupTotal?: number;
  /** Se detectó una caída brusca con la app abierta y no se aceptó todavía */
  suspectAt?: number;
}

export function readLedger(): Ledger | undefined {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || typeof v.total !== 'number' || typeof v.counts !== 'object') return undefined;
    return v as Ledger;
  } catch { return undefined; }
}

function writeLedger(l: Ledger) {
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(l)); } catch { /* sin almacenamiento: no se puede llevar el control */ }
}

export function patchLedger(patch: Partial<Ledger>) {
  const prev = readLedger() ?? { counts: {}, total: 0, at: Date.now() };
  writeLedger({ ...prev, ...patch });
}

export function clearLedger() { try { localStorage.removeItem(LEDGER_KEY); } catch { /* nada */ } }

/** Cuenta valoraciones por perfil. Lanza si la base no se puede leer (nunca devuelve «0» por un error). */
export async function countRatingsByProfile(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await db.ratings.each((r) => { counts[r.profileId] = (counts[r.profileId] ?? 0) + 1; });
  return counts;
}

/** Actualiza el registro de control con lo que hay ahora en la base. Sólo después de una lectura exitosa. */
export async function recordLedger(activeProfileId?: string, opts: { force?: boolean } = {}) {
  const counts = await countRatingsByProfile();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const prev = readLedger();
  // Si la base cayó de golpe (p. ej. el sistema la borró con la app abierta) NO se baja el registro: así la próxima
  // apertura entra en modo recuperación. Sólo se acepta con una decisión explícita (force).
  if (!opts.force && prev && looksLikeLoss(prev.total, total)) {
    writeLedger({ ...prev, suspectAt: prev.suspectAt ?? Date.now() });
    return;
  }
  const { suspectAt: _s, ...rest } = prev ?? ({} as Partial<Ledger>);
  writeLedger({ ...rest, counts, total, activeProfileId: activeProfileId ?? prev?.activeProfileId, at: Date.now() });
}

export function looksLikeLoss(expected: number, total: number) {
  const missing = expected - total;
  return (expected >= 2 && total === 0) || (missing >= LOSS_RULE.minMissing && total < expected * LOSS_RULE.maxRatio);
}

/** Actualiza el registro sin bloquear ni romper la acción que lo pidió. */
export function recordLedgerSoon(activeProfileId?: string) {
  recordLedger(activeProfileId).catch(() => undefined);
}

export type IntegrityState =
  /** Base legible y coherente con el registro */
  | 'ok'
  /** Primera vez en este dispositivo/navegador: sin datos y sin rastros de datos anteriores */
  | 'new'
  /** Había valoraciones y ya no están (o faltan muchas): no se empieza de cero */
  | 'suspected-loss'
  /** La base no se pudo leer: no se sabe si hay datos, no se escribe nada */
  | 'read-error';

export interface IntegrityReport {
  state: IntegrityState;
  counts: Record<string, number>;
  total: number;
  expectedTotal?: number;
  hasConfig: boolean;
  activeProfileId?: string;
  /** El perfil activo está vacío pero otro perfil tiene valoraciones (no es pérdida: es otro perfil) */
  otherProfileHasRatings?: { id: string; name: string; count: number };
  profiles: { id: string; name: string }[];
  localBackups: number;
  localBackupMaxRatings: number;
  ledgerAt?: number;
  error?: string;
}

export const LOSS_RULE = {
  /** Se considera pérdida si faltan al menos este número de valoraciones… */
  minMissing: 5,
  /** …y además queda menos de esta fracción de lo esperado */
  maxRatio: 0.5,
};

/**
 * Revisa la base ANTES de inicializar nada. Sólo lee.
 * `backupInfo` se inyecta para no depender del módulo de copias (y para probarlo).
 */
export async function checkIntegrity(backupInfo: () => Promise<{ count: number; maxRatings: number }> = async () => ({ count: 0, maxRatings: 0 })): Promise<IntegrityReport> {
  const ledger = readLedger();
  const backups = await backupInfo().catch(() => ({ count: 0, maxRatings: 0 }));
  const base = { localBackups: backups.count, localBackupMaxRatings: backups.maxRatings, expectedTotal: ledger?.total, ledgerAt: ledger?.at };
  let cfg; let counts: Record<string, number>; let profiles: { id: string; name: string }[];
  try {
    if (!db.isOpen()) await db.open();
    cfg = await db.config.get('app');
    profiles = await db.profiles.toArray();
    counts = await countRatingsByProfile();
  } catch (e) {
    return { ...base, state: 'read-error', counts: {}, total: 0, hasConfig: false, profiles: [], error: (e as Error)?.message ?? String(e) };
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const expected = Math.max(ledger?.total ?? 0, 0);
  const activeProfileId = cfg?.activeProfileId;
  let otherProfileHasRatings: IntegrityReport['otherProfileHasRatings'];
  if (activeProfileId && !counts[activeProfileId]) {
    const best = Object.entries(counts).filter(([id]) => id !== activeProfileId).sort((a, b) => b[1] - a[1])[0];
    if (best) otherProfileHasRatings = { id: best[0], name: profiles.find((p) => p.id === best[0])?.name ?? best[0], count: best[1] };
  }
  const lost = looksLikeLoss(expected, total)
    // Base vacía pero hay copias locales con valoraciones (p. ej. se perdió sólo la base principal)
    || (total === 0 && backups.maxRatings > 0);
  const state: IntegrityState = lost ? 'suspected-loss' : !cfg && total === 0 ? 'new' : 'ok';
  return { ...base, state, counts, total, hasConfig: Boolean(cfg), activeProfileId, otherProfileHasRatings, profiles: profiles.map((p) => ({ id: p.id, name: p.name })) };
}

/** El usuario confirma que la base actual es la correcta (p. ej. borró a propósito): se deja de avisar. */
export async function acceptCurrentState() {
  await recordLedger(undefined, { force: true });
}

// ── Almacenamiento persistente ────────────────────────────────────────────────────────────────────────────────────

export interface PersistenceStatus {
  supported: boolean;
  persisted?: boolean;
  usage?: number;
  quota?: number;
}

let lastStatus: PersistenceStatus = { supported: false };

/**
 * Pide que el navegador no borre los datos por falta de espacio. Chrome lo concede según el uso (más probable con la
 * app instalada en la pantalla de inicio); Safari lo concede a las apps agregadas a la pantalla de inicio. Si no se
 * concede, la app lo muestra en Ajustes y recomienda copias fuera del dispositivo con más frecuencia.
 */
export async function requestPersistence(): Promise<PersistenceStatus> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!s?.persist) { lastStatus = { supported: false }; return lastStatus; }
  let persisted: boolean | undefined;
  try { persisted = (await s.persisted?.()) || (await s.persist()); } catch { persisted = undefined; }
  let usage: number | undefined; let quota: number | undefined;
  try { const est = await s.estimate?.(); usage = est?.usage; quota = est?.quota; } catch { /* sin estimación */ }
  lastStatus = { supported: true, persisted, usage, quota };
  return lastStatus;
}
export const getPersistenceStatus = () => lastStatus;

/** Nombres de bases IndexedDB de este sitio (para el diagnóstico). No abre ni modifica ninguna. */
export async function listIndexedDbNames(): Promise<string[] | undefined> {
  try {
    const f = (globalThis.indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> } | undefined)?.databases;
    if (!f) return undefined;
    return (await f.call(globalThis.indexedDB)).map((d) => d.name ?? '').filter(Boolean);
  } catch { return undefined; }
}
