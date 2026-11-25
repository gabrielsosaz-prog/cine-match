import { expect, test, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// v3.6 · Incidente de pérdida de valoraciones: flujos de recuperación en Android (proveedor SIMULADO).
const handler = fakeTmdbHandler(buildCatalog(15));
async function mockTmdb(page: Page) {
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const { status, body } = await handler(route.request().url());
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
}

const P = 'p-principal';
const rating = (i: number, updatedAt = 1000 + i) => ({ id: `${P}|movie:${i}`, profileId: P, key: `movie:${i}`, watched: true, overall: (i % 10) + 1, dimensions: {}, createdAt: 1, updatedAt, schema: 3 });

/** Base v3 con config, perfil y N valoraciones, creada directamente en IndexedDB (versión Dexie 3 = 30). */
async function seedDb(page: Page, count: number, ledgerTotal?: number) {
  // Página del mismo origen que NO carga la app (así ninguna conexión abierta bloquea la siembra)
  await page.goto('/icon.svg');
  await page.evaluate(async ({ count, ledgerTotal, ratings }) => {
    await new Promise<void>((res) => { const d = indexedDB.deleteDatabase('cine-match'); d.onsuccess = d.onerror = d.onblocked = () => res(); });
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('cine-match', 30);
      req.onupgradeneeded = () => {
        const d = req.result;
        const mk = (n: string, keyPath: string, auto = false, idx: [string, string | string[]][] = []) => {
          const s = d.createObjectStore(n, { keyPath, autoIncrement: auto });
          for (const [name, kp] of idx) s.createIndex(name, kp);
          return s;
        };
        mk('titles', 'key', false, [['type', 'type'], ['fetchedAt', 'fetchedAt']]);
        mk('availability', 'id', false, [['key', 'key'], ['country', 'country'], ['checkedAt', 'checkedAt']]);
        mk('availabilityEvents', 'id', true, [['key', 'key'], ['country', 'country'], ['detectedAt', 'detectedAt']]);
        const r = mk('ratings', 'id', false, [['profileId', 'profileId'], ['key', 'key'], ['updatedAt', 'updatedAt'], ['[profileId+list]', ['profileId', 'list']]]);
        mk('profiles', 'id'); mk('settings', 'profileId'); mk('config', 'id');
        mk('runs', 'id', true, [['profileId', 'profileId'], ['createdAt', 'createdAt']]);
        mk('snapshots', 'id', true, [['profileId', 'profileId'], ['at', 'at']]);
        mk('logs', 'id', true, [['profileId', 'profileId'], ['at', 'at'], ['type', 'type']]);
        const tx = req.transaction!;
        tx.objectStore('config').put({ id: 'app', activeProfileId: 'p-principal', tmdbToken: 'eyJprueba' });
        tx.objectStore('profiles').put({ id: 'p-principal', name: 'Principal', createdAt: 1 });
        tx.objectStore('settings').put({ profileId: 'p-principal', country: 'AR', platforms: ['netflix'], language: 'es-MX', excludedGenres: [], includeUnconfirmed: false, dimensionWeights: {}, onboarded: true });
        for (const x of ratings.slice(0, count)) r.put(x);
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    if (ledgerTotal !== undefined) localStorage.setItem('cine-match:ledger', JSON.stringify({ counts: { 'p-principal': ledgerTotal }, total: ledgerTotal, at: Date.now() - 86400000 }));
  }, { count, ledgerTotal, ratings: Array.from({ length: 40 }, (_, i) => rating(i + 1)) });
}

test('pérdida detectada al abrir: Recuperación en lugar de un perfil nuevo; el respaldo se previsualiza y se fusiona sin pisar', async ({ page }, info) => {
  await mockTmdb(page);
  await seedDb(page, 3, 40);
  await page.goto('/');
  await page.reload();
  await expect(page.getByTestId('recovery-loss')).toBeVisible();
  await expect(page.getByTestId('recovery-loss')).toContainText('40');
  await expect(page.getByText('Paso 1 de 3')).toHaveCount(0);
  await page.screenshot({ path: `test-results/${info.project.name}-v36-recuperacion.png` });

  // Respaldo con 40 valoraciones; la n.º 1 del dispositivo es más nueva que la del archivo y no se pisa
  await page.evaluate(() => new Promise<void>((res) => {
    const req = indexedDB.open('cine-match');
    req.onsuccess = () => { const tx = req.result.transaction('ratings', 'readwrite'); tx.objectStore('ratings').put({ id: 'p-principal|movie:1', profileId: 'p-principal', key: 'movie:1', watched: true, overall: 3, dimensions: {}, createdAt: 1, updatedAt: 999999999, schema: 3 }); tx.oncomplete = () => { req.result.close(); res(); }; };
  }));
  const backup = { format: 'cine-match-export/3', exportedAt: '2026-11-23T20:00:00.000Z', profiles: [{ id: P, name: 'Principal', createdAt: 1 }], settings: [], ratings: Array.from({ length: 40 }, (_, i) => rating(i + 1)) };
  await page.getByTestId('recovery-file').setInputFiles({ name: 'cine-match-2026-11-23.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.getByTestId('recovery-plan')).toBeVisible();
  await expect(page.getByTestId('plan-added')).toHaveText('37');
  await expect(page.getByTestId('plan-kept')).toHaveText('3');
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(noHScroll).toBeLessThanOrEqual(1);
  await page.getByTestId('plan-apply').click();
  await expect(page.getByRole('status')).toContainText('37 agregadas');
  await expect(page.getByTestId('recovery-profiles')).toContainText('40');
  await page.getByTestId('recovery-done').click();

  await page.goto('/#/ajustes');
  await expect(page.getByTestId('active-profile')).toContainText('40 valoraciones');
  const kept = await page.evaluate(() => new Promise<number>((res) => {
    const req = indexedDB.open('cine-match');
    req.onsuccess = () => { const g = req.result.transaction('ratings').objectStore('ratings').get('p-principal|movie:1'); g.onsuccess = () => { res(g.result.overall); req.result.close(); }; };
  }));
  expect(kept).toBe(3);
});

test('perfil vacío por error: no se puede crear sin nombre y la bienvenida ofrece volver al perfil con valoraciones', async ({ page }) => {
  await mockTmdb(page);
  await seedDb(page, 12, 12);
  page.on('dialog', (d) => d.accept());
  await page.goto('/#/ajustes');
  await page.reload();
  await expect(page.getByTestId('active-profile')).toContainText('12 valoraciones');
  const create = page.getByRole('button', { name: 'Crear' });
  await expect(create).toBeDisabled();
  await page.getByPlaceholder('Nombre del nuevo perfil').fill('Prueba');
  await create.click();
  await expect(page.getByTestId('active-profile')).toContainText('Prueba');
  await page.getByRole('link', { name: /Inicio/ }).click();
  await expect(page).toHaveURL(/#\/bienvenida/);
  await expect(page.getByTestId('ob-other-profile')).toContainText('12 valoraciones');
  await page.getByTestId('ob-other-switch').click();
  await expect(page.getByRole('heading', { name: 'Para vos' })).toBeVisible();
  await page.goto('/#/ajustes');
  await expect(page.getByTestId('active-profile')).toContainText('Principal');
  await expect(page.getByTestId('active-profile')).toContainText('12 valoraciones');
});

test('Ajustes muestra el estado de protección y la última copia externa', async ({ page }) => {
  await mockTmdb(page);
  await seedDb(page, 5, 5);
  await page.goto('/#/ajustes');
  await page.reload();
  await expect(page.getByTestId('backup-card')).toBeVisible();
  await expect(page.getByTestId('persist-status')).toContainText('Protección contra borrado automático');
  await expect(page.getByTestId('last-backup')).toContainText('nunca');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('backup-now').click()]);
  const json = JSON.parse(await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString()));
  expect(json.ratings).toHaveLength(5);
  expect(JSON.stringify(json)).not.toContain('eyJprueba');
  await expect(page.getByTestId('last-backup')).not.toContainText('nunca');
});
