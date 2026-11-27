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
  await expect(page.getByTestId('card-why').first()).not.toBeEmpty();
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
  await page.getByTestId('overall').getByRole('button', { name: 'Valoración general (1-10): 9' }).click();
  await page.getByTestId('toggle-aspects').click();
  await page.getByTestId('dim-suspense').getByRole('radio', { name: /5 estrellas$/ }).click();
  await page.getByTestId('dim-ending').getByRole('radio', { name: /4 estrellas$/ }).click();
  await page.getByTestId('save-rating').click();
  await expect(page.getByTestId('save-status')).toContainText('Modelo recalculado');
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-ficha.png`, fullPage: true });

  // Modificar la valoración
  await page.getByTestId('overall').getByRole('button', { name: 'Valoración general (1-10): 6' }).click();
  await page.getByTestId('save-rating').click();
  await expect(page.getByTestId('save-status')).toContainText('Guardado');

  // Persistencia entre sesiones: recargar
  await page.reload();
  await page.getByRole('link', { name: /^Notas$/ }).click();
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

  // Puntuación general rápida dentro de la tarjeta (v4.1: al guardar se marca vista), sin cambiar de pantalla
  const card = page.getByTestId('rec-item').nth(1);
  const scoredName = await titleOf(card);
  await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await card.getByTestId('quick-score').click();
  await expect(card.getByTestId('quick-score-row')).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v2-acciones.png` });
  await card.getByRole('button', { name: 'Nota general 9' }).click();
  await card.getByTestId('score-save').click();
  await expect(card.getByTestId('quick-score-row')).toBeHidden({ timeout: 15000 });
  await expect(page).toHaveURL(/#\/$/);
  const scoredCard = page.getByTestId('rec-item').filter({ hasText: scoredName });
  await expect(scoredCard).toHaveCount(1); // sigue en la lista hasta actualizar el ranking
  await expect(scoredCard.getByTestId('quick-watched')).toHaveAttribute('aria-pressed', 'true');
  await expect(scoredCard.getByTestId('quick-score')).toContainText('Tu nota 9');

  // Aspectos dentro de la tarjeta, editando la valoración existente
  await scoredCard.getByTestId('more-toggle').click();
  await scoredCard.getByTestId('quick-aspects').click();
  await scoredCard.getByTestId('dim-acting').getByRole('radio', { name: /4 estrellas$/ }).click();
  await scoredCard.getByTestId('dim-pacing').getByRole('radio', { name: /2 estrellas$/ }).click();
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v2-aspectos.png` });
  await scoredCard.getByTestId('aspects-save').click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(scoredCard.getByTestId('quick-aspects')).toContainText('2/7');
  await expect(scoredCard.getByTestId('quick-score')).toContainText('Tu nota 9');

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
  // story 10 → 5 estrellas; «Personajes» (retirado) se conserva como respaldo
  await expect(old.getByTestId('completion')).toHaveAttribute('data-percent', '14');
  await expect(old).toContainText('Conservado de la versión anterior: Personajes');
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

// ---------------- v2.1 ----------------
test('v2.1: puntuar varios títulos seguidos sin que desaparezcan; actualizar el orden a mano', async ({ page }, info) => {
  await onboardQuick(page);
  const items = page.getByTestId('rec-item');
  const before = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
  // Puntuar tres tarjetas seguidas (sólo nota general)
  for (const i of [0, 1, 2]) {
    const card = items.nth(i);
    await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await card.getByTestId('quick-score').click();
    await card.getByRole('button', { name: `Nota general ${7 + i}` }).click();
    await card.getByTestId('score-save').click();
    await expect(card.getByTestId('quick-score')).toContainText(`Tu nota ${7 + i}`, { timeout: 15000 });
  }
  // Marcar una como vista con el filtro «No vistos»: sigue visible durante la interacción
  await items.nth(3).getByTestId('quick-watched').click();
  await expect(page.getByTestId('pending-changes')).toBeVisible();
  const during = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
  expect(during.slice(0, 6)).toEqual(before.slice(0, 6)); // nada desapareció ni se reordenó
  await expect(page.getByTestId('pending-changes')).toContainText('todavía no se reflejan', { timeout: 15000 });
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v21-pendientes.png` });
  // Actualizar ranking: aplica el orden nuevo y saca la vista del filtro «No vistos»
  await page.getByTestId('apply-ranking').click();
  await expect(page.getByTestId('pending-changes')).toBeHidden({ timeout: 15000 });
  await expect(page.getByTestId('rank-notice')).toBeVisible();
  await expect(page.locator(`[data-testid="rec-item"][data-key="${before[3]}"]`)).toHaveCount(0);
});

test('v2.1: estrellas, «Otros» y borrador ante un cierre accidental', async ({ page }, info) => {
  await onboardQuick(page);
  const card = page.getByTestId('rec-item').nth(1);
  const key = await card.getAttribute('data-key');
  await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await card.getByTestId('quick-score').click();
  await card.getByRole('button', { name: 'Nota general 8' }).click();
  await card.getByTestId('score-save').click();
  await expect(card.getByTestId('quick-score')).toContainText('Tu nota 8', { timeout: 15000 });
  // v4.1: aspectos dentro de la tarjeta («Más información y acciones»)
  await card.getByTestId('more-toggle').click();
  await card.getByTestId('quick-aspects').click();
  const panel = card.getByTestId('aspects-panel');
  // Orden exacto de los siete aspectos
  const labels = await panel.locator('[data-testid^="dim-"]:not([data-testid$="-clear"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(labels).toEqual(['dim-story', 'dim-acting', 'dim-ending', 'dim-emotion', 'dim-visuals', 'dim-pacing', 'dim-suspense']);
  await expect(panel).not.toContainText('Originalidad');
  await expect(panel).not.toContainText('Personajes');
  await panel.getByTestId('dim-story').getByRole('radio', { name: /5 estrellas$/ }).click();
  await panel.getByTestId('dim-ending').getByRole('radio', { name: /3 estrellas$/ }).click();
  await panel.getByTestId('dim-ending-clear').click(); // quitar una estrella ya asignada
  await panel.getByTestId('aspects-save').click();
  await expect(card.getByTestId('quick-aspects')).toContainText('1/7', { timeout: 15000 });
  // Comentario: cerrar sin guardar conserva el borrador
  await card.getByTestId('card-comment').click();
  await card.getByTestId('comment').fill('Me gustó la idea de que en realidad vivimos dentro de una simulación.');
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v21-estrellas.png` });
  await card.getByTestId('card-comment').click(); // cierre accidental
  await expect(card.getByTestId('comment-panel')).toHaveCount(0);
  await card.getByTestId('card-comment').click();
  await expect(card.getByTestId('comment')).toHaveValue(/simulación/);
  await card.getByTestId('comment-save').click();
  await expect(card.getByTestId('comment-panel')).toHaveCount(0, { timeout: 15000 });
  await expect(card.getByTestId('card-comment')).toContainText('✓');
  // La ficha completa muestra lo guardado y la interpretación local del comentario
  await page.locator(`[data-testid="rec-item"][data-key="${key}"]`).getByTestId('card-open').click();
  await expect(page.getByTestId('comment')).toHaveValue(/simulación/);
  await expect(page.getByTestId('comment-interpretation')).toContainText('realidad simulada');
});

test('v2.1: «No me interesa», descartados y reversión', async ({ page }) => {
  await onboardQuick(page);
  const card = page.getByTestId('rec-item').nth(2);
  const key = await card.getAttribute('data-key');
  const name = await titleOf(card);
  await card.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await card.getByTestId('interest-no').click();
  await expect(card.getByTestId('dismissed-note')).toBeVisible();
  await expect(card).toHaveAttribute('data-dismissed', 'true'); // sigue visible hasta actualizar
  await card.getByTestId('undo-not-interested').click();
  await expect(card.getByTestId('dismissed-note')).toHaveCount(0);
  await card.getByTestId('interest-no').click();
  await expect(card.getByTestId('dismissed-note')).toBeVisible();
  await page.getByTestId('apply-ranking').click();
  await expect(page.locator(`[data-testid="rec-item"][data-key="${key}"]`)).toHaveCount(0, { timeout: 15000 });
  await page.getByRole('link', { name: /^Notas$/ }).click();
  await page.getByTestId('view-dismissed').click();
  const row = page.getByTestId('rating-row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByTestId('row-undo-dismiss').click();
  await expect(page.getByTestId('rating-row').filter({ hasText: name })).toHaveCount(0);
});

test('v2.1: panel de filtros combinables con indicador y limpieza', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByTestId('filters-toggle').click();
  const panel = page.getByTestId('filters-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('filters-mode')).toHaveText('Recomendaciones generales');
  await panel.getByTestId('panel-movie').click();
  await panel.getByTestId('filter-year-min').fill('2000');
  await expect(page.getByTestId('filters-count')).toHaveText('2');
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v21-filtros.png`, fullPage: true });
  const n = await page.getByTestId('rec-item').count();
  for (let i = 0; i < Math.min(n, 5); i++) {
    const t = page.getByTestId('rec-item').nth(i);
    await expect(t).toContainText('Película');
    const year = Number((await t.innerText()).match(/\b(19|20)\d{2}\b/)?.[0]);
    expect(year).toBeGreaterThanOrEqual(2000);
  }
  // Un año imposible deja sin resultados y explica qué filtro restringe
  await panel.getByTestId('filter-year-min').fill('2030');
  await expect(page.getByTestId('filters-empty')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/Sin «Desde 2030» habría/)).toBeVisible();
  // Se conserva al navegar
  await page.getByRole('link', { name: /Buscar/ }).click();
  await page.goBack();
  await expect(page.getByTestId('filters-count')).toHaveText('2');
  await page.getByTestId('reset-general').click();
  await expect(page.getByTestId('filters-mode')).toHaveText('Recomendaciones generales');
  await expect(page.getByTestId('rec-item').first()).toBeVisible();
});

test('v2.1: porcentaje de aspectos y acceso a los faltantes', async ({ page }) => {
  await onboardQuick(page);
  await page.getByRole('link', { name: /^Notas$/ }).click();
  const row = page.getByTestId('rating-row').first();
  await expect(row.getByTestId('completion')).toHaveAttribute('data-percent', '0');
  await row.getByTestId('row-complete').click();
  const sheet = page.getByTestId('aspects-sheet');
  await sheet.getByTestId('dim-story').getByRole('radio', { name: /4 estrellas$/ }).click();
  await sheet.getByTestId('dim-acting').getByRole('radio', { name: /3 estrellas$/ }).click();
  await sheet.getByTestId('dim-emotion').getByRole('radio', { name: /2 estrellas$/ }).click();
  await sheet.getByTestId('save-rating').click();
  await expect(sheet).toBeHidden({ timeout: 15000 });
  await page.getByTestId('view-incomplete').click();
  await expect(page.locator('[data-testid="completion"][data-percent="43"]')).toHaveCount(1);
  await noHorizontalScroll(page);
});

// ═════════════════════════ v3.0 ═════════════════════════

test('v3: año con teclado numérico de Android, dígito por dígito', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByTestId('filters-toggle').click();
  const input = page.getByTestId('filter-year-min');
  await expect(input).toHaveAttribute('inputmode', 'numeric');
  await expect(input).toHaveAttribute('type', 'text');
  await input.tap();
  // Como un teclado virtual: un dígito por vez. Antes, cada dígito se borraba al instante.
  for (const [i, d] of ['2', '0', '1', '0'].entries()) {
    await page.keyboard.type(d, { delay: 60 });
    await expect(input).toHaveValue('2010'.slice(0, i + 1));
  }
  await expect(page.getByTestId('active-filters')).toContainText('Desde 2010');
  // Borrar y corregir parcialmente no aplica valores a medias
  await page.keyboard.press('Backspace');
  await expect(input).toHaveValue('201');
  await expect(page.getByTestId('active-filters')).toContainText('Desde 2010');
  await page.keyboard.type('5');
  await expect(page.getByTestId('active-filters')).toContainText('Desde 2015');
  // Valor inválido: se avisa sin aplicar
  await input.fill('');
  await page.keyboard.type('1200');
  await expect(page.getByTestId('filter-year-min-error')).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v3-anio.png` });
});

test('v3: 10 recomendaciones al inicio, «Ver más» de a 10 y notas pública y «Para vos» separadas', async ({ page }, info) => {
  await onboardQuick(page);
  await expect(page.getByTestId('rec-item')).toHaveCount(10);
  await expect(page.getByTestId('rows-count')).toContainText('Mostrando 10 de');
  const first = page.getByTestId('rec-item').first();
  await expect(first.getByTestId('box-primary')).toHaveAttribute('data-label', 'Para vos');
  await expect(first.getByTestId('score-public')).toContainText('TMDB');
  await page.getByTestId('show-more').click();
  await expect(page.getByTestId('rec-item')).toHaveCount(20);
  // Diagnóstico por canal en la explicación
  await first.getByTestId('more-toggle').click();
  await first.getByTestId('rec-explanation').locator('summary').click();
  await expect(first.getByTestId('channel-bars')).toBeVisible();
  // Ordenar por público: la lista sigue completa y se conserva al recargar
  await page.getByTestId('home-sort').selectOption('public');
  await expect(page.getByTestId('rec-item')).toHaveCount(10);
  const pubs = await page.getByTestId('score-public').allInnerTexts();
  const vals = pubs.map((t) => Number(t.replace(/[^\d,]/g, '').replace(',', '.'))).filter((x) => !Number.isNaN(x) && x > 0);
  for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
  await page.reload();
  await expect(page.getByTestId('home-sort')).toHaveValue('public');
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v3-inicio.png` });
});

test('v3: guardar en la ficha confirma sin esperar el recálculo y las valoraciones siguen visibles aunque TMDB falle', async ({ page }) => {
  await onboardQuick(page);
  await page.getByRole('link', { name: /Buscar/ }).click();
  await page.getByTestId('search-input').fill('Drama Film');
  await page.getByTestId('search-result').filter({ hasText: 'Drama Film' }).first().click();
  await expect(page.getByTestId('title-scores')).toBeVisible();
  // TMDB deja de responder justo antes de guardar
  await page.route('https://api.themoviedb.org/**', (r) => r.fulfill({ status: 500, body: '{}' }));
  await page.getByTestId('overall').getByRole('button', { name: 'Valoración general (1-10): 8' }).click();
  await page.getByTestId('save-rating').click();
  await expect(page.getByTestId('save-status')).toContainText('Guardado', { timeout: 5000 });
  await expect(page.getByTestId('save-rating')).toBeEnabled(); // nunca queda «procesando»
  // Guardados consecutivos rápidos
  for (const n of [6, 7, 9]) {
    await page.getByTestId('overall').getByRole('button', { name: `Valoración general (1-10): ${n}` }).click();
    await page.getByTestId('save-rating').click();
    await expect(page.getByTestId('save-status')).toContainText('Guardado', { timeout: 5000 });
  }
  await page.getByRole('link', { name: /^Notas$/ }).click();
  await expect(page.getByTestId('rating-row').first()).toBeVisible();
  const rows = await page.getByTestId('rating-row').count();
  expect(rows).toBeGreaterThanOrEqual(5); // las de la incorporación + esta (puede coincidir con una ya puntuada)
  await expect(page.getByTestId('rating-row').filter({ hasText: 'Drama Film' }).getByTestId('row-score')).toHaveText('9');
});

test('v3: el orden A-Z de Valoraciones se conserva al editar un título y al recargar', async ({ page }) => {
  await onboardQuick(page);
  await page.getByRole('link', { name: /^Notas$/ }).click();
  await page.getByTestId('ratings-sort').selectOption('title');
  await expect(page.getByTestId('ratings-dir')).toHaveText('A→Z');
  const names = async () => (await page.getByTestId('rating-row').locator('.truncate.font-medium').allInnerTexts()).map((x) => x.trim());
  const before = await names();
  expect([...before].sort((a, b) => a.localeCompare(b, 'es'))).toEqual(before);
  // Editar el segundo título (aspectos) y guardar
  await page.getByTestId('rating-row').nth(1).getByTestId('row-complete').click();
  await page.getByTestId('aspects-sheet').getByTestId('dim-story').getByRole('radio', { name: /3 estrellas$/ }).click();
  await page.getByTestId('aspects-sheet').getByTestId('save-rating').click();
  await expect(page.getByTestId('aspects-sheet')).toBeHidden();
  await expect(page.getByTestId('ratings-sort')).toHaveValue('title');
  expect(await names()).toEqual(before);
  await page.getByRole('link', { name: /Inicio/ }).click();
  await page.getByRole('link', { name: /^Notas$/ }).click();
  await expect(page.getByTestId('ratings-sort')).toHaveValue('title');
  await page.reload();
  await expect(page.getByTestId('ratings-sort')).toHaveValue('title');
  expect(await names()).toEqual(before);
  await page.getByTestId('ratings-dir').click();
  await expect(page.getByTestId('ratings-dir')).toHaveText('Z→A');
  expect(await names()).toEqual([...before].reverse());
});

test('v3: filtro de un género con pocos candidatos (Terror) y filtro por actor con homónimos', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByTestId('filters-toggle').click();
  const panel = page.getByTestId('filters-panel');
  await panel.getByTestId('genre-27').click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('filters-empty')).toHaveCount(0);
  await panel.getByTestId('genre-27').click(); // excluir
  await panel.getByTestId('genre-27').click(); // sin filtrar
  // Actor: dos personas con el mismo nombre se distinguen por oficio
  await panel.getByTestId('person-input').fill('Actor 231');
  await expect(panel.getByTestId('person-hit')).toHaveCount(2);
  await expect(panel.getByTestId('person-hit').filter({ hasText: 'Dirección' })).toHaveCount(1);
  await panel.getByTestId('person-hit').filter({ hasText: 'Actuación' }).getByTestId('person-include').click();
  await expect(panel.getByTestId('person-selected')).toContainText('Actor 231');
  await expect(page.getByTestId('active-filters')).toContainText('Actores incluidos: Actor 231');
  await page.getByTestId('watched-filter-all').click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 20000 });
  // Combinable con tipo
  await panel.getByTestId('panel-movie').click();
  await expect(page.getByTestId('active-filters')).toContainText('Sólo películas');
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('rec-item').filter({ hasNotText: 'Película' })).toHaveCount(0);
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v3-actor.png`, fullPage: true });
  await panel.getByTestId('person-clear').click();
  await expect(page.getByTestId('active-filters')).not.toContainText('Actores incluidos');
});

test('v3: Similares con dos referencias, similitud y afinidad separadas, filtros y acciones', async ({ page }, info) => {
  test.setTimeout(180000);
  await onboardQuick(page);
  const t0 = Date.now();
  await page.getByRole('link', { name: /Similares/ }).click();
  await expect(page.getByRole('heading', { name: 'Similares' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByTestId('similar-only-mine').uncheck();
  await page.getByTestId('similar-search').fill('Scifi Film 1');
  await page.getByTestId('similar-hit').first().click();
  await expect(page.getByTestId('similar-ref')).toHaveCount(1);
  await expect(page.getByTestId('similar-item').first()).toBeVisible({ timeout: 30000 });
  const first = page.getByTestId('similar-item').first();
  await expect(first.getByTestId('card-compat')).toContainText('Similitud');
  await expect(first.getByTestId('score-public')).toBeVisible();
  await expect(page.getByTestId('similar-personalized')).toBeVisible();
  // Segunda referencia
  await page.getByTestId('similar-search').fill('Scifi');
  await page.locator('[data-testid="similar-hit"]:not([disabled])').first().click();
  await expect(page.getByTestId('similar-ref')).toHaveCount(2);
  await expect(page.getByTestId('similar-item').first()).toBeVisible({ timeout: 30000 });
  const refs = await page.getByTestId('similar-ref').allInnerTexts();
  const results = await page.getByTestId('similar-item').locator('h3').allInnerTexts();
  for (const r of refs) expect(results).not.toContain(r.replace('✕', '').trim());
  // Explicación + acción rápida
  await expect(first.getByTestId('card-why')).not.toBeEmpty();
  await first.getByTestId('quick-watched').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await first.getByTestId('quick-watched').click();
  await expect(first.getByTestId('quick-watched')).toHaveAttribute('aria-pressed', 'true');
  // Filtro: sólo series
  await page.getByTestId('filters-toggle').click();
  await page.getByTestId('panel-tv').click();
  await page.getByTestId('similar-watched-all').click();
  await expect(page.getByTestId('similar-item').first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('similar-item').filter({ hasNotText: 'Serie' })).toHaveCount(0, { timeout: 30000 });
  console.log(`[${info.project.name}] Similares: ${Date.now() - t0} ms para 3 búsquedas (proveedor simulado)`);
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v3-similares.png`, fullPage: true });
});
