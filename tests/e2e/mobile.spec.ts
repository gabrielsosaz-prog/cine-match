import { expect, test, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// Proveedor SIMULADO (catálogo sintético): valida la interfaz, no los datos reales de TMDB.
const handler = fakeTmdbHandler(buildCatalog(15));

async function mockTmdb(page: Page) {
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const { status, body } = await handler(route.request().url());
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('flujo completo en Android: configurar, incorporar, recomendar, buscar y valorar', async ({ page }, info) => {
  await mockTmdb(page);
  await page.goto('/');
  await expect(page).toHaveURL(/#\/configurar/);
  await noHorizontalScroll(page);
  await page.getByTestId('token-input').fill('eyJprueba');
  await page.getByTestId('save-token').click();

  // Incorporación inicial
  await expect(page.getByText('Paso 1 de 3')).toBeVisible();
  await page.getByTestId('ob-next').click();
  await expect(page.getByTestId('quick-card').first()).toBeVisible();
  await noHorizontalScroll(page);
  const cards = page.getByTestId('quick-card');
  for (let i = 0; i < 4; i++) await cards.nth(i).getByRole('button', { name: /: (9|8)$/ }).first().click();
  await cards.nth(4).getByRole('button', { name: 'No me interesa' }).click();
  await page.screenshot({ path: `test-results/${info.project.name}-onboarding.png` });
  await page.getByTestId('ob-finish').click();

  // Inicio con ranking explicado
  await expect(page.getByRole('heading', { name: 'Para vos' })).toBeVisible();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('rec-explanation').first()).not.toBeEmpty();
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-inicio.png`, fullPage: false });

  // Filtro por plataforma y tipo
  await page.getByTestId('filter-netflix').click();
  await page.getByTestId('filter-tv').click();
  const count = await page.getByTestId('rec-item').count();
  for (let i = 0; i < Math.min(count, 5); i++) await expect(page.getByTestId('rec-item').nth(i)).toContainText('Netflix');
  await page.getByTestId('filter-netflix').click();

  // Buscar y distinguir homónimos
  await page.getByRole('link', { name: /Buscar/ }).click();
  await page.getByTestId('search-input').fill('La Casa');
  await expect(page.getByTestId('search-result')).toHaveCount(2);
  await expect(page.getByTestId('search-result').filter({ hasText: 'Película' })).toHaveCount(1);
  await expect(page.getByTestId('search-result').filter({ hasText: 'Serie' })).toHaveCount(1);

  // Ficha y valoración por dimensiones
  await page.getByTestId('search-input').fill('Scifi Film');
  await page.getByTestId('search-result').filter({ hasText: 'Scifi Film' }).first().click();
  await expect(page.getByText('Dónde verla (AR)')).toBeVisible();
  await page.getByTestId('overall').getByRole('button', { name: 'Valoración general: 9' }).click();
  await page.getByRole('button', { name: /Puntuar aspectos/ }).click();
  await page.getByTestId('dim-suspense').getByRole('button', { name: /: 10$/ }).click();
  await page.getByTestId('dim-ending').getByRole('button', { name: /: 7$/ }).click();
  await page.getByTestId('save-rating').click();
  await expect(page.getByTestId('save-status')).toContainText('Ranking actualizado');
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-ficha.png`, fullPage: true });

  // Modificar la valoración
  await page.getByTestId('overall').getByRole('button', { name: 'Valoración general: 6' }).click();
  await page.getByTestId('save-rating').click();
  await expect(page.getByTestId('save-status')).toContainText('Guardado');

  // Persistencia entre sesiones: recargar
  await page.reload();
  await page.getByRole('link', { name: /Valoraciones/ }).click();
  await expect(page.getByTestId('rating-row').filter({ hasText: 'Scifi Film' })).toContainText('6');
  await page.screenshot({ path: `test-results/${info.project.name}-valoraciones.png` });

  // Perfil de gustos
  await page.getByRole('link', { name: /Mis gustos/ }).click();
  await expect(page.getByText('Géneros preferidos')).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-gustos.png`, fullPage: true });
});

test('error del proveedor: muestra aviso claro sin romper la app', async ({ page }) => {
  await page.route('https://api.themoviedb.org/**', (r) => r.fulfill({ status: 401, body: '{}' }));
  await page.goto('/');
  await page.getByTestId('token-input').fill('eyJmala');
  await page.getByTestId('save-token').click();
  await expect(page.getByRole('alert')).toContainText('rechazó la clave');
});

test('con el token en el servidor no pide nada al usuario y usa el proxy propio', async ({ page }) => {
  let direct = 0;
  await page.route('https://api.themoviedb.org/**', (r) => { direct++; return r.fulfill({ status: 500 }); });
  await page.route('**/api/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, tokenConfigured: true, tmdbStatus: 200 }) }));
  const proxied: string[] = [];
  await page.route('**/api/tmdb/**', async (route) => {
    const u = new URL(route.request().url());
    proxied.push(u.pathname);
    expect(route.request().headers()['authorization']).toBeUndefined();
    const { status, body } = await handler('https://api.themoviedb.org/3' + u.pathname.replace('/api/tmdb', '') + u.search);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await expect(page.getByText('Paso 1 de 3')).toBeVisible();
  await page.getByTestId('ob-next').click();
  await expect(page.getByTestId('quick-card').first()).toBeVisible();
  expect(proxied.length).toBeGreaterThan(0);
  expect(direct).toBe(0);
});

test('servidor sin token: lo indica claramente', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('server-status')).toContainText(/no tiene/);
});

test('manifest PWA instalable', async ({ page }) => {
  await page.goto('/');
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]')!.getAttribute('href')!)).json());
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i: any) => i.sizes === '512x512')).toBe(true);
  expect(manifest.lang).toBe('es-AR');
});

// ---------------- v2.0 ----------------
async function onboardQuick(page: Page) {
  await mockTmdb(page);
  await page.goto('/');
  await page.getByTestId('token-input').fill('eyJprueba');
  await page.getByTestId('save-token').click();
  await page.getByTestId('ob-next').click();
  const cards = page.getByTestId('quick-card');
  await expect(cards.first()).toBeVisible();
  for (let i = 0; i < 5; i++) await cards.nth(i).getByRole('button', { name: /: (9|8)$/ }).first().click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 20000 });
}
const titleOf = async (card: ReturnType<Page['getByTestId']>) => (await card.locator('h3').innerText()).trim();

test('v2: filtro de vistos y acciones rápidas sin salir del ranking', async ({ page }, info) => {
  await onboardQuick(page);
  await expect(page.getByTestId('watched-filter-unwatched')).toHaveAttribute('aria-checked', 'true');
  const first = page.getByTestId('rec-item').first();
  const name = await titleOf(first);

  // Marcar vista con una sola acción: la tarjeta queda visible hasta cambiar de filtro
  await first.getByTestId('quick-watched').click();
  await expect(first.getByTestId('quick-watched')).toHaveText(/Vista/);
  await expect(page).toHaveURL(/#\/$/);
  await page.getByTestId('watched-filter-watched').click();
  await expect(page.getByTestId('rec-item').filter({ hasText: name })).toHaveCount(1);
  await page.getByTestId('watched-filter-unwatched').click();
  await expect(page.getByTestId('rec-item').filter({ hasText: name })).toHaveCount(0);
  await page.getByTestId('watched-filter-all').click();
  await expect(page.getByTestId('rec-item').filter({ hasText: name })).toHaveCount(1);
  await page.getByTestId('watched-filter-unwatched').click();

  // Puntuación general rápida: no marca vista, recalcula y no cambia de pantalla
  const card = page.getByTestId('rec-item').nth(1);
  const scoredName = await titleOf(card);
  await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await card.getByTestId('quick-score').click();
  await expect(card.getByTestId('quick-score-row')).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v2-acciones.png` });
  await card.getByRole('button', { name: 'Nota general 9' }).click();
  await expect(page.getByTestId('rank-notice')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/#\/$/);
  const scoredCard = page.getByTestId('rec-item').filter({ hasText: scoredName });
  await expect(scoredCard).toHaveCount(1); // puntuar no la marca como vista
  await expect(scoredCard.getByTestId('quick-watched')).toHaveText(/Marcar vista/);
  await expect(scoredCard).toContainText('tu nota');

  // Panel de aspectos dentro del ranking, editando la valoración existente
  await scoredCard.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await scoredCard.getByTestId('quick-aspects').click();
  const sheet = page.getByTestId('aspects-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('overall')).toContainText('9');
  await sheet.getByTestId('dim-acting').getByRole('button', { name: /: 8$/ }).click();
  await sheet.getByTestId('dim-pacing').getByRole('button', { name: /: 4$/ }).click();
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v2-aspectos.png` });
  await sheet.getByTestId('save-rating').click();
  await expect(sheet).toBeHidden({ timeout: 15000 });
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId('rec-item').filter({ hasText: scoredName }).getByTestId('quick-aspects')).toContainText('(2)');

  // Combinado con plataforma y tipo
  await page.getByTestId('filter-tv').click();
  await page.getByTestId('watched-filter-all').click();
  const n = await page.getByTestId('rec-item').count();
  for (let i = 0; i < Math.min(n, 4); i++) await expect(page.getByTestId('rec-item').nth(i)).toContainText('Serie');
  await page.screenshot({ path: `test-results/${info.project.name}-v2-inicio.png` });
});

test('v2: las valoraciones de la versión anterior siguen apareciendo', async ({ page }) => {
  await mockTmdb(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const req = indexedDB.open('cine-match', 10); // Dexie v1 = versión 10 de IndexedDB
    req.onupgradeneeded = () => {
      const d = req.result;
      const mk = (n: string, keyPath: string | null, auto = false, idx: [string, string | string[]][] = []) => {
        const s = d.createObjectStore(n, keyPath ? { keyPath, autoIncrement: auto } : { autoIncrement: auto });
        for (const [name, kp] of idx) s.createIndex(name, kp);
        return s;
      };
      mk('titles', 'key', false, [['type', 'type'], ['fetchedAt', 'fetchedAt']]);
      mk('availability', 'id', false, [['key', 'key'], ['country', 'country'], ['checkedAt', 'checkedAt']]);
      mk('availabilityEvents', 'id', true, [['key', 'key'], ['country', 'country'], ['detectedAt', 'detectedAt']]);
      const r = mk('ratings', 'id', false, [['profileId', 'profileId'], ['key', 'key'], ['status', 'status'], ['updatedAt', 'updatedAt'], ['[profileId+status]', ['profileId', 'status']]]);
      mk('profiles', 'id'); mk('settings', 'profileId'); mk('config', 'id');
      mk('runs', 'id', true, [['profileId', 'profileId'], ['createdAt', 'createdAt']]);
      mk('snapshots', 'id', true, [['profileId', 'profileId'], ['at', 'at']]);
      mk('logs', 'id', true, [['profileId', 'profileId'], ['at', 'at'], ['type', 'type']]);
      const tx = req.transaction!;
      tx.objectStore('config').put({ id: 'app', activeProfileId: 'p-principal', tmdbToken: 'eyJprueba' });
      tx.objectStore('profiles').put({ id: 'p-principal', name: 'Principal', createdAt: 1 });
      tx.objectStore('settings').put({ profileId: 'p-principal', country: 'AR', platforms: ['netflix', 'prime', 'disney', 'max'], language: 'es-MX', excludedGenres: [], includeUnconfirmed: false, dimensionWeights: {}, onboarded: true });
      const P = 'p-principal';
      r.put({ id: `${P}|movie:1000`, profileId: P, key: 'movie:1000', status: 'rated', overall: 9, dimensions: { story: 10, characters: 8 }, createdAt: 1, updatedAt: 2 });
      r.put({ id: `${P}|tv:1001`, profileId: P, key: 'tv:1001', status: 'want', dimensions: {}, createdAt: 1, updatedAt: 3 });
      r.put({ id: `${P}|movie:1002`, profileId: P, key: 'movie:1002', status: 'abandoned', abandonReason: 'Ritmo muy lento', dimensions: {}, createdAt: 1, updatedAt: 4 });
      for (const [k, name] of [['movie:1000', 'Película antigua'], ['tv:1001', 'Serie pendiente'], ['movie:1002', 'Película abandonada']]) {
        const [type, id] = k.split(':');
        tx.objectStore('titles').put({ key: k, type, tmdbId: Number(id), title: name, genres: [], keywords: [], cast: [], directors: [], completeness: 'basic', missing: [], source: 'TMDB', fetchedAt: Date.now() });
      }
    };
    req.onsuccess = () => req.result.close();
  });
  await page.goto('/#/valoraciones');
  const rows = page.getByTestId('rating-row');
  await expect(rows).toHaveCount(3, { timeout: 15000 });
  const old = rows.filter({ hasText: 'Película antigua' });
  await expect(old.getByTestId('row-score')).toHaveText('9');
  await expect(old.getByTestId('row-watched')).toHaveText(/Vista/);
  await expect(old).toContainText('2 aspectos');
  await expect(rows.filter({ hasText: 'Serie pendiente' })).toContainText('Quiero verla');
  await expect(rows.filter({ hasText: 'Película abandonada' })).toContainText('Ritmo muy lento');
  await page.getByTestId('view-watched').click();
  await expect(rows).toHaveCount(1);
  // Cambiar el estado de visto desde la lista no borra la nota
  await page.getByTestId('view-all').click();
  await old.getByTestId('row-watched').click();
  await expect(old.getByTestId('row-watched')).toHaveText('No vista');
  await expect(old.getByTestId('row-score')).toHaveText('9');
});
