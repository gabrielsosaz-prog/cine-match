import { expect, test, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// Proveedor SIMULADO: valida la comparación a ciegas de v3.5 en Android (armar, responder, exportar, persistir, que
// no toque valoraciones). No mide calidad de recomendaciones.
const catalog = buildCatalog(15);
const handler = fakeTmdbHandler(catalog);

async function mockTmdb(page: Page) {
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const { status, body } = await handler(route.request().url());
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
  await page.route('**/catalog/manifest.json', (r) => r.fulfill({ status: 404 })); // sin catálogo semántico
}
async function onboardQuick(page: Page) {
  await mockTmdb(page);
  await page.goto('/');
  await page.getByTestId('token-input').fill('eyJprueba');
  await page.getByTestId('save-token').click();
  await page.getByTestId('ob-next').click();
  const cards = page.getByTestId('quick-card');
  await expect(cards.first()).toBeVisible();
  for (let i = 0; i < 9; i++) await cards.nth(i).getByRole('button', { name: /: (9|8|7|6|5)$/ }).nth(i % 3).click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 20000 });
}
const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
const ratingsDump = (page: Page) => page.evaluate(async () => {
  const req = indexedDB.open('cine-match');
  const dbh: IDBDatabase = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const tx = dbh.transaction('ratings', 'readonly');
  const all: unknown[] = await new Promise((res) => { const r = tx.objectStore('ratings').getAll(); r.onsuccess = () => res(r.result); });
  dbh.close();
  return JSON.stringify(all);
});

test('v3.5: comparación a ciegas desde Ajustes, respuestas, persistencia y exportación sin tocar valoraciones', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await onboardQuick(page);
  const before = await ratingsDump(page);
  expect(JSON.parse(before).length).toBeGreaterThanOrEqual(5);
  await page.getByRole('link', { name: 'Ajustes' }).click();
  await page.getByTestId('ab-link').click();
  await expect(page.getByTestId('compare-page')).toBeVisible();
  // teléfono de gama media: CPU 4 veces más lenta
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t0 = Date.now();
  await page.getByTestId('ab-start').click();
  await expect(page.getByTestId('ab-item').first()).toBeVisible({ timeout: 30000 });
  console.log('[v3.5]', info.project.name, 'armar comparación con CPU ×4 (ms):', Date.now() - t0);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const items = page.getByTestId('ab-item');
  const keys = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!));
  expect(keys.length).toBe(12);
  expect(new Set(keys).size).toBe(12);
  // a ciegas: la página no nombra los motores mientras hay pendientes
  await expect(page.getByTestId('compare-page')).not.toContainText('hybrid-');
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v35-comparar.png`, fullPage: true });
  const answers = ['mucho', 'algo', 'no', 'vista', 'nose'] as const;
  for (let i = 0; i < 6; i++) await items.nth(i).getByTestId(`ab-${answers[i % 5]}`).click();
  await expect(items.nth(3)).toHaveAttribute('data-answer', 'vista');
  // persiste al recargar (y al volver con el botón Atrás de Android)
  await page.reload();
  await expect(page.getByTestId('ab-item').nth(0)).toHaveAttribute('data-answer', 'mucho');
  await expect(page.getByTestId('ab-pending')).toContainText('Faltan 6 de 12');
  await page.goBack(); await page.goForward();
  await expect(page.getByTestId('ab-item').nth(2)).toHaveAttribute('data-answer', 'no');
  for (let i = 6; i < 12; i++) await page.getByTestId('ab-item').nth(i).getByTestId('ab-algo').click();
  await expect(page.getByTestId('ab-engine-row')).toHaveCount(2);
  await expect(page.getByTestId('ab-summary')).toContainText('hybrid-personal-3.5.0');
  await expect(page.getByTestId('ab-start')).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ab-export').click()]);
  const raw = Buffer.concat(await (await dl.createReadStream()).toArray()).toString('utf8');
  expect(raw).not.toContain('eyJprueba');
  const ex = JSON.parse(raw);
  expect(ex.kind).toBe('cine-match-ab');
  expect(ex.sessions[0].items.filter((i: { answer?: string }) => i.answer).length).toBe(12);
  expect(ex.summary.perEngine.reduce((s: number, e: { scored: number }) => s + e.scored, 0)).toBe(10); // 2 no cuentan
  expect(await ratingsDump(page)).toBe(before);
  await page.screenshot({ path: `test-results/${info.project.name}-v35-resultados.png`, fullPage: true });
  // el resto de la app sigue igual
  await page.getByRole('link', { name: 'Inicio' }).click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 20000 });
  expect(errors).toEqual([]);
});

const homeKeys = async (page: Page) => {
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 30000 });
  return page.getByTestId('rec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!).join(','));
};
async function pickEngine(page: Page, e: 'v3.4' | 'v3.5') {
  await page.getByRole('link', { name: 'Ajustes' }).click();
  await page.getByTestId(`engine-${e}`).check();
  await expect(page.getByTestId(`engine-${e}`)).toBeChecked();
  await page.getByRole('link', { name: 'Inicio' }).click();
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', e, { timeout: 30000 });
}

test('v3.5: selector de motor en Ajustes, aplicado a «Para vos», persistente y sin mezclar rankings', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await onboardQuick(page);
  const ratingsBefore = await ratingsDump(page);
  // instalación nueva/existente: v3.4
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', 'v3.4');
  await expect(page.getByTestId('engine-badge')).toHaveText('Motor: v3.4');
  const k34 = await homeKeys(page);
  await page.getByRole('link', { name: 'Ajustes' }).click();
  await expect(page.getByTestId('engine-v3.4')).toBeChecked();
  await expect(page.getByTestId('engine-card')).toContainText('Todavía no demostró ser superior');
  await noHorizontalScroll(page);
  // v3.5 con CPU 4 veces más lenta (gama media)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t0 = Date.now();
  await page.getByTestId('engine-v3.5').check();
  await page.getByRole('link', { name: 'Inicio' }).click();
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', 'v3.5', { timeout: 30000 });
  console.log('[v3.5]', info.project.name, 'cambio a v3.5 y ranking visible con CPU ×4 (ms):', Date.now() - t0);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await expect(page.getByTestId('engine-badge')).toContainText('la nota «Para vos» es la estimación de v3.4');
  const k35 = await homeKeys(page);
  expect(k35).not.toBe(k34);
  await page.screenshot({ path: `test-results/${info.project.name}-v35-motor.png`, fullPage: true });
  // persiste al cerrar y abrir
  await page.reload();
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', 'v3.5', { timeout: 30000 });
  expect(await homeKeys(page)).toBe(k35);
  // filtros con v3.5
  await page.getByTestId('filters-toggle').click();
  await page.getByTestId('watched-filter-all').click();
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', 'v3.5');
  await page.getByTestId('filters-toggle').click().catch(() => undefined);
  // la comparación a ciegas sigue con ambos motores
  await page.getByRole('link', { name: 'Ajustes' }).click();
  await page.getByTestId('ab-link').click();
  await page.getByTestId('ab-start').click();
  await expect(page.getByTestId('ab-item')).toHaveCount(12, { timeout: 30000 });
  await expect(page.getByTestId('compare-page')).not.toContainText('hybrid-');
  // volver a v3.4 restaura el orden anterior
  await page.goto('/#/');
  await pickEngine(page, 'v3.4');
  expect(await homeKeys(page)).toBe(k34);
  expect(await ratingsDump(page)).toBe(ratingsBefore);
  expect(errors).toEqual([]);
});
