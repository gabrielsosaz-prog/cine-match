/**
 * v3.6 · Incidente de pérdida de valoraciones: pruebas de fallos y pérdida de almacenamiento.
 *
 * Simulan lo que puede pasar en un celular real: la base no se puede leer, el navegador borra la base (desalojo,
 * «borrar datos del sitio»), se pierde una parte, se cambia de perfil por error, se importa un archivo viejo.
 * La regla que verifican todas: la app nunca toma un error o una base vacía inesperada como «perfil nuevo» y nunca
 * pisa datos más nuevos.
 */
import { createElement } from 'react';
import { HashRouter } from 'react-router-dom';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, useTestDb } from '../../src/db/db';
import { createProfile, ensureBootstrap, listRatings, saveRating, updateConfig, updateSettings } from '../../src/db/repo';
import { deleteAllData, exportData, importData, mergeImport, planImport } from '../../src/services/dataPortability';
import {
  BACKUP_POLICY, createLocalBackup, externalBackupDue, getLocalBackup, listLocalBackups, localBackupInfo, useTestBackupDb,
} from '../../src/services/backups';
import {
  LEDGER_KEY, acceptCurrentState, activitySummary, checkIntegrity, patchLedger, readLedger, recordLedger, requestPersistence,
} from '../../src/services/storageSafety';
import { AppProvider } from '../../src/hooks/useApp';
import type { TitleKey } from '../../src/types';

const P = 'p-principal';
let n = 0;
let name = '';

beforeEach(async () => {
  localStorage.clear();
  name = `v36-${n++}`;
  useTestDb(name);
  useTestBackupDb(`${name}-bk`);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function seed(count: number, profileId = P) {
  await ensureBootstrap();
  for (let i = 1; i <= count; i++) await saveRating(profileId, `movie:${i}` as TitleKey, { overall: (i % 10) + 1, watched: true });
  await recordLedger(profileId);
}

/** Simula que el navegador borró la base IndexedDB (el registro de control en localStorage puede sobrevivir o no) */
async function wipeIndexedDb() {
  db.close();
  await db.delete();
  useTestDb(name);
}

describe('v3.6 · revisión de integridad al abrir', () => {
  it('instalación nueva: estado «new» y sin escribir nada', async () => {
    const r = await checkIntegrity(localBackupInfo);
    expect(r.state).toBe('new');
    expect(await db.config.count()).toBe(0);
    expect(await db.profiles.count()).toBe(0);
  });

  it('base sana: estado «ok» con el conteo por perfil', async () => {
    await seed(12);
    const r = await checkIntegrity(localBackupInfo);
    expect(r.state).toBe('ok');
    expect(r.counts[P]).toBe(12);
    expect(readLedger()?.total).toBe(12);
  });

  it('error de lectura: «read-error», nunca «new», y no se crea ningún perfil', async () => {
    vi.spyOn(db.config, 'get').mockRejectedValue(new Error('UnknownError: Connection to Indexed Database server lost'));
    const r = await checkIntegrity(localBackupInfo);
    expect(r.state).toBe('read-error');
    expect(r.error).toMatch(/Connection/);
    vi.restoreAllMocks();
    expect(await db.config.count()).toBe(0);
    expect(await db.profiles.count()).toBe(0);
  });

  it('error al abrir la base: también «read-error»', async () => {
    db.close();
    vi.spyOn(db, 'open').mockRejectedValue(new Error('QuotaExceededError'));
    const r = await checkIntegrity(localBackupInfo);
    expect(r.state).toBe('read-error');
  });

  it('pérdida total de IndexedDB con el registro de control intacto: «suspected-loss»', async () => {
    await seed(30);
    await wipeIndexedDb();
    const r = await checkIntegrity(localBackupInfo);
    expect(r.state).toBe('suspected-loss');
    expect(r.expectedTotal).toBe(30);
    expect(r.total).toBe(0);
    // Revisar no inicializa nada
    expect(await db.config.count()).toBe(0);
  });

  it('pérdida de la base principal sin registro pero con copias locales: «suspected-loss»', async () => {
    await seed(8);
    await createLocalBackup('manual');
    await wipeIndexedDb();
    localStorage.clear();
    const r = await checkIntegrity(localBackupInfo);
    expect(r.state).toBe('suspected-loss');
    expect(r.localBackupMaxRatings).toBe(8);
  });

  it('pérdida parcial grande (30 → 5): «suspected-loss»; pequeña (30 → 27): «ok»', async () => {
    await seed(30);
    await db.ratings.bulkDelete(Array.from({ length: 25 }, (_, i) => `${P}|movie:${i + 1}`));
    expect((await checkIntegrity()).state).toBe('suspected-loss');
    await acceptCurrentState();
    await seed(0);
    expect((await checkIntegrity()).state).toBe('ok');
    await db.ratings.bulkDelete([`${P}|movie:26`, `${P}|movie:27`, `${P}|movie:28`]);
    expect((await checkIntegrity()).state).toBe('ok');
  });

  it('una caída brusca con la app abierta no baja el registro (la próxima apertura avisa)', async () => {
    await seed(20);
    await db.ratings.clear();
    await saveRating(P, 'movie:99' as TitleKey, { overall: 7 });
    await recordLedger(P);
    expect(readLedger()?.total).toBe(20);
    expect(readLedger()?.suspectAt).toBeTypeOf('number');
    expect((await checkIntegrity()).state).toBe('suspected-loss');
    // Sólo una decisión explícita lo acepta
    await acceptCurrentState();
    expect(readLedger()?.total).toBe(1);
    expect(readLedger()?.suspectAt).toBeUndefined();
  });

  it('borrar valoraciones de a una no se toma como pérdida', async () => {
    await seed(10);
    for (let i = 1; i <= 10; i++) { await db.ratings.delete(`${P}|movie:${i}`); await recordLedger(P); }
    expect(readLedger()?.total).toBe(0);
    expect((await checkIntegrity()).state).not.toBe('suspected-loss');
  });

  it('«Borrar todos mis datos» limpia el registro: la próxima apertura es «new», no pérdida', async () => {
    await seed(10);
    await deleteAllData();
    expect(localStorage.getItem(LEDGER_KEY)).toBeNull();
    expect((await checkIntegrity()).state).toBe('new');
  });

  it('registro de control corrupto: se ignora sin romper', async () => {
    await seed(3);
    localStorage.setItem(LEDGER_KEY, '{no es json');
    expect(readLedger()).toBeUndefined();
    expect((await checkIntegrity()).state).toBe('ok');
  });
});

describe('v3.6 · perfiles (causa reproducible: perfil vacío activado por error)', () => {
  it('perfil activo vacío con valoraciones en otro: se informa, no es pérdida', async () => {
    await seed(15);
    const p = await createProfile('Prueba');
    await updateConfig({ activeProfileId: p.id });
    const r = await checkIntegrity();
    expect(r.state).toBe('ok');
    expect(r.otherProfileHasRatings).toEqual({ id: P, name: 'Principal', count: 15 });
    // Las valoraciones siguen intactas en el perfil original
    expect(await listRatings(P)).toHaveLength(15);
  });

  it('no se puede crear un perfil sin nombre ni repetido', async () => {
    await ensureBootstrap();
    await expect(createProfile('')).rejects.toThrow(/nombre/);
    await expect(createProfile('   ')).rejects.toThrow(/nombre/);
    await expect(createProfile('principal')).rejects.toThrow(/Ya existe/);
    expect(await db.profiles.count()).toBe(1);
  });
});

describe('v3.6 · importación segura (fusión)', () => {
  it('un archivo viejo nunca pisa valoraciones más nuevas; agrega las que faltan', async () => {
    await seed(5);
    const old = JSON.parse(JSON.stringify(await exportData()));
    await new Promise((r) => setTimeout(r, 5));
    await saveRating(P, 'movie:1' as TitleKey, { overall: 2 }); // cambio posterior a la exportación
    await saveRating(P, 'movie:50' as TitleKey, { overall: 9 }); // título nuevo
    await db.ratings.delete(`${P}|movie:3`); // se perdió uno
    const plan = await planImport(old);
    expect(plan).toMatchObject({ added: 1, updated: 0, keptNewer: 4 });
    // La vista previa no escribe
    expect(await db.ratings.get(`${P}|movie:3`)).toBeUndefined();
    const r = await importData(old);
    expect(r.ratings).toBe(1);
    expect((await db.ratings.get(`${P}|movie:1`))?.overall).toBe(2);
    expect((await db.ratings.get(`${P}|movie:50`))?.overall).toBe(9);
    expect(await db.ratings.get(`${P}|movie:3`)).toBeDefined();
  });

  it('un archivo con versiones más nuevas sí actualiza', async () => {
    await seed(2);
    const data = JSON.parse(JSON.stringify(await exportData()));
    data.ratings[0].overall = 4;
    data.ratings[0].updatedAt += 1000;
    const plan = await mergeImport(data);
    expect(plan.updated).toBe(1);
    expect((await db.ratings.get(data.ratings[0].id))?.overall).toBe(4);
  });

  it('no cambia ajustes ni nombres de perfiles existentes; agrega perfiles que faltan', async () => {
    await seed(2);
    await updateSettings(P, { country: 'ES' });
    const data = JSON.parse(JSON.stringify(await exportData()));
    data.settings[0].country = 'MX';
    data.profiles[0].name = 'Otro nombre';
    data.profiles.push({ id: 'p-x', name: 'Familia', createdAt: 1 });
    data.ratings.push({ ...data.ratings[0], id: 'p-x|movie:7', profileId: 'p-x', key: 'movie:7' });
    await mergeImport(data);
    expect((await db.settings.get(P))?.country).toBe('ES');
    expect((await db.profiles.get(P))?.name).toBe('Principal');
    expect((await db.profiles.get('p-x'))?.name).toBe('Familia');
    expect(await listRatings('p-x')).toHaveLength(1);
  });

  it('valoraciones de un perfil ausente en el archivo crean el perfil para que se vean', async () => {
    await ensureBootstrap();
    await mergeImport({ format: 'cine-match-export/3', ratings: [{ id: 'p-zz|movie:1', profileId: 'p-zz', key: 'movie:1', watched: true, overall: 8, dimensions: {}, createdAt: 1, updatedAt: 2, schema: 3 }] });
    expect(await db.profiles.get('p-zz')).toBeDefined();
  });

  it('archivo inválido: error claro y nada cambia', async () => {
    await seed(3);
    await expect(planImport({ format: 'otro' })).rejects.toThrow(/no es una exportación válida/);
    expect(await db.ratings.count()).toBe(3);
  });
});

describe('v3.6 · copias locales y recuperación tras pérdida', () => {
  it('no guarda copias vacías; las automáticas se espacian', async () => {
    await ensureBootstrap();
    expect(await createLocalBackup('auto')).toBeUndefined();
    await seed(3);
    expect(await createLocalBackup('auto')).toBeDefined();
    expect(await createLocalBackup('auto')).toBeUndefined();
    expect(await createLocalBackup('manual')).toBeDefined();
    expect(await listLocalBackups()).toHaveLength(2);
  });

  it('el recorte de copias nunca descarta la que tiene más valoraciones', async () => {
    await seed(10);
    await createLocalBackup('manual');
    await db.ratings.bulkDelete(Array.from({ length: 9 }, (_, i) => `${P}|movie:${i + 1}`));
    for (let i = 0; i < BACKUP_POLICY.keep + 3; i++) await createLocalBackup('manual');
    const metas = await listLocalBackups();
    expect(metas).toHaveLength(BACKUP_POLICY.keep + 1);
    expect(Math.max(...metas.map((m) => m.total))).toBe(10);
  });

  it('flujo completo: pérdida → modo recuperación → restaurar copia local → estado sano, sin duplicados', async () => {
    await seed(25);
    await createLocalBackup('manual');
    await wipeIndexedDb();
    expect((await checkIntegrity(localBackupInfo)).state).toBe('suspected-loss');
    const [meta] = await listLocalBackups();
    const b = await getLocalBackup(meta.id!);
    const plan = await mergeImport(b!.data);
    expect(plan.added).toBe(25);
    expect((await checkIntegrity(localBackupInfo)).state).toBe('ok');
    expect(await listRatings(P)).toHaveLength(25);
    // Restaurar dos veces no duplica ni cambia nada
    const again = await mergeImport(b!.data);
    expect(again).toMatchObject({ added: 0, updated: 0, keptNewer: 25 });
  });

  it('el respaldo externo (exportación del 23/11) se puede previsualizar y fusionar, nunca se importa solo', async () => {
    await seed(6);
    const backup2311 = JSON.parse(JSON.stringify(await exportData()));
    await wipeIndexedDb();
    // Abrir la app no importa nada: sólo revisa
    expect((await checkIntegrity(localBackupInfo)).state).toBe('suspected-loss');
    expect(await db.ratings.count()).toBe(0);
    expect((await planImport(backup2311)).added).toBe(6);
    expect(await db.ratings.count()).toBe(0);
  });
});

describe('v3.6 · recordatorio de copia externa y almacenamiento persistente', () => {
  it('recuerda la copia si nunca se hizo o pasó el plazo con valoraciones nuevas', async () => {
    await seed(4);
    expect(externalBackupDue().due).toBe(true);
    patchLedger({ lastExternalBackupAt: Date.now(), lastExternalBackupTotal: 4 });
    expect(externalBackupDue().due).toBe(false);
    const later = Date.now() + (BACKUP_POLICY.remindAfterDays + 1) * 86400000;
    expect(externalBackupDue(later).due).toBe(false); // sin cambios desde la copia
    await saveRating(P, 'movie:77' as TitleKey, { overall: 6 });
    await recordLedger(P);
    expect(externalBackupDue(later).due).toBe(true);
  });

  it('informa si el navegador no concede almacenamiento persistente', async () => {
    const storage = { persisted: vi.fn().mockResolvedValue(false), persist: vi.fn().mockResolvedValue(false), estimate: vi.fn().mockResolvedValue({ usage: 1024, quota: 2048 }) };
    vi.stubGlobal('navigator', { ...navigator, storage });
    const s = await requestPersistence();
    expect(s).toMatchObject({ supported: true, persisted: false, usage: 1024 });
    expect(storage.persist).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('v3.6 · la app nunca muestra un perfil nuevo ante una pérdida o un error', () => {
  const mount = () => render(createElement(HashRouter, null, createElement(AppProvider, null, createElement('div', { 'data-testid': 'app-content' }, 'app'))));

  it('pérdida detectada: muestra Recuperación y no crea perfil ni configuración', async () => {
    await seed(12);
    await wipeIndexedDb();
    mount();
    await screen.findByTestId('recovery-loss');
    expect(screen.queryByTestId('app-content')).toBeNull();
    expect(await db.config.count()).toBe(0);
    expect(await db.profiles.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
  });

  it('error de lectura: muestra el error con «Reintentar», no la app vacía', async () => {
    await seed(3);
    vi.spyOn(db.ratings, 'each').mockRejectedValue(new Error('UnknownError'));
    mount();
    await screen.findByTestId('recovery-read-error');
    expect(screen.queryByTestId('app-content')).toBeNull();
  });

  it('base sana: abre la app normalmente', async () => {
    await seed(3);
    await updateConfig({ proxyUrl: 'https://proxy.example/3' });
    mount();
    await waitFor(() => expect(screen.getByTestId('app-content')).toBeTruthy());
  });
});

describe('v3.6 · historial para el diagnóstico (sólo lectura)', () => {
  it('cuenta eventos, muestra la caída en los cálculos y lista los títulos que faltan', async () => {
    await ensureBootstrap();
    const t0 = Date.now();
    await db.logs.bulkAdd([
      { profileId: P, at: t0 - 3000, type: 'rating_saved', key: 'movie:1' as TitleKey },
      { profileId: P, at: t0 - 2000, type: 'rating_saved', key: 'movie:2' as TitleKey },
      { profileId: P, at: t0 - 1500, type: 'rating_deleted', key: 'movie:2' as TitleKey },
      { profileId: P, at: t0 - 1000, type: 'rating_saved', key: 'tv:3' as TitleKey },
    ]);
    await db.runs.bulkAdd([
      { profileId: P, algorithmVersion: 'x', createdAt: t0 - 2500, trigger: 'valoración', ratingsCount: 40, country: 'AR', items: [], pool: [] },
      { profileId: P, algorithmVersion: 'x', createdAt: t0 - 500, trigger: 'valoración', ratingsCount: 0, country: 'AR', items: [], pool: [] },
    ]);
    await db.titles.put({ key: 'movie:1', type: 'movie', tmdbId: 1, title: 'Película Uno' } as any);
    await saveRating(P, 'tv:3' as TitleKey, { overall: 7 });
    const before = await db.ratings.count();
    const a = await activitySummary(P);
    expect(a.byType).toMatchObject({ rating_saved: 3, rating_deleted: 1 });
    expect(a.runs.map((r) => r.ratingsCount)).toEqual([40, 0]);
    // movie:2 se borró a propósito y tv:3 existe: sólo falta movie:1
    expect(a.missingKeys).toEqual([{ key: 'movie:1', title: 'Película Uno', lastSavedAt: t0 - 3000 }]);
    expect(await db.ratings.count()).toBe(before);
  });
});
