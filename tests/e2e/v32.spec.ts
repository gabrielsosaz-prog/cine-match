import { expect, test, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// Proveedor SIMULADO (catálogo sintético): valida la interfaz y los flujos de v3.2, no los datos reales de TMDB
// (eso está en tests/prod/v32.spec.ts). En el simulador, Actor 202 y Actor 203 comparten 5 títulos; Actor 202 y
// Actor 212 no comparten ninguno.
const catalog = buildCatalog(15);
const handler = fakeTmdbHandler(catalog);
const together = catalog.filter((t) => t.cast.includes(202) && t.cast.includes(203)).map((t) => t.name);
const any = new Set(catalog.filter((t) => t.cast.includes(202) || t.cast.includes(203)).map((t) => `${t.type}:${t.id}`));

async function mockTmdb(page: Page) {
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const { status, body } = await handler(route.request().url());
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
  await page.route('**/catalog/manifest.json', (r) => r.fulfill({ status: 404 }));
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
async function pick(page: Page, name: string, how: 'include' | 'exclude', scope = page.locator('body')) {
  await scope.getByTestId('person-input').fill(name);
  await scope.locator(`[data-testid="person-hit"]`).filter({ hasText: 'Actuación' }).filter({ hasText: name }).first().getByTestId(`person-${how}`).click();
}
const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

test('v3.2: Buscar por reparto con Todos, Cualquiera, exclusión, vacío legítimo y persistencia', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByRole('link', { name: /Buscar/ }).click();
  await page.getByTestId('search-mode-cast').click();
  await pick(page, 'Actor 202', 'include');
  await pick(page, 'Actor 203', 'include');
  await expect(page.getByTestId('people-mode-all')).toHaveAttribute('aria-checked', 'true'); // «Todos» por defecto
  await expect(page.getByTestId('cast-result').first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('cast-summary')).toContainText('con Actor 202 y Actor 203 a la vez');
  const allTitles = await page.getByTestId('cast-result').locator('h3').allInnerTexts();
  expect(new Set(allTitles)).toEqual(new Set(together));
  // Cualquiera: la unión
  await page.getByTestId('people-mode-any').click();
  await expect(page.getByTestId('cast-summary')).toContainText(`${any.size} títulos`, { timeout: 30000 });
  // Excluir a otra persona: la exclusión manda
  await page.getByTestId('people-mode-all').click();
  await pick(page, 'Actor 204', 'exclude');
  await expect(page.getByTestId('person-excluded')).toContainText('sin Actor 204');
  const expectedEx = catalog.filter((t) => t.cast.includes(202) && t.cast.includes(203) && !t.cast.includes(204)).map((t) => t.name);
  await expect(page.getByTestId('cast-summary')).toContainText(`sin Actor 204`, { timeout: 30000 });
  if (expectedEx.length) await expect(page.getByTestId('cast-result')).toHaveCount(expectedEx.length);
  else await expect(page.getByTestId('cast-empty')).toBeVisible();
  // Orden por título
  await page.getByTestId('cast-sort').selectOption('title');
  const sorted = await page.getByTestId('cast-result').locator('h3').allInnerTexts();
  expect(sorted).toEqual([...sorted].sort((a, b) => a.localeCompare(b, 'es')));
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v32-reparto.png`, fullPage: true });
  // Abrir un resultado y volver con Atrás: selección y orden se conservan
  if (sorted.length) {
    await page.getByTestId('cast-result').first().locator('h3').click();
    await expect(page).toHaveURL(/#\/t\//);
    await page.goBack();
    await expect(page.getByTestId('person-selected')).toHaveCount(2);
    await expect(page.getByTestId('person-excluded')).toHaveCount(1);
    await expect(page.getByTestId('cast-sort')).toHaveValue('title');
  }
  // Vacío legítimo: dos personas sin obras en común
  await page.getByTestId('person-clear').click();
  await pick(page, 'Actor 202', 'include');
  await pick(page, 'Actor 212', 'include');
  await page.getByTestId('people-mode-all').click();
  await expect(page.getByTestId('cast-empty')).toHaveText('TMDB no registra películas ni series donde actúen Actor 202 y Actor 212 a la vez.', { timeout: 30000 });
  await expect(page.getByTestId('cast-result')).toHaveCount(0);
});

test('v3.2: filtros de actores y países en Inicio, condiciones visibles y quitar una sin borrar las demás', async ({ page }, info) => {
  await onboardQuick(page);
  await page.getByTestId('filters-toggle').click();
  const panel = page.getByTestId('filters-panel');
  await page.getByTestId('watched-filter-all').click();
  await pick(page, 'Actor 202', 'include', panel);
  await pick(page, 'Actor 203', 'include', panel);
  await panel.getByTestId('people-mode-all').click();
  await panel.getByTestId('country-input').fill('Méx');
  await panel.getByTestId('country-hit').filter({ hasText: 'México' }).getByTestId('country-exclude').click();
  const active = page.getByTestId('active-filters');
  await expect(active).toContainText('Actores incluidos: Actor 202 y Actor 203 · Coincidencia: Todos');
  await expect(active).toContainText('Países excluidos: México');
  await expect(page.getByTestId('rec-item').first().or(page.getByTestId('filters-empty'))).toBeVisible({ timeout: 30000 });
  const keys = await page.getByTestId('rec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!));
  for (const k of keys) {
    const t = catalog.find((x) => `${x.type}:${x.id}` === k)!;
    expect(t.cast).toEqual(expect.arrayContaining([202, 203]));
    expect(t.id % 5 === 0 || (t.type === 'movie' && t.id % 7 === 0)).toBe(false); // sin México ni coproducción con México
  }
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v32-filtros.png`, fullPage: true });
  // Quitar sólo el país: los actores siguen
  await page.locator('[data-testid="active-filter"][data-filter="excludeCountries"]').getByTestId('active-filter-remove').click();
  await expect(active).not.toContainText('Países excluidos');
  await expect(active).toContainText('Actores incluidos: Actor 202 y Actor 203');
  // Persistencia: navegar y volver
  await page.getByRole('link', { name: /Buscar/ }).click();
  await page.getByRole('link', { name: /Inicio/ }).click();
  await expect(page.getByTestId('active-filters')).toContainText('Actores incluidos: Actor 202 y Actor 203');
  // Quitar una persona sin borrar la otra
  await page.getByTestId('filters-toggle').click();
  await page.getByTestId('filters-panel').locator('[data-testid="person-selected"][data-person-id="203"]').getByTestId('person-remove').click();
  await expect(page.getByTestId('active-filters')).toContainText('Actores incluidos: Actor 202');
  await expect(page.getByTestId('active-filters')).not.toContainText('Actor 203');
  // Restablecer
  await page.getByTestId('clear-filters').click();
  await expect(page.getByTestId('active-filters')).toHaveCount(0);
});

test('v3.2: tráiler con versiones, búsqueda subtitulada en YouTube y Atrás de Android', async ({ page }) => {
  await onboardQuick(page);
  // 1000: oficial subtitulado (indicado en el título) + original en inglés
  await page.goto('/#/t/movie/1000');
  await page.getByTestId('trailer-button').click();
  await expect(page.getByTestId('trailer-modal')).toBeVisible();
  await expect(page.getByTestId('trailer-audio')).toContainText('Subtítulos en español indicados en el título del vídeo');
  await expect(page.getByTestId('trailer-version')).toHaveCount(2);
  await page.getByTestId('trailer-version').nth(1).click();
  await expect(page.getByTestId('trailer-frame')).toHaveAttribute('src', /embed\/orig1000/);
  await expect(page.getByTestId('trailer-audio')).toContainText('no confirmados');
  await expect(page.getByTestId('trailer-youtube-search')).toHaveCount(0); // hay una versión con subtítulos indicados
  await page.goBack();
  await expect(page.getByTestId('trailer-modal')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/t\/movie\/1000/);
  // 1011: sólo original en inglés y un teaser → se ofrece la búsqueda (no se abre ningún vídeo no verificado)
  await page.goto('/#/t/movie/1011');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thriller Film 12');
  await page.getByTestId('trailer-button').click();
  await expect(page.getByTestId('trailer-modal')).toBeVisible();
  await expect(page.getByTestId('trailer-frame')).toHaveAttribute('src', /embed\/orig1011/);
  const link = page.getByTestId('trailer-youtube-search').first();
  await expect(link).toHaveText(/Buscar tráiler subtitulado en YouTube/);
  const href = await link.getAttribute('href');
  expect(href).toBe(`https://www.youtube.com/results?search_query=${encodeURIComponent('Thriller Film 12 1986 tráiler subtitulado español')}`);
  expect(await link.getAttribute('target')).toBe('_blank');
  await page.goBack();
  await expect(page.getByTestId('trailer-modal')).toHaveCount(0);
});

test('v3.2: la búsqueda general separa personas de títulos y lleva a la filmografía', async ({ page }) => {
  await onboardQuick(page);
  await page.getByRole('link', { name: /Buscar/ }).click();
  await page.getByTestId('search-input').fill('Actor 202');
  await expect(page.getByTestId('people-section')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('person-result').first()).toHaveAttribute('data-person-id', '202');
  await page.getByTestId('person-result').first().click();
  await expect(page.getByTestId('person-credit').first()).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('search-input')).toHaveValue('Actor 202');
  // los títulos se siguen encontrando normalmente
  await page.getByTestId('search-input').fill('Thriller Film 12');
  await expect(page.getByTestId('search-result').first()).toContainText('Thriller Film 12');
});
