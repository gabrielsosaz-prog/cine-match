import { expect, test, type Page } from '@playwright/test';

/**
 * v3.1 en PRODUCCIÓN con TMDB real y el catálogo narrativo real. Perfil nuevo en navegador limpio.
 * Registra lo observado; no inventa resultados.
 */
const log = (...a: unknown[]) => console.log('[prod v3.1]', ...a);

async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Paso 1 de 3')).toBeVisible();
  for (const p of ['netflix', 'prime', 'disney', 'max', 'paramount']) { const c = page.getByTestId(`ob-${p}`); if (await c.count() && (await c.getAttribute('aria-pressed')) === 'false') await c.click(); }
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByRole('heading', { name: 'Para vos' })).toBeVisible({ timeout: 240000 });
}

test('producción v3.1: Similares narrativo (White Lotus), tráiler, persona, países y Paramount+', async ({ page }, info) => {
  test.setTimeout(600000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const v = await (await page.request.get('/version.json')).json();
  log(info.project.name, JSON.stringify(v));
  expect(v.version).toBe('3.1.0');
  const man = await (await page.request.get('/catalog/manifest.json')).json();
  log('catálogo', JSON.stringify(man));
  await start(page);

  // Similares: The White Lotus (tv:111803) — análisis semántico real disponible, nada al 100 %
  await page.goto('/#/similares');
  await page.getByTestId('similar-only-mine').uncheck();
  await page.getByTestId('similar-search').fill('The White Lotus');
  await page.getByTestId('similar-hit').first().click();
  const list = page.locator('[data-testid="similar-list"][data-current="true"] [data-testid="similar-item"]');
  await expect(list.first()).toBeVisible({ timeout: 240000 });
  await expect(page.getByTestId('similar-semantic')).toContainText('Análisis semántico real');
  const rows = await list.evaluateAll((els) => els.slice(0, 12).map((e) => `${e.querySelector('h3')?.textContent} · ${e.querySelector('[data-testid=similarity]')?.textContent} · ${e.querySelector('[data-testid=similarity-confidence]')?.textContent}`));
  log('Similares a The White Lotus:', rows);
  const pcts = (await page.getByTestId('similarity').allInnerTexts()).map((t) => Number(t.replace(/\D/g, '')));
  expect(Math.max(...pcts)).toBeLessThan(100);
  log('perfil:', (await page.getByTestId('similar-profile').innerText()).replace(/\s+/g, ' '));
  await list.first().getByTestId('similar-explanation').click();
  log('explicación del primero:', (await list.first().getByTestId('similar-explanation').innerText()).replace(/\s+/g, ' '));
  await page.screenshot({ path: `test-results/prod-${info.project.name}-v31-whitelotus.png`, fullPage: true });

  // Tráiler en una ficha real (Volver al futuro, 105)
  await page.goto('/#/t/movie/105');
  await page.getByTestId('trailer-button').click();
  const modal = page.getByTestId('trailer-modal');
  await expect(modal.or(page.getByTestId('trailer-none'))).toBeVisible({ timeout: 60000 });
  if (await modal.isVisible()) {
    log('tráiler:', await page.getByTestId('trailer-audio').innerText(), '|', await page.getByTestId('trailer-frame').getAttribute('src'));
    await page.goBack();
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(/#\/t\/movie\/105/);
  } else log('sin tráiler informado por TMDB');

  // Persona: búsqueda unificada y filmografía
  await page.goto('/#/buscar');
  await page.getByTestId('search-input').fill('Ricardo Darin');
  await expect(page.getByTestId('person-result').first()).toBeVisible({ timeout: 60000 });
  log('personas:', await page.getByTestId('person-result').evaluateAll((els) => els.slice(0, 3).map((e) => e.textContent?.replace(/\s+/g, ' ').slice(0, 80))));
  await page.getByTestId('person-result').first().click();
  await expect(page.getByTestId('person-credit').first()).toBeVisible({ timeout: 60000 });
  log('persona:', await page.getByTestId('person-name').innerText(), '|', await page.getByTestId('person-counts').innerText());
  await page.goBack();
  await expect(page.getByTestId('search-input')).toHaveValue('Ricardo Darin');

  // Países: excluir Estados Unidos en Inicio
  await page.goto('/#/');
  await page.getByTestId('filters-toggle').click();
  await page.getByTestId('country-input').fill('Estados');
  await page.getByTestId('country-hit').filter({ hasText: 'Estados Unidos' }).getByTestId('country-exclude').click();
  await expect(page.getByTestId('active-filters')).toContainText('Estados Unidos');
  await expect(page.getByTestId('rec-item').first().or(page.getByTestId('filters-empty'))).toBeVisible({ timeout: 120000 });
  log('sin EE. UU.:', await page.getByTestId('rec-item').evaluateAll((els) => els.slice(0, 8).map((e) => e.querySelector('h3')?.textContent)));
  // Verificación independiente con la ficha de TMDB: ninguno de los visibles tiene EE. UU. entre sus países
  const keys = await page.getByTestId('rec-item').evaluateAll((els) => els.slice(0, 10).map((e) => e.getAttribute('data-key')!));
  for (const k of keys) {
    const [type, id] = k.split(':');
    const d = await (await page.request.get(`/api/tmdb/${type}/${id}?language=es-MX`)).json();
    const cs = [...(d.origin_country ?? []), ...(d.production_countries ?? []).map((c: any) => c.iso_3166_1)];
    log('país', k, d.title ?? d.name, cs.join(','));
    expect(cs, `${k} tiene EE. UU.`).not.toContain('US');
  }
  await page.screenshot({ path: `test-results/prod-${info.project.name}-v31-paises.png` });
  await expect(page.getByTestId('filter-paramount')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
