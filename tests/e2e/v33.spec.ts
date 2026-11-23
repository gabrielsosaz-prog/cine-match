import { expect, test, type Page } from '@playwright/test';
import { buildCatalog, countryOf, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// Proveedor SIMULADO (catálogo sintético, países US/ES/KR/MX con coproducciones MX): valida la interfaz y los flujos
// de v3.3 en Android, no los datos reales de TMDB ni la precisión de la clasificación (eso es tests/prod/v33.spec.ts).
const catalog = buildCatalog(15);
const handler = fakeTmdbHandler(catalog);
const byKey = new Map(catalog.map((t) => [`${t.type}:${t.id}`, t]));
const countriesFake = (k: string) => { const t = byKey.get(k)!; return [countryOf(t), ...(t.type === 'movie' && t.id % 7 === 0 ? ['MX'] : [])]; };

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

test('v3.3: texto libre con vista previa, aplicar, quitar una condición, limpiar sólo el texto y persistencia', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByTestId('filters-toggle').click();
  const panel = page.getByTestId('filters-panel');
  await page.getByTestId('watched-filter-all').click();
  // Los cuatro grupos en orden
  const ids = await panel.locator('[data-testid^="filter-group-"]:not([data-testid$="-toggle"]):not([data-testid$="-clear"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(ids).toEqual(['filter-group-text', 'filter-group-audience', 'filter-group-places', 'filter-group-other']);
  await expect(panel.getByLabel('Describí qué querés ver o evitar')).toBeVisible();

  // Texto no interpretable: se avisa y no se puede aplicar
  await panel.getByTestId('text-input').fill('algo lindo para un domingo');
  await panel.getByTestId('text-interpret').click();
  await expect(panel.getByTestId('text-unparsed')).toContainText('lindo domingo');
  await expect(panel.getByTestId('text-apply')).toBeDisabled();
  await panel.getByTestId('text-cancel').click();

  // Ejemplo con vista previa antes de aplicar
  await panel.getByTestId('text-input').fill('Películas coreanas o españolas posteriores a 2000, sin terror');
  await panel.getByTestId('text-interpret').click();
  const prev = panel.getByTestId('text-preview');
  await expect(prev).toContainText('Tipo: película');
  await expect(prev).toContainText('Corea del Sur');
  await expect(prev).toContainText('España');
  await expect(prev).toContainText('Año mínimo: 2001');
  await expect(prev).toContainText('Excluir: Terror');
  await expect(prev).toContainText(/reglas/i); // no se presenta como comprensión del lenguaje
  await expect(page.getByTestId('active-filters')).toHaveCount(0); // todavía no se aplicó
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v33-texto.png`, fullPage: true });
  // Corregir la interpretación antes de aplicar: quitar España
  await prev.getByTestId('text-cond').filter({ hasText: 'España' }).getByTestId('text-cond-remove').click();
  await expect(prev).not.toContainText('España');
  const t0 = Date.now();
  await panel.getByTestId('text-apply').click();
  await expect(page.getByTestId('active-filters')).toContainText('Texto: «Películas coreanas');
  const keys = await results(page);
  const ms = Date.now() - t0;
  console.log(`Texto libre aplicado y resultados en ${ms} ms (proveedor simulado)`);
  expect(ms).toBeLessThan(15000);
  expect(keys.length).toBeGreaterThan(0);
  for (const k of keys) {
    const t = byKey.get(k)!;
    expect(t.type).toBe('movie');
    expect(countriesFake(k)).toContain('KR');
    expect(t.year).toBeGreaterThan(2000);
    expect(t.genres).not.toContain(27);
  }
  await expect(panel.getByTestId('text-applied')).toContainText('Corea del Sur');
  await expect(panel.getByTestId('text-applied')).not.toContainText('España');

  // Combinar con un filtro existente (género) y navegar: se conserva
  await page.getByRole('link', { name: /Buscar/ }).click();
  await page.getByRole('link', { name: /Inicio/ }).click();
  await expect(page.getByTestId('active-filters')).toContainText('Texto:');
  await page.reload();
  await expect(page.getByTestId('active-filters')).toContainText('Texto:');

  // Limpiar sólo el texto: otros filtros quedan
  await page.getByTestId('filters-toggle').click();
  await page.getByTestId('filters-panel').getByTestId('region-east-asia').click();
  await expect(page.getByTestId('active-filters')).toContainText('Regiones incluidas: Asia oriental');
  await page.getByTestId('filters-panel').getByTestId('text-clear').click();
  await expect(page.getByTestId('active-filters')).not.toContainText('Texto:');
  await expect(page.getByTestId('active-filters')).toContainText('Regiones incluidas: Asia oriental');
});

test('v3.3: contradicción visible antes de aplicar', async ({ page }) => {
  await onboardQuick(page);
  await page.getByTestId('filters-toggle').click();
  const panel = page.getByTestId('filters-panel');
  await panel.getByTestId('text-input').fill('series de antes de 1990 posteriores a 2010');
  await panel.getByTestId('text-interpret').click();
  await expect(panel.getByTestId('text-contradiction')).toContainText('Años imposibles');
});

test('v3.3: público objetivo y regiones, con «Occidental» editable y limpieza por grupo', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByTestId('filters-toggle').click();
  const panel = page.getByTestId('filters-panel');
  await page.getByTestId('watched-filter-all').click();
  // Público: tri-estado, masculino/femenino deshabilitados con explicación
  await expect(panel.getByTestId('audience-female')).toBeDisabled();
  await expect(panel.getByTestId('audience-disabled-note')).toBeVisible();
  await panel.getByTestId('audience-teen').click();
  await panel.getByTestId('audience-teen').click();
  await expect(panel.getByTestId('audience-teen')).toHaveAttribute('data-state', 'exclude');
  await expect(page.getByTestId('active-filters')).toContainText('Público excluido: Adolescente / juvenil (aprox.)');
  await panel.getByTestId('audience-threshold').selectOption('0.65');
  await panel.getByTestId('audience-uncertain').check();
  await results(page);
  // Región excluida: Asia oriental (Corea en el simulador)
  await panel.getByTestId('region-east-asia').click();
  await panel.getByTestId('region-east-asia').click();
  await expect(page.getByTestId('active-filters')).toContainText('Regiones excluidas: Asia oriental');
  let keys = await results(page);
  expect(keys.length).toBeGreaterThan(0);
  for (const k of keys) expect(countriesFake(k)).not.toContain('KR');
  // Occidental: ver y editar la lista (agregar México)
  await panel.getByTestId('region-show').selectOption('western');
  await expect(panel.getByTestId('region-countries')).toContainText('Estados Unidos');
  await expect(panel.getByTestId('region-countries')).not.toContainText('México');
  await panel.getByTestId('region-western').click();
  keys = await results(page);
  expect(keys.length).toBeGreaterThan(0);
  for (const k of keys) expect(countriesFake(k).some((c) => c === 'US' || c === 'ES')).toBe(true);
  await panel.getByTestId('western-input').fill('Méx');
  await panel.getByTestId('western-add').filter({ hasText: 'México' }).click();
  await expect(panel.getByTestId('region-countries')).toContainText('México');
  await expect(panel.getByTestId('western-reset')).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v33-publico-regiones.png`, fullPage: true });
  // Persistencia tras recargar (filtros y lista Occidental)
  await page.reload();
  await expect(page.getByTestId('active-filters')).toContainText('Regiones incluidas: Occidental');
  await expect(page.getByTestId('active-filters')).toContainText('Público excluido');
  await page.getByTestId('filters-toggle').click();
  const p2 = page.getByTestId('filters-panel');
  await p2.getByTestId('region-show').selectOption('western');
  await expect(p2.getByTestId('region-countries')).toContainText('México');
  await p2.getByTestId('western-reset').click();
  await expect(p2.getByTestId('region-countries')).not.toContainText('México');
  // Limpiar un grupo no toca el otro
  await p2.getByTestId('filter-group-places-clear').click();
  await expect(page.getByTestId('active-filters')).not.toContainText('Regiones');
  await expect(page.getByTestId('active-filters')).toContainText('Público excluido');
  await p2.getByTestId('filter-group-audience-clear').click();
  await expect(page.getByTestId('active-filters')).toHaveCount(0);
  // Grupo plegable
  await p2.getByTestId('filter-group-audience-toggle').click();
  await expect(p2.getByTestId('audience-teen')).toBeHidden();
});
