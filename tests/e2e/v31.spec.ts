import { expect, test, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// Proveedor SIMULADO (catálogo sintético): valida la interfaz y los flujos, no los datos reales de TMDB.
const handler = fakeTmdbHandler(buildCatalog(15));

async function mockTmdb(page: Page) {
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const { status, body } = await handler(route.request().url());
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
  // El catálogo narrativo real usa ids de TMDB que en el catálogo sintético son otros títulos: aquí no se carga
  // (la app sigue funcionando sin él, con rasgos y palabras clave). El catálogo real se prueba en producción.
  await page.route('**/catalog/manifest.json', (r) => r.fulfill({ status: 404 }));
  // El reproductor oficial no se carga en las pruebas (sin red externa): se verifica la URL embebida
  await page.route('https://www.youtube-nocookie.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>reproductor</body></html>' }));
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
const num = (t: string) => { const d = t.replace(/[^\d,]/g, ''); return d ? Number(d.replace(',', '.')) : NaN; };

test('v3.1: «Para vos (estricto)» ordena globalmente, también después de «Ver más»', async ({ page }) => {
  await onboardQuick(page);
  await page.getByTestId('home-sort').selectOption('affinity');
  await page.getByTestId('show-more').click();
  await page.getByTestId('show-more').click();
  await expect(page.getByTestId('rec-item')).toHaveCount(30);
  const all = (await page.getByTestId('rec-item').getByTestId('box-primary').locator('div:nth-child(2)').allInnerTexts()).map(num);
  const vals = all.filter((x) => !Number.isNaN(x));
  expect(vals.length).toBeGreaterThan(20);
  for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
  // Los títulos con información insuficiente («—») van al final, nunca intercalados
  const firstNaN = all.findIndex((x) => Number.isNaN(x));
  if (firstNaN >= 0) expect(all.slice(firstNaN).every((x) => Number.isNaN(x))).toBe(true);
  await expect(page.getByTestId('home-sort').locator('option[value="recommended"]')).toHaveText(/Recomendado/);
});

test('v3.1: al volver de una ficha (botón Atrás) se recupera la posición y los resultados cargados', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByTestId('home-sort').selectOption('recommended');
  await page.getByTestId('show-more').click();
  await expect(page.getByTestId('rec-item')).toHaveCount(20);
  const target = page.getByTestId('rec-item').nth(18);
  await target.scrollIntoViewIfNeeded();
  const key = await target.getAttribute('data-key');
  const before = await target.evaluate((e) => e.getBoundingClientRect().top);
  await target.locator('h3').click();
  await expect(page).toHaveURL(/#\/t\//);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('rec-item')).toHaveCount(20);
  const el = page.locator(`[data-testid="rec-item"][data-key="${key}"]`);
  await expect(el).toBeInViewport();
  await expect.poll(async () => Math.abs((await el.evaluate((e) => e.getBoundingClientRect().top)) - before), { timeout: 4000 }).toBeLessThan(40);
  await page.screenshot({ path: `test-results/${info.project.name}-v31-volver.png` });
  // Ir a otra sección desde el menú y volver a Inicio desde el menú: empieza arriba
  await page.getByRole('link', { name: /Buscar/ }).click();
  await page.getByRole('link', { name: /Inicio/ }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(50);
});

test('v3.1: buscar una persona, abrir su filmografía con filtros y volver a la búsqueda', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByRole('link', { name: /Buscar/ }).click();
  await page.getByTestId('search-input').fill('Actor 231');
  await expect(page.getByTestId('people-section')).toBeVisible();
  await expect(page.getByTestId('person-result').first()).toContainText('Actuación');
  await page.locator('[data-testid="person-result"][data-person-id="231"]').click();
  await expect(page.getByTestId('person-name')).toHaveText('Actor 231');
  await expect(page.getByTestId('person-credit').first()).toBeVisible();
  const all = await page.getByTestId('person-credit').count();
  await page.getByTestId('person-type').selectOption('movie');
  await expect(page.getByTestId('person-credit').filter({ hasText: 'Serie' })).toHaveCount(0);
  expect(await page.getByTestId('person-credit').count()).toBeLessThanOrEqual(all);
  await page.getByTestId('person-sort').selectOption('public');
  await page.screenshot({ path: `test-results/${info.project.name}-v31-persona.png` });
  await page.goBack();
  await expect(page.getByTestId('search-input')).toHaveValue('Actor 231');
  // Un texto que es título muestra títulos (no se asume que es un actor)
  await page.getByTestId('search-input').fill('Scifi Film');
  await expect(page.getByTestId('search-result').first()).toBeVisible();
  await expect(page.getByTestId('titles-section')).toBeVisible();
});

test('v3.1: tráiler en la ficha (reproductor oficial embebido) y aviso cuando no hay', async ({ page }) => {
  await onboardQuick(page);
  await page.goto('/#/t/movie/1000');
  await page.getByTestId('trailer-button').click();
  await expect(page.getByTestId('trailer-modal')).toBeVisible();
  await expect(page.getByTestId('trailer-audio')).toContainText('Subtítulos en español');
  await expect(page.getByTestId('trailer-frame')).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/trailer1000/);
  // Atrás de Android cierra el reproductor y deja la ficha donde estaba
  await page.goBack();
  await expect(page.getByTestId('trailer-modal')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/t\/movie\/1000/);
  await page.goto('/#/t/movie/1007');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thriller Film 8');
  await page.getByTestId('trailer-button').click();
  await expect(page.getByTestId('trailer-none')).toBeVisible();
});

test('v3.1: excluir producciones de México y Paramount+ en Ajustes y filtros', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByTestId('filters-toggle').click();
  await page.getByTestId('country-input').fill('Méx');
  await page.getByTestId('country-hit').filter({ hasText: 'México' }).getByTestId('country-exclude').click();
  await expect(page.getByTestId('country-exc')).toContainText('México');
  await expect(page.getByTestId('active-filters')).toContainText('Países excluidos: México');
  await expect(page.getByTestId('rec-item').first().or(page.getByTestId('filters-empty'))).toBeVisible({ timeout: 30000 });
  // Los títulos visibles no tienen México entre sus países (ids múltiplos de 5 son mexicanos en el catálogo sintético)
  const keys = await page.getByTestId('rec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
  for (const k of keys) expect(Number(k!.split(':')[1]) % 5).not.toBe(0);
  await page.screenshot({ path: `test-results/${info.project.name}-v31-paises.png` });
  await page.getByRole('link', { name: /Ajustes/ }).click();
  await page.getByRole('button', { name: 'Paramount+' }).click();
  await page.getByRole('link', { name: /Inicio/ }).click();
  await page.getByTestId('filters-toggle').click();
  await expect(page.getByTestId('filter-paramount')).toBeVisible();
});

test('v3.1: Similares con modos En común / Combinar, importancia por referencia y porcentajes < 100 %', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByRole('link', { name: /Similares/ }).click();
  await page.getByTestId('similar-only-mine').uncheck();
  await page.getByTestId('similar-search').fill('Thriller Film 1');
  await page.getByTestId('similar-hit').first().click();
  await expect(page.locator('[data-testid="similar-list"][data-current="true"] [data-testid="similar-item"]').first()).toBeVisible({ timeout: 30000 });
  await page.getByTestId('similar-search').fill('Thriller Serie 2');
  await page.locator('[data-testid="similar-hit"]:not([disabled])').first().click();
  await expect(page.getByTestId('similar-ref')).toHaveCount(2);
  await expect(page.getByTestId('similar-mode-common')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-testid="similar-list"][data-current="true"] [data-testid="similar-item"]').first()).toBeVisible({ timeout: 30000 });
  const pcts = (await page.getByTestId('similar-item').getByTestId('card-compat').allInnerTexts()).map((t) => t.split('%')[0]).map(num);
  expect(Math.max(...pcts)).toBeLessThan(100);
  await expect(page.getByTestId('card-compat').first()).toContainText('confianza');
  await page.getByTestId('similar-mode-combine').click();
  await expect(page.getByTestId('similar-mode-combine')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-testid="similar-list"][data-current="true"] [data-testid="similar-item"]').first()).toBeVisible({ timeout: 30000 });
  await page.getByTestId('similar-ref-weight').first().selectOption('2');
  await expect(page.locator('[data-testid="similar-list"][data-current="true"] [data-testid="similar-item"]').first()).toBeVisible({ timeout: 30000 });
  await page.getByTestId('similar-item').first().getByTestId('more-toggle').click();
  await expect(page.getByTestId('similar-item').first().getByTestId('similar-ref-row')).toHaveCount(2);
  await expect(page.getByTestId('similar-item').first().getByTestId('similar-ref-row').first()).toContainText('% de parecido');
  await expect(page.getByTestId('similar-semantic')).toBeVisible();
  // Abrir un resultado y volver: referencias, modo y resultados se conservan
  const firstTitle = await page.getByTestId('similar-item').first().locator('h3').innerText();
  await page.getByTestId('similar-item').first().locator('h3').click();
  await expect(page).toHaveURL(/#\/t\//);
  await page.goBack();
  await expect(page.getByTestId('similar-ref')).toHaveCount(2);
  await expect(page.getByTestId('similar-mode-combine')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('similar-item').first().locator('h3')).toHaveText(firstTitle, { timeout: 30000 });
  await page.screenshot({ path: `test-results/${info.project.name}-v31-similares.png`, fullPage: true });
});
