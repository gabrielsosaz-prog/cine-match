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

test('manifest PWA instalable', async ({ page }) => {
  await page.goto('/');
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]')!.getAttribute('href')!)).json());
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i: any) => i.sizes === '512x512')).toBe(true);
  expect(manifest.lang).toBe('es-AR');
});
