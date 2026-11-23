import { expect, test, type Page } from '@playwright/test';

/**
 * Verificación en PRODUCCIÓN con TMDB real (no simulado). Perfil nuevo en un navegador limpio.
 * Registra lo observado en la consola del job; no inventa resultados: si algo no aparece, lo informa.
 */
const log = (...a: unknown[]) => console.log('[prod]', ...a);
const BTTF = [105, 165, 196]; // Volver al futuro I, II y III (ids de TMDB)

async function dump(page: Page, what: string) {
  const txt = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1500);
  log(`FALLO en ${what}. URL ${page.url()}. Pantalla: ${txt}`);
}
async function step<T>(page: Page, what: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try { const r = await fn(); log(`✓ ${what} (${Date.now() - t0} ms)`); return r; } catch (e) { await dump(page, what); throw e; }
}

async function rate(page: Page, id: number, overall: number, acting?: number) {
  return step(page, `valorar ${id}`, () => rateInner(page, id, overall, acting));
}
async function rateInner(page: Page, id: number, overall: number, acting?: number) {
  await page.goto(`/#/t/movie/${id}`);
  await page.waitForFunction((i) => location.hash.endsWith(`/movie/${i}`), id);
  await expect(page.getByTestId('title-scores')).toBeVisible({ timeout: 60000 });
  log(`ficha ${id}:`, await page.getByRole('heading', { level: 1 }).innerText());
  await page.getByTestId('overall').getByRole('button', { name: `Valoración general (1-10): ${overall}`, exact: true }).click({ timeout: 30000 });
  if (acting) {
    await page.getByTestId('toggle-aspects').click();
    await page.getByTestId('dim-acting').getByRole('radio', { name: new RegExp(`${acting} estrellas$`) }).click({ timeout: 30000 });
  }
  const t0 = Date.now();
  await page.getByTestId('save-rating').click();
  await expect(page.getByTestId('save-status')).toContainText('Guardado', { timeout: 15000 });
  await expect(page.getByTestId('save-rating')).toBeEnabled();
  return Date.now() - t0;
}

test('producción: guardado, actores, filtros, notas y Similares con TMDB real', async ({ page }, info) => {
  test.setTimeout(600000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('consola:', m.text().slice(0, 300)); });
  await page.goto('/');
  const v = await (await page.request.get('/version.json')).json();
  log(info.project.name, 'versión', JSON.stringify(v));
  expect(v.version).toBe('3.5.0');
  // Incorporación mínima: plataformas por defecto y saltear
  await expect(page.getByText('Paso 1 de 3')).toBeVisible();
  for (const p of ['netflix', 'prime', 'disney', 'max']) { const c = page.getByTestId(`ob-${p}`); if ((await c.getAttribute('aria-pressed')) === 'false') await c.click(); }
  await page.getByTestId('ob-next').click();
  await step(page, 'incorporación sin valoraciones → inicio', async () => {
    await page.getByTestId('ob-finish').click();
    await expect(page.getByRole('heading', { name: 'Para vos' })).toBeVisible({ timeout: 240000 });
  });

  // 1) Guardado: trilogía con Actuaciones 5★ + otros títulos; tiempos de confirmación
  const times: number[] = [];
  for (const id of BTTF) times.push(await rate(page, id, 9, 5));
  for (const [id, n] of [[603, 8], [550, 7], [13, 9], [680, 8], [27205, 8]] as [number, number][]) times.push(await rate(page, id, n));
  log('ms hasta «Guardado» por valoración', times);
  // Guardados consecutivos rápidos sobre el mismo título
  await page.goto('/#/t/movie/105');
  for (const n of [6, 7, 9]) {
    await page.getByTestId('overall').getByRole('button', { name: `Valoración general (1-10): ${n}`, exact: true }).click();
    await page.getByTestId('save-rating').click();
    await expect(page.getByTestId('save-status')).toContainText('Guardado', { timeout: 15000 });
  }
  await page.getByRole('link', { name: /Valoraciones/ }).click();
  await expect(page.getByTestId('rating-row')).toHaveCount(8);
  log('Valoraciones visibles tras guardar:', await page.getByTestId('rating-row').count());

  // 2) Ranking con actores: recalcular y buscar títulos de Michael J. Fox / Christopher Lloyd
  await page.getByRole('link', { name: /Inicio/ }).click();
  await page.getByTestId('apply-ranking').click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 120000 });
  await expect(page.getByTestId('apply-ranking')).not.toContainText('…', { timeout: 180000 });
  await page.getByTestId('apply-ranking').click();
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('rec-item')).toHaveCount(10);
  for (let i = 0; i < 4 && (await page.getByTestId('show-more').count()); i++) await page.getByTestId('show-more').click();
  const cards = await page.getByTestId('rec-item').count();
  const texts = await page.getByTestId('rec-explanation').allInnerTexts();
  const actorLines = texts.filter((t) => /Fox|Lloyd/.test(t));
  log(`tarjetas: ${cards}; con explicación por Fox/Lloyd entre las visibles: ${actorLines.length}`);
  const titles = await page.getByTestId('rec-item').locator('h3').allInnerTexts();
  log('primeros 15:', titles.slice(0, 15));
  await expect(page.getByTestId('rec-item').first().getByTestId('score-public')).toContainText('TMDB');
  await page.screenshot({ path: `test-results/prod-${info.project.name}-inicio.png` });

  // 3) Año dígito por dígito
  await page.getByTestId('filters-toggle').click();
  const year = page.getByTestId('filter-year-min');
  await year.tap();
  for (const d of '2010') await page.keyboard.type(d, { delay: 80 });
  await expect(year).toHaveValue('2010');
  await expect(page.getByTestId('active-filters')).toContainText('Desde 2010');
  await year.fill('');
  await year.blur();

  // 4) Sólo Terror (pocos candidatos en un historial sin terror)
  await page.getByTestId('genre-27').click();
  await expect(page.getByTestId('rec-item').first().or(page.getByTestId('filters-empty'))).toBeVisible({ timeout: 120000 });
  const horror = await page.getByTestId('rec-item').locator('h3').allInnerTexts();
  log('Sólo Terror:', horror.length, horror.slice(0, 8), (await page.getByTestId('discovered-note').count()) ? await page.getByTestId('discovered-note').innerText() : 'sin búsqueda extra');
  expect(horror.length).toBeGreaterThan(0);
  await page.getByTestId('genre-27').click();
  await page.getByTestId('genre-27').click();

  // 5) Filtro por actor con homónimos
  await page.getByTestId('person-input').fill('Michael J. Fox');
  await expect(page.getByTestId('person-hit').first()).toBeVisible();
  const hits = await page.getByTestId('person-hit').allInnerTexts();
  log('Personas «Michael J. Fox»:', hits);
  await page.locator('[data-testid="person-hit"][data-person-id="521"]').getByTestId('person-include').click();
  await page.getByTestId('watched-filter-all').click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 120000 });
  const fox = await page.getByTestId('rec-item').locator('h3').allInnerTexts();
  log('Con Michael J. Fox (en tus plataformas):', fox.length, fox.slice(0, 10), (await page.getByTestId('person-outside').count()) ? await page.getByTestId('person-outside').innerText() : '');
  expect(fox.length).toBeGreaterThan(0);
  await page.getByTestId('person-clear').click();
  await page.getByTestId('watched-filter-unwatched').click();

  // 6) Ficha: notas separadas y diagnóstico
  await page.goto('/#/t/movie/105');
  await expect(page.getByTestId('title-user-score')).toBeVisible();
  await expect(page.getByTestId('title-diagnostic')).toBeVisible({ timeout: 60000 });
  log('Ficha Volver al futuro:', (await page.getByTestId('title-scores').innerText()).replace(/\s+/g, ' '));

  // 7) Similares
  await page.goto('/#/similares');
  await page.getByTestId('similar-search').fill('Volver al futuro');
  await page.getByTestId('similar-hit').first().click();
  await expect(page.getByTestId('similar-item').first()).toBeVisible({ timeout: 180000 });
  const sims = await page.getByTestId('similar-item').evaluateAll((els) => els.slice(0, 8).map((e) => `${e.querySelector('h3')?.textContent} · ${e.querySelector('[data-testid=similarity]')?.textContent}`));
  log('Similares a Volver al futuro:', sims);
  log('Perfil:', await page.getByTestId('similar-profile').innerText());
  await page.screenshot({ path: `test-results/prod-${info.project.name}-similares.png`, fullPage: true });

  // 8) Recargar: datos siguen
  await page.reload();
  await page.goto('/#/valoraciones');
  await expect(page.getByTestId('rating-row')).toHaveCount(8);
  log('errores de página:', errors);
  expect(errors).toEqual([]);
});
