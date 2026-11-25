import { db } from '../db/db';
import { migrateRating } from '../db/migrations';
import type { Rating } from '../types';
import { clearLedger, recordLedger } from './storageSafety';

export const EXPORT_FORMAT = 'cine-match-export/3';
/** Formatos que se pueden importar (las exportaciones v1 se migran al importar) */
export const IMPORT_FORMATS = ['cine-match-export/1', 'cine-match-export/2', 'cine-match-export/3'];

/** Exporta datos personales de TODOS los perfiles (no incluye la clave de TMDB). */
export async function exportData() {
  const [profiles, settings, ratings, snapshots, logs] = await Promise.all([
    db.profiles.toArray(), db.settings.toArray(), db.ratings.toArray().then((rs) => rs.map(migrateRating)), db.snapshots.toArray(), db.logs.toArray(),
  ]);
  const titles = await db.titles.bulkGet([...new Set(ratings.map((r) => r.key))]);
  return { format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), profiles, settings, ratings, snapshots, logs, titles: titles.filter(Boolean) };
}

export interface ImportPlan {
  /** Títulos que no existen en este dispositivo y se agregarían */
  added: number;
  /** Títulos que existen pero el archivo tiene una versión MÁS NUEVA */
  updated: number;
  /** Títulos donde lo del dispositivo es igual o más nuevo: se conservan sin cambios */
  keptNewer: number;
  /** Registros del archivo descartados por inválidos */
  invalid: number;
  /** Perfiles del archivo que no existen en el dispositivo y se agregarían */
  newProfiles: string[];
  exportedAt?: string;
  total: number;
}

function parse(json: unknown) {
  const d = json as any;
  if (!d || !IMPORT_FORMATS.includes(d.format) || !Array.isArray(d.ratings)) throw new Error('El archivo no es una exportación válida de Cine Match.');
  const raw = d.ratings as any[];
  const valid: Rating[] = raw.filter((r) => r && typeof r.id === 'string' && /^(movie|tv):\d+$/.test(r.key) && typeof r.profileId === 'string').map(migrateRating);
  return { d, valid, invalid: raw.length - valid.length };
}

/**
 * Fusión segura (v3.6). Reemplaza a la importación anterior, que hacía `bulkPut` y podía PISAR valoraciones más nuevas
 * con las de un archivo viejo. Reglas:
 *  - una valoración del archivo sólo entra si no existe en el dispositivo o si es más nueva (`updatedAt` mayor);
 *  - perfiles y ajustes sólo se agregan si faltan (nunca cambian los existentes);
 *  - con `dryRun` no escribe nada: sirve para mostrar qué pasaría antes de confirmar.
 */
export async function planImport(json: unknown): Promise<ImportPlan> { return mergeImport(json, { dryRun: true }); }

export async function mergeImport(json: unknown, opts: { dryRun?: boolean } = {}): Promise<ImportPlan> {
  const { d, valid, invalid } = parse(json);
  const plan: ImportPlan = { added: 0, updated: 0, keptNewer: 0, invalid, newProfiles: [], exportedAt: d.exportedAt, total: valid.length };
  const run = async () => {
    const existing = await db.ratings.bulkGet(valid.map((r) => r.id));
    const toPut: Rating[] = [];
    valid.forEach((r, i) => {
      const cur = existing[i];
      if (!cur) { plan.added++; toPut.push(r); } else if ((r.updatedAt ?? 0) > (cur.updatedAt ?? 0)) { plan.updated++; toPut.push(r); } else plan.keptNewer++;
    });
    const profiles = Array.isArray(d.profiles) ? d.profiles.filter((p: any) => p && typeof p.id === 'string') : [];
    const haveProfiles = new Set((await db.profiles.bulkGet(profiles.map((p: any) => p.id))).filter(Boolean).map((p) => p!.id));
    // Perfiles referenciados por valoraciones pero ausentes del archivo: se crean para que las valoraciones se vean
    const referenced = [...new Set(toPut.map((r) => r.profileId))].filter((id) => !haveProfiles.has(id) && !profiles.some((p: any) => p.id === id));
    const missingRef = (await db.profiles.bulkGet(referenced)).map((p, i) => (p ? undefined : referenced[i])).filter(Boolean) as string[];
    const newProfiles = [...profiles.filter((p: any) => !haveProfiles.has(p.id)), ...missingRef.map((id) => ({ id, name: id === 'p-principal' ? 'Principal' : 'Recuperado', createdAt: Date.now() }))];
    plan.newProfiles = newProfiles.map((p: any) => p.name ?? p.id);
    if (opts.dryRun) return;
    const settings = Array.isArray(d.settings) ? d.settings.filter((s: any) => s && typeof s.profileId === 'string') : [];
    const haveSettings = new Set((await db.settings.bulkGet(settings.map((s: any) => s.profileId))).filter(Boolean).map((s) => s!.profileId));
    if (newProfiles.length) await db.profiles.bulkAdd(newProfiles);
    const newSettings = settings.filter((s: any) => !haveSettings.has(s.profileId));
    if (newSettings.length) await db.settings.bulkAdd(newSettings);
    // Fichas de títulos: sólo las que faltan (es caché; la del dispositivo puede ser más reciente)
    if (Array.isArray(d.titles)) {
      const titles = d.titles.filter((t: any) => t && typeof t.key === 'string');
      const have = await db.titles.bulkGet(titles.map((t: any) => t.key));
      const missing = titles.filter((_: any, i: number) => !have[i]);
      if (missing.length) await db.titles.bulkAdd(missing);
    }
    if (toPut.length) await db.ratings.bulkPut(toPut);
  };
  if (opts.dryRun) await db.transaction('r', [db.ratings, db.profiles], run);
  else await db.transaction('rw', [db.profiles, db.settings, db.ratings, db.titles], run);
  if (!opts.dryRun) {
    await db.logs.add({ profileId: '*', at: Date.now(), type: 'import', detail: JSON.stringify({ added: plan.added, updated: plan.updated, keptNewer: plan.keptNewer }) }).catch(() => undefined);
    await recordLedger(undefined, { force: true }).catch(() => undefined);
  }
  return plan;
}

/** Compatibilidad: importar = fusión segura. Devuelve cuántas valoraciones entraron. */
export async function importData(json: unknown): Promise<{ ratings: number; plan: ImportPlan }> {
  const plan = await mergeImport(json);
  return { ratings: plan.added + plan.updated, plan };
}

/** Elimina todos los datos personales y la caché del dispositivo (pedido explícito, con confirmación escrita). */
export async function deleteAllData() {
  await Promise.all(db.tables.map((t) => t.clear()));
  clearLedger();
}
