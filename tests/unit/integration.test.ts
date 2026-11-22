import { beforeEach, describe, expect, it } from 'vitest';
import { db, useTestDb } from '../../src/db/db';
import { ensureBootstrap, updateConfig, updateSettings } from '../../src/db/repo';
import { getTitle, searchTitles, setFetch } from '../../src/services/catalog';
import { latestRun, refreshRecommendations } from '../../src/services/recommendations';
import { rateAndLearn } from '../../src/services/ratings';
import { matchesPlatforms } from '../../src/services/availability';
import { buildCatalog, fakeFetch } from '../fixtures/fakeTmdb';
import type { TitleKey } from '../../src/types';

const catalog = buildCatalog(15);
const P = 'p-principal';
let n = 0;
beforeEach(async () => {
  useTestDb(`integ-${n++}`);
  setFetch(fakeFetch(catalog));
  await ensureBootstrap();
  await updateConfig({ tmdbToken: 'eyJtest' });
});

describe('Flujo completo con proveedor simulado', () => {
  it('buscar → valorar → ranking con versión del algoritmo → re-ranking', async () => {
    const hits = await searchTitles('Thriller Film', 'es-MX');
    expect(hits.length).toBeGreaterThan(2);
    const first = await rateAndLearn(P, hits[0].key, { overall: 9, dimensions: { suspense: 10 } });
    expect(first.run?.algorithmVersion).toMatch(/^hybrid/);
    expect(first.run!.items.length).toBeGreaterThan(0);
    // Puntuar no marca «vista»: el título sigue en el ranking de no vistos hasta que el usuario lo marque
    expect(first.run!.items.some((i) => i.key === hits[0].key)).toBe(true);
    const logs = await db.logs.where('type').equals('rating_saved').toArray();
    expect(logs[0].algorithmVersion).toBe(first.run!.algorithmVersion);
    const second = await rateAndLearn(P, hits[1].key, { overall: 2 });
    expect(second.run!.createdAt).toBeGreaterThanOrEqual(first.run!.createdAt);
    expect(second.run!.items.map((i) => i.key).join()).not.toBe(first.run!.items.map((i) => i.key).join());
    expect(await db.snapshots.count()).toBeGreaterThanOrEqual(2);
  });

  it('filtra por plataformas contratadas', async () => {
    await updateSettings(P, { platforms: ['disney'] });
    const run = await refreshRecommendations(P, { trigger: 'test', rebuildPool: true });
    expect(run.items.length).toBeGreaterThan(0);
    const snaps = await db.availability.bulkGet(run.items.map((i) => `${i.key}|AR`));
    expect(snaps.every((s) => matchesPlatforms(s, ['disney'], false))).toBe(true);
  });

  it('la ficha guarda metadata y disponibilidad por separado, con fuente y fecha', async () => {
    const t = catalog.find((x) => x.providers && x.providers.some((p) => p.id === 8))!;
    const key = `${t.type}:${t.id}` as TitleKey;
    const r = await getTitle(key, { language: 'es-MX', country: 'AR' });
    expect(r.meta?.completeness).toBe('full');
    expect(r.availability?.source).toBe('TMDB / JustWatch');
    expect(await db.availability.get(`${key}|AR`)).toBeDefined();
    expect((await db.titles.get(key))?.keywords.length).toBeGreaterThan(0);
  });

  it('sinopsis faltante en español usa la inglesa y lo indica', async () => {
    const t = catalog.find((x) => !x.overview)!;
    const r = await getTitle(`${t.type}:${t.id}` as TitleKey, { language: 'es-MX', country: 'AR' });
    expect(r.meta?.overviewLang).toBe('en');
  });

  it('si el proveedor falla, conserva datos guardados y no rompe', async () => {
    const t = catalog[3];
    const key = `${t.type}:${t.id}` as TitleKey;
    await getTitle(key, { language: 'es-MX', country: 'AR' });
    setFetch(fakeFetch(catalog, { status: 503 }));
    const r = await getTitle(key, { language: 'es-MX', country: 'AR', force: true });
    expect(r.error).toBeDefined();
    expect(r.meta?.title).toBe(t.name);
    const run = await refreshRecommendations(P, { trigger: 'test', rebuildPool: true });
    expect(run.warning).toBeTruthy();
  });

  it('sin clave configurada informa el error de configuración', async () => {
    await updateConfig({ tmdbToken: undefined });
    await expect(searchTitles('x', 'es-MX')).rejects.toMatchObject({ kind: 'config' });
  });

  it('arranque en frío: genera recomendaciones provisionales sin valoraciones', async () => {
    const run = await refreshRecommendations(P, { trigger: 'incorporación', rebuildPool: true });
    expect(run.items.length).toBeGreaterThan(0);
    expect(run.items.every((i) => i.provisional)).toBe(true);
    expect((await latestRun(P))?.id).toBe(run.id);
  });
});

describe('v2: visto, rechazo y aprendizaje en el flujo completo', () => {
  it('marcar vista no recalcula ni cambia el perfil; rechazar sí excluye', async () => {
    const hits = await searchTitles('Comedy Film', 'es-MX');
    await rateAndLearn(P, hits[0].key, { overall: 8 });
    const before = (await latestRun(P))!;
    const { run } = await rateAndLearn(P, hits[1].key, { watched: true });
    expect(run).toBeUndefined(); // «vista» no es señal de gusto
    expect((await latestRun(P))!.id).toBe(before.id);
    const rej = await rateAndLearn(P, hits[2].key, { notInterested: true });
    expect(rej.run!.items.some((i) => i.key === hits[2].key)).toBe(false);
  });
});
