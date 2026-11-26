import Dexie, { type Table } from 'dexie';
import { exportData } from './dataPortability';
import { patchLedger, readLedger } from './storageSafety';

/**
 * Copias de seguridad (v3.6).
 *
 * 1) Copias LOCALES automáticas en una base IndexedDB separada («cine-match-backups»). Protegen contra errores de la
 *    app, importaciones equivocadas, perfiles cambiados o una base principal dañada. NO protegen contra que el
 *    navegador borre todo el sitio: para eso está (2).
 * 2) Copia EXTERNA: un archivo JSON que se comparte (Drive, correo, WhatsApp «a mí mismo»…) o se descarga. Es gratis,
 *    privado (no pasa por ningún servidor de la app) y sobrevive a desinstalar o limpiar el navegador.
 *
 * Restaurar nunca es automático y siempre usa la fusión segura de dataPortability (no pisa datos más nuevos).
 */

export interface LocalBackup {
  id?: number;
  at: number;
  reason: 'auto' | 'antes de importar' | 'antes de restaurar' | 'manual';
  total: number;
  counts: Record<string, number>;
  data: Awaited<ReturnType<typeof exportData>>;
}
export type LocalBackupMeta = Omit<LocalBackup, 'data'>;

class BackupDB extends Dexie {
  backups!: Table<LocalBackup, number>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ backups: '++id, at, total' });
  }
}

let bdb = new BackupDB('cine-match-backups');
/** Sólo para pruebas */
export function useTestBackupDb(name: string) { bdb = new BackupDB(name); return bdb; }

export const BACKUP_POLICY = {
  /** Mínimo entre copias automáticas */
  autoIntervalMs: 30 * 60 * 1000,
  /** Copias que se conservan (además de la que tiene más valoraciones, que nunca se descarta) */
  keep: 15,
  /** Días sin copia externa antes de recordarla */
  remindAfterDays: 7,
};

export async function listLocalBackups(): Promise<LocalBackupMeta[]> {
  const all = await bdb.backups.orderBy('at').reverse().toArray();
  return all.map(({ data: _d, ...m }) => m);
}

export async function getLocalBackup(id: number) { return bdb.backups.get(id); }

export async function localBackupInfo(): Promise<{ count: number; maxRatings: number }> {
  const metas = await listLocalBackups();
  return { count: metas.length, maxRatings: metas.reduce((m, b) => Math.max(m, b.total), 0) };
}

/**
 * Guarda una copia local de perfiles, ajustes y valoraciones. No guarda copias vacías (no hay nada que proteger) y
 * las automáticas se espacian. Devuelve la copia creada o undefined si no correspondía.
 */
export async function createLocalBackup(reason: LocalBackup['reason'] = 'auto'): Promise<LocalBackupMeta | undefined> {
  const data = await exportData();
  const total = data.ratings.length;
  if (!total) return undefined;
  if (reason === 'auto') {
    const last = await bdb.backups.orderBy('at').last();
    const extra = (x: typeof data) => (x.interests?.length ?? 0) + (x.taste?.reduce((m, t) => Math.max(m, t.updatedAt ?? 0), 0) ?? 0);
    if (last && Date.now() - last.at < BACKUP_POLICY.autoIntervalMs && last.total === total && extra(last.data) === extra(data)) return undefined;
  }
  const counts: Record<string, number> = {};
  for (const r of data.ratings) counts[r.profileId] = (counts[r.profileId] ?? 0) + 1;
  // Sin registros de actividad: ocupan espacio y no hacen falta para recuperar
  const slim = { ...data, logs: [] };
  const b: LocalBackup = { at: Date.now(), reason, total, counts, data: slim };
  b.id = await bdb.backups.add(b);
  await prune();
  const { data: _d, ...meta } = b;
  return meta;
}

async function prune() {
  const metas = await listLocalBackups();
  if (metas.length <= BACKUP_POLICY.keep) return;
  const biggest = metas.reduce((a, b) => (b.total > a.total ? b : a));
  const drop = metas.slice(BACKUP_POLICY.keep).filter((m) => m.id !== biggest.id).map((m) => m.id!);
  await bdb.backups.bulkDelete(drop);
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Copia automática unos segundos después de guardar (agrupa varios guardados seguidos). Nunca rompe el guardado. */
export function scheduleLocalBackup(delayMs = 5000) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; createLocalBackup('auto').catch(() => undefined); }, delayMs);
}

export async function clearLocalBackups() { await bdb.backups.clear(); }

// ── Copia externa ─────────────────────────────────────────────────────────────────────────────────────────────────

export async function buildBackupFile(): Promise<{ file: File; total: number }> {
  const data = await exportData();
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const file = new File([JSON.stringify(data, null, 2)], `cine-match-respaldo-${stamp}.json`, { type: 'application/json' });
  return { file, total: data.ratings.length };
}

/**
 * Comparte el archivo (en el celular abre el menú de Android/iOS: Drive, correo, WhatsApp…) o, si no se puede,
 * lo descarga. Devuelve cómo terminó; si se canceló no se registra como copia hecha.
 */
export async function saveExternalBackup(): Promise<{ method: 'share' | 'download' | 'cancelled'; total: number }> {
  const { file, total } = await buildBackupFile();
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Respaldo de Cine Match' });
      patchLedger({ lastExternalBackupAt: Date.now(), lastExternalBackupTotal: total });
      return { method: 'share', total };
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return { method: 'cancelled', total };
      // Si compartir falla por otro motivo, se descarga
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  patchLedger({ lastExternalBackupAt: Date.now(), lastExternalBackupTotal: total });
  return { method: 'download', total };
}

/** ¿Conviene recordar una copia externa? Hay valoraciones nuevas desde la última y pasó el plazo (o nunca se hizo). */
export function externalBackupDue(now = Date.now()): { due: boolean; days?: number; newSince: number } {
  const l = readLedger();
  if (!l || !l.total) return { due: false, newSince: 0 };
  const newSince = Math.max(0, l.total - (l.lastExternalBackupTotal ?? 0));
  if (!l.lastExternalBackupAt) return { due: true, newSince: l.total };
  const days = Math.floor((now - l.lastExternalBackupAt) / 86400000);
  return { due: days >= BACKUP_POLICY.remindAfterDays && l.total !== l.lastExternalBackupTotal, days, newSince };
}
