import { expect, test, type Page } from '@playwright/test';

/**
 * v3.3 en PRODUCCIÓN con TMDB real (perfil nuevo, navegador limpio). Cada resultado filtrado se vuelve a comprobar
 * contra la ficha de TMDB (vía el proxy del servidor; el token no pasa por el navegador). Registra lo observado.
 * Comprueba que los filtros aplican sus reglas a datos reales; NO mide la precisión de la clasificación de público.
 */
const log = (...a: unknown[]) => console.log('[prod v3.3]', ...a);
const EAST_ASIA = ['CN', 'HK', 'JP', 'KP', 'KR', 'MN', 'MO', 'TW'];
const EUROPE = 'AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK'.split(' ');
const TEEN_KW = ['teen movie', 'teen drama', 'teen comedy', 'teen horror', 'teen fantasy', 'teen superhero', 'teen adventure', 'teenage romance', 'teen romance', 'based on young adult novel', 'lgbt teen', 'teen sex comedy', 'teen slasher', 'teen musical', 'teen series'];

async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Paso 1 de 3')).toBeVisible();
  for (const p of ['netflix', 'prime', 'disney', 'max', 'paramount']) { const c = page.getByTestId(`ob-${p}`); if (await c.count() && (await c.getAttribute('aria-pressed')) === 'false') await c.click(); }
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByRole('heading', { name: 'Para vos' })).toBeVisible({ timeout: 240000 });
}
interface Facts { key: string; title: string; year?: number; genres: number[]; countries: string[]; kw: string[]; vote?: number; votes?: number; certUS?: string }
async function facts(page: Page, key: string): Promise<Facts> {
  const [type, id] = key.split(':');
  const d = await (await page.request.get(`/api/tmdb/${type}/${id}?append_to_response=keywords,${type === 'movie' ? 'release_dates' : 'content_ratings'}&language=es-MX`)).json();
  const date = d.release_date ?? d.first_air_date;
  const certUS = type === 'movie'
    ? d.release_dates?.results?.find((x: { iso_3166_1: string }) => x.iso_3166_1 === 'US')?.release_dates?.find((y: { certification: string }) => y.certification)?.certification
    : d.content_ratings?.results?.find((x: { iso_3166_1: string }) => x.iso_3166_1 === 'US')?.rating;
  return {
    key, title: d.title ?? d.name, year: date ? Number(date.slice(0, 4)) : undefined, genres: (d.genres ?? []).map((g: { id: number }) => g.id),
    countries: [...new Set([...(d.origin_country ?? []), ...(d.production_countries ?? []).map((c: { iso_3166_1: string }) => c.iso_3166_1)])],
    kw: (d.keywords?.keywords ?? d.keywords?.results ?? []).map((k: { name: string }) => k.name.toLowerCase()), vote: d.vote_average, votes: d.vote_count, certUS,
  };
}
async function resultKeys(page: Page) {
  await expect(page.getByTestId('rec-item').first().or(page.getByTestId('filters-empty'))).toBeVisible({ timeout: 240000 });
  return page.getByTestId('rec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!));
}
async function applyText(page: Page, text: string) {
  const panel = page.getByTestId('filters-panel');
  await panel.getByTestId('text-input').fill(text);
  await panel.getByTestId('text-interpret').click();
  const prev = await panel.getByTestId('text-preview').innerText();
  log(`«${text}» →`, prev.replace(/\s+/g, ' ').slice(0, 300));
  await panel.getByTestId('text-apply').click();
  await expect(page.getByTestId('active-filters')).toContainText(`Texto: «${text.slice(0, 20)}`);
  return prev;
}
async function audienceOnPage(page: Page, path: string) {
  await page.goto(`/#/t/${path}`);
  const box = page.getByTestId('title-audience');
  await expect(box).toBeVisible({ timeout: 60000 });
  // esperar la ficha completa de TMDB (con su clasificación por edad) y el archivo de señales
  await expect(box).toHaveAttribute('data-complete', 'true', { timeout: 90000 });
  await expect(box).toHaveAttribute('data-signals', 'true', { timeout: 60000 });
  await box.locator('summary').click();
  const rows = await page.getByTestId('title-audience-row').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-audience'), e.getAttribute('data-status')])));
  log(path, (await box.locator('summary').innerText()).trim(), JSON.stringify(rows));
  return rows as Record<string, string>;
}

test('producción v3.3: texto libre, público objetivo y regiones con TMDB real', async ({ page }, info) => {
  test.setTimeout(1200000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const v = await (await page.request.get('/version.json')).json();
  log(info.project.name, JSON.stringify(v));
  expect(v.version).toBe('3.5.0');
  expect(v.algorithm).toBe('hybrid-narrative-3.4.0');
  const man = await (await page.request.get('/catalog/manifest.json')).json();
  expect(man.audience).toBeTruthy();
  await start(page);

  // Clasificación de público en fichas reales (comportamiento, no precisión)
  const euphoria = await audienceOnPage(page, 'tv/85552'); // TV-MA con protagonistas adolescentes
  expect(euphoria.teen).not.toBe('yes');
  expect(euphoria.adult).toBe('yes');
  const mean = await audienceOnPage(page, 'movie/10625'); // Chicas pesadas: «teen comedy»
  expect(mean.teen).toBe('yes');
  const bluey = await audienceOnPage(page, 'tv/82728');
  expect(bluey.kids).toBe('yes');
  expect(bluey.male).toBe('disabled');

  await page.goto('/');
  await page.getByTestId('filters-toggle').click();
  await page.getByTestId('watched-filter-all').click();
  const checked: Record<string, number> = {};

  // 1. Ejemplo del pedido
  await applyText(page, 'Películas de terror posteriores a 2015');
  let keys = await resultKeys(page);
  log('terror > 2015:', keys.length);
  for (const k of keys) { const f = await facts(page, k); expect(k.startsWith('movie:'), k).toBe(true); expect(f.genres, f.title).toContain(27); expect(f.year!, f.title).toBeGreaterThanOrEqual(2016); }
  checked.terror = keys.length;
  expect(keys.length).toBeGreaterThan(0);

  // 2. Thriller adulto posterior a 2015 (adulto = evidencia suficiente: clasificación o palabra clave)
  await page.getByTestId('text-clear').click();
  await applyText(page, 'Quiero un thriller adulto posterior a 2015');
  keys = await resultKeys(page);
  const thr = [];
  for (const k of keys) { const f = await facts(page, k); thr.push(`${f.title} (${f.year}, ${f.certUS ?? 's/c'})`); expect(f.genres, f.title).toContain(53); expect(f.year!).toBeGreaterThanOrEqual(2016); }
  log('thriller adulto:', thr);
  checked.thriller = keys.length;

  // 3. Excluir público adolescente: ninguna obra con etiqueta juvenil explícita y sin clasificación para adultos
  await page.getByTestId('text-clear').click();
  await applyText(page, 'Excluir producciones significativamente enfocadas en público adolescente');
  keys = await resultKeys(page);
  for (const k of keys) {
    const f = await facts(page, k);
    const teenKw = f.kw.filter((x) => TEEN_KW.includes(x));
    const adultRating = ['R', 'NC-17', 'TV-MA'].includes(f.certUS ?? '');
    if (teenKw.length) log('se mantuvo con etiqueta juvenil:', f.title, teenKw, f.certUS);
    expect(teenKw.length && !adultRating, `${f.title}: ${teenKw}`).toBeFalsy();
  }
  if (!keys.length) log('vacío al excluir adolescentes:', (await page.getByTestId('filters-empty').locator('..').innerText()).replace(/\s+/g, ' '));
  checked.noTeen = keys.length;
  expect(keys.length).toBeGreaterThan(0);

  // 4. Regiones: Europa excepto España, posteriores a 2010 con buena valoración
  await page.getByTestId('text-clear').click();
  await applyText(page, 'Producciones europeas posteriores a 2010 con buena valoración pública, excepto España');
  keys = await resultKeys(page);
  for (const k of keys) {
    const f = await facts(page, k);
    expect(f.countries.some((c) => EUROPE.includes(c)), `${f.title} ${f.countries}`).toBe(true);
    expect(f.countries, f.title).not.toContain('ES');
    expect(f.year!).toBeGreaterThanOrEqual(2011);
    expect(f.vote!, f.title).toBeGreaterThanOrEqual(6.95); // la app usa la nota que tenía al cargar la ficha
  }
  checked.europe = keys.length;
  log('europeas sin España:', keys.length);

  // 5. Panel: excluir Asia oriental (con coproducciones)
  await page.getByTestId('text-clear').click();
  const panel = page.getByTestId('filters-panel');
  await panel.getByTestId('region-east-asia').click();
  await panel.getByTestId('region-east-asia').click();
  await panel.getByTestId('genre-16').click();
  keys = await resultKeys(page);
  for (const k of keys) { const f = await facts(page, k); expect(f.countries.some((c) => EAST_ASIA.includes(c)), `${f.title} ${f.countries}`).toBe(false); }
  checked.noEastAsia = keys.length;
  // 6. Incluir Asia oriental
  await panel.getByTestId('region-east-asia').click();
  await panel.getByTestId('region-east-asia').click();
  await expect(panel.getByTestId('region-east-asia')).toHaveAttribute('data-state', 'include');
  keys = await resultKeys(page);
  for (const k of keys) { const f = await facts(page, k); expect(f.countries.some((c) => EAST_ASIA.includes(c)), `${f.title} ${f.countries}`).toBe(true); }
  checked.eastAsia = keys.length;
  await page.screenshot({ path: `test-results/${info.project.name}-prod-v33.png`, fullPage: true });
  log('títulos verificados contra TMDB:', JSON.stringify(checked));
  expect(errors).toEqual([]);
});
