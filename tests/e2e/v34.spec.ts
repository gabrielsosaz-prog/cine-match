import { expect, test, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// Proveedor SIMULADO: valida la interfaz de v3.4 en Android (preferencias del texto, modo diagnóstico, exportación),
// no la calidad de las recomendaciones (eso es npm run eval) ni los datos reales de TMDB (tests/prod/v34.spec.ts).
const catalog = buildCatalog(15);
const handler = fakeTmdbHandler(catalog);
const byKey = new Map(catalog.map((t) => [`${t.type}:${t.id}`, t]));

async function mockTmdb(page: Page) {
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const { status, body } = await handler(route.request().url());
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
  await page.route('**/catalog/manifest.json', (r) => r.fulfill({ status: 404 }));
}
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
const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
const results = async (page: Page) => {
  await expect(page.getByTestId('rec-item').first().or(page.getByTestId('filters-empty'))).toBeVisible({ timeout: 30000 });
  return page.getByTestId('rec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!));
};

test('v3.4: preferencias del texto (aplicadas y no aplicadas) ordenan sin quitar títulos y se combinan con restricciones', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByTestId('filters-toggle').click();
  const panel = page.getByTestId('filters-panel');
  await page.getByTestId('watched-filter-all').click();
  const before = await results(page);

  await panel.getByTestId('text-input').fill('Películas con poco romance y giros argumentales');
  await panel.getByTestId('text-interpret').click();
  const prev = panel.getByTestId('text-preview');
  await expect(prev).toContainText('Tipo: película');
  const prefs = prev.getByTestId('text-pref');
  await expect(prefs).toHaveCount(2);
  await expect(prefs.filter({ hasText: 'romance' })).toHaveAttribute('data-applied', 'true');
  await expect(prefs.filter({ hasText: 'giros' })).toHaveAttribute('data-applied', 'false');
  await expect(prefs.filter({ hasText: 'giros' })).toContainText('No aplicada');
  await expect(prev).toContainText('ordenan, no quitan');
  await expect(prev.getByTestId('text-unparsed')).toHaveCount(0);
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v34-preferencias.png`, fullPage: true });
  await panel.getByTestId('text-apply').click();
  await expect(page.getByTestId('text-applied')).toContainText('Menos: poco protagonismo del romance (ordena)');
  const keys = await results(page);
  // la restricción filtra (sólo películas); la preferencia no quita películas
  expect(keys.every((k) => k.startsWith('movie:'))).toBe(true);
  expect(keys.length).toBeGreaterThan(0);
  // Un título romántico muestra por qué bajó (evidencia de TMDB)
  const rom = keys.find((k) => byKey.get(k)!.genres.includes(10749));
  if (rom) {
    const c = page.locator(`[data-testid="rec-item"][data-key="${rom}"]`);
    await c.getByTestId('more-toggle').click();
    await expect(c.getByTestId('more-cons')).toContainText('Baja por');
  }

  // Persistencia al recargar
  await page.reload();
  await expect(page.getByTestId('active-filters')).toContainText('Texto: «Películas con poco romance');
  expect(before.length).toBeGreaterThan(0);
});

test('v3.4: modo diagnóstico apagado por defecto; al activarlo muestra el cálculo y exporta JSON', async ({ page }, info) => {
  await onboardQuick(page);
  await expect(page.getByTestId('diag-bar')).toHaveCount(0);
  await expect(page.getByTestId('diag-panel')).toHaveCount(0);
  await page.goto('/#/ajustes');
  await page.getByTestId('diagnostic-toggle').check();
  await page.goto('/#/');
  await expect(page.getByTestId('diag-bar')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('rec-item').first().getByTestId('more-toggle').click();
  const first = page.getByTestId('rec-item').first().getByTestId('diag-panel');
  await first.locator('summary').click();
  await expect(first).toContainText('Señales');
  await expect(first).toContainText('Metadatos faltantes');
  await expect(first).toContainText('Motivo de inclusión');
  expect(await first.getByTestId('diag-channel').count()).toBeGreaterThan(0);
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v34-diagnostico.png`, fullPage: true });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('diag-export').click()]);
  const json = JSON.parse(await (await dl.createReadStream()).toArray().then((b) => Buffer.concat(b).toString('utf8')));
  expect(json.engine).toMatch(/^hybrid-narrative-/);
  expect(json.items.length).toBeGreaterThan(0);
  expect(json.items[0]).toHaveProperty('channels');
  expect(JSON.stringify(json)).not.toContain('eyJprueba'); // el token nunca sale en la exportación
  // apagarlo deja la interfaz normal
  await page.goto('/#/ajustes');
  await page.getByTestId('diagnostic-toggle').uncheck();
  await page.goto('/#/');
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('diag-bar')).toHaveCount(0);
});
