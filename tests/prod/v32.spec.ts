import { expect, test, type Page } from '@playwright/test';

/**
 * v3.2 en PRODUCCIÓN con TMDB real. Perfil nuevo en navegador limpio. Registra lo observado; los ids de personas
 * son los reales de TMDB (Michael J. Fox 521, Leonardo DiCaprio 6193, Ben Affleck 880, Jennifer Lopez 16866,
 * Ricardo Darín 69310).
 */
const log = (...a: unknown[]) => console.log('[prod v3.2]', ...a);

async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Paso 1 de 3')).toBeVisible();
  for (const p of ['netflix', 'prime', 'disney', 'max', 'paramount']) { const c = page.getByTestId(`ob-${p}`); if (await c.count() && (await c.getAttribute('aria-pressed')) === 'false') await c.click(); }
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByRole('heading', { name: 'Para vos' })).toBeVisible({ timeout: 240000 });
}
async function searchPerson(page: Page, q: string) {
  await page.getByTestId('search-input').fill(q);
  // esperar a que los resultados correspondan a esta búsqueda (no a la anterior)
  await expect(page.getByTestId('search-view')).toHaveAttribute('data-results-for', q.trim(), { timeout: 60000 });
  await expect(page.getByTestId('person-result').first()).toBeVisible({ timeout: 60000 });
  const people = await page.getByTestId('person-result').evaluateAll((els) => els.slice(0, 4).map((e) => `${e.getAttribute('data-person-id')} ${e.textContent?.replace(/\s+/g, ' ').slice(0, 70)}`));
  const order = await page.locator('[data-testid="people-section"], [data-testid="titles-section"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  log(`«${q}»: personas`, people, '| orden', order.join(' > '));
  return { first: await page.getByTestId('person-result').first().getAttribute('data-person-id'), order };
}
async function filmography(page: Page) {
  await page.getByTestId('person-result').first().click();
  await expect(page.getByTestId('person-credit').first()).toBeVisible({ timeout: 60000 });
  for (let i = 0; i < 15 && (await page.getByTestId('person-more').count()); i++) await page.getByTestId('person-more').click();
  const titles = await page.getByTestId('person-credit').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-key')} ${e.querySelector('.font-semibold')?.textContent?.trim() ?? ''}`));
  log('filmografía de', await page.getByTestId('person-name').innerText(), '|', await page.getByTestId('person-counts').innerText(), '|', titles.slice(0, 12));
  await page.goBack();
  return titles;
}
async function pickCast(page: Page, q: string, id: number, how: 'include' | 'exclude') {
  await page.getByTestId('person-input').fill(q);
  const hit = page.locator(`[data-testid="person-hit"][data-person-id="${id}"]`);
  await expect(hit).toBeVisible({ timeout: 60000 });
  await hit.getByTestId(`person-${how}`).click();
}
const castTitles = async (page: Page) => {
  await expect(page.getByTestId('cast-summary').or(page.getByTestId('cast-empty')).first()).toBeVisible({ timeout: 180000 });
  return page.getByTestId('cast-result').locator('h3').allInnerTexts();
};

test('producción v3.2: personas, reparto, actores + países y tráileres con TMDB real', async ({ page }, info) => {
  test.setTimeout(900000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const v = await (await page.request.get('/version.json')).json();
  log(info.project.name, JSON.stringify(v));
  expect(v.version).toBe('3.3.0');
  expect(v.algorithm).toBe('hybrid-narrative-3.1.0');
  await start(page);

  // 11-13. Búsqueda general de personas
  await page.goto('/#/buscar');
  await page.getByTestId('search-mode-all').click();
  const mf = await searchPerson(page, 'Michael Fox');
  expect(mf.first).toBe('521');
  expect(mf.order[0]).toBe('people-section');
  const mfFilm = await filmography(page);
  expect(mfFilm.some((t) => t.startsWith('movie:105 '))).toBe(true); // Volver al futuro
  expect((await searchPerson(page, 'Michael J. Fox')).first).toBe('521');
  expect((await searchPerson(page, 'Leonardo DiCaprio')).first).toBe('6193');
  const leo = await filmography(page);
  expect(leo.some((t) => t.startsWith('movie:597 ') || t.startsWith('movie:27205 '))).toBe(true); // Titanic / El origen
  for (const q of ['leonardo di caprio', 'Ben Afleck', 'Jenifer Lopez']) {
    const r = await searchPerson(page, q);
    log(`«${q}» → ${r.first}`, (await page.getByTestId('search-corrected').count()) ? await page.getByTestId('search-corrected').innerText() : '');
    expect(r.first).toBe(q.startsWith('leo') ? '6193' : q.startsWith('Ben') ? '880' : '16866');
  }
  // Los títulos se siguen encontrando
  await page.getByTestId('search-input').fill('Volver al futuro');
  await expect(page.getByTestId('search-result').first()).toContainText(/Volver al futuro/i, { timeout: 60000 });

  // 14. Buscar por reparto: Ben Affleck + Jennifer Lopez, Todos
  await page.getByTestId('search-mode-cast').click();
  await pickCast(page, 'Ben Affleck', 880, 'include');
  await pickCast(page, 'Jennifer Lopez', 16866, 'include');
  await expect(page.getByTestId('people-mode-all')).toHaveAttribute('aria-checked', 'true');
  const both = await castTitles(page);
  log('Ben Affleck + Jennifer Lopez (Todos):', both, '|', await page.getByTestId('cast-summary').innerText());
  expect(both.some((t) => /Gigli/i.test(t))).toBe(true);
  expect(both.some((t) => /Medio tiempo|Halftime/i.test(t))).toBe(false); // documental: aparece como sí misma
  await page.screenshot({ path: `test-results/prod-${info.project.name}-v32-reparto.png`, fullPage: true });
  // 8. Cualquiera
  await page.getByTestId('people-mode-any').click();
  const anyT = await castTitles(page);
  log('Cualquiera:', anyT.length, '|', await page.getByTestId('cast-summary').innerText());
  expect(anyT.length).toBeGreaterThan(both.length);
  // 9. Ben Affleck incluido, Jennifer Lopez excluida
  await page.locator('[data-testid="person-selected"][data-person-id="16866"]').getByTestId('person-remove').click();
  await pickCast(page, 'Jennifer Lopez', 16866, 'exclude');
  const benNoJlo = await castTitles(page);
  log('Ben Affleck sin Jennifer Lopez:', benNoJlo.length, benNoJlo.slice(0, 10));
  expect(benNoJlo.length).toBeGreaterThan(0);
  expect(benNoJlo.some((t) => /Gigli/i.test(t))).toBe(false);

  // 10 + 1-4. Actor y países: Ricardo Darín, incluir Argentina, excluir España; verificación independiente con TMDB
  await page.getByTestId('person-clear').click();
  await pickCast(page, 'Ricardo Darín', 69310, 'include');
  await page.getByTestId('country-input').fill('Argentina');
  await page.getByTestId('country-hit').filter({ hasText: 'Argentina' }).getByTestId('country-include').click();
  await page.getByTestId('country-input').fill('España');
  await page.getByTestId('country-hit').filter({ hasText: 'España' }).getByTestId('country-exclude').click();
  const darin = await castTitles(page);
  log('Darín, Argentina sin España:', darin.length, darin.slice(0, 12));
  expect(darin.length).toBeGreaterThan(0);
  const keys = await page.getByTestId('cast-result').evaluateAll((els) => els.slice(0, 8).map((e) => e.getAttribute('data-key')!));
  for (const k of keys) {
    const [type, id] = k.split(':');
    const d = await (await page.request.get(`/api/tmdb/${type}/${id}?language=es-MX&append_to_response=${type === 'tv' ? 'aggregate_credits' : 'credits'}`)).json();
    const cs = [...(d.origin_country ?? []), ...(d.production_countries ?? []).map((c: any) => c.iso_3166_1)];
    const cast = (d.credits ?? d.aggregate_credits)?.cast?.map((c: any) => c.id) ?? [];
    log('verificado', k, d.title ?? d.name, cs.join(','), cast.includes(69310) ? 'con Darín' : 'Darín no figura en el reparto principal');
    expect(cs).toContain('AR');
    expect(cs).not.toContain('ES');
  }
  // Empty legítimo con datos reales: Darín + Michael J. Fox a la vez
  await page.getByTestId('person-clear').click();
  await pickCast(page, 'Ricardo Darín', 69310, 'include');
  await pickCast(page, 'Michael J. Fox', 521, 'include');
  await page.getByTestId('people-mode-all').click();
  await castTitles(page);
  await expect(page.getByTestId('cast-empty')).toBeVisible();
  log('vacío legítimo:', await page.getByTestId('cast-empty').innerText());

  // 16-19. Tráileres
  let searchSeen = false;
  for (const [k, name, year] of [['movie/105', 'Volver al Futuro', 1985], ['tv/1396', 'Breaking Bad', 2008], ['movie/496243', 'Parásitos', 2019], ['tv/111803', 'The White Lotus', 2021], ['tv/94997', 'La casa del dragón', 2022]] as const) {
    await page.goto(`/#/t/${k}`);
    await page.getByTestId('trailer-button').click();
    const modal = page.getByTestId('trailer-modal');
    await expect(modal.or(page.getByTestId('trailer-none')).first()).toBeVisible({ timeout: 60000 });
    if (!(await modal.isVisible())) { log(k, 'sin tráiler informado por TMDB'); continue; }
    const versions = await page.getByTestId('trailer-version').evaluateAll((els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim()));
    const search = modal.getByTestId('trailer-youtube-search');
    log(k, 'elegido:', await page.getByTestId('trailer-audio').innerText(), '| versiones:', versions, '| búsqueda YouTube:', (await search.count()) ? await search.first().getAttribute('href') : 'no');
    const audio = await page.getByTestId('trailer-audio').innerText();
    if (k === 'movie/105') expect(audio).toContain('español');
    if (k === 'movie/496243') expect(versions.some((x) => /VOSE/.test(x ?? '') && /Subtítulos en español indicados/.test(x ?? ''))).toBe(true);
    // «[Subtitled]» en inglés no se presenta como subtítulos en español
    expect(versions.filter((x) => /\[Subtitled\]/.test(x ?? '')).every((x) => /no confirmados/.test(x!))).toBe(true);
    // Invariante: la búsqueda externa aparece sólo si ninguna versión es en español o con subtítulos indicados
    // (las versiones van ordenadas: si la elegida es de idioma original, ninguna es mejor)
    const noSpanish = /no confirmados|no es el tráiler/.test(audio);
    expect(await search.count()).toBe(noSpanish ? 1 : 0);
    if (noSpanish) {
      const href = (await search.first().getAttribute('href'))!;
      expect(href.startsWith('https://www.youtube.com/results?search_query=')).toBe(true);
      expect(decodeURIComponent(href.split('search_query=')[1]).toLowerCase()).toBe(`${name} ${year} tráiler subtitulado español`.toLowerCase());
      log(k, 'búsqueda para', name, '→', href);
      searchSeen = true;
    }
    await page.goBack(); // 20. Atrás de Android
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#/t/${k}`));
  }

  log('búsqueda externa ejercitada con datos reales:', searchSeen);

  // 21. Inicio: filtros de personas y países visibles, y persistencia
  await page.goto('/#/');
  await page.getByTestId('filters-toggle').click();
  await pickCast(page, 'Ben Affleck', 880, 'include');
  await page.getByTestId('country-input').fill('México');
  await page.getByTestId('country-hit').filter({ hasText: 'México' }).getByTestId('country-exclude').click();
  await expect(page.getByTestId('active-filters')).toContainText('Actores incluidos: Ben Affleck');
  await expect(page.getByTestId('active-filters')).toContainText('Países excluidos: México');
  await expect(page.getByTestId('rec-item').first().or(page.getByTestId('filters-empty')).or(page.getByTestId('people-none')).first()).toBeVisible({ timeout: 180000 });
  log('Inicio con Ben Affleck sin México:', await page.getByTestId('rec-item').locator('h3').allInnerTexts(), (await page.getByTestId('person-outside').count()) ? await page.getByTestId('person-outside').innerText() : '');
  await page.reload();
  await expect(page.getByTestId('active-filters')).toContainText('Actores incluidos: Ben Affleck', { timeout: 60000 });
  await page.screenshot({ path: `test-results/prod-${info.project.name}-v32-inicio.png`, fullPage: true });
  expect(errors, errors.join('\n')).toEqual([]);
});
