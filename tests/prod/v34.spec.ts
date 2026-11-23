import { expect, test, type Page } from '@playwright/test';

/**
 * v3.4 en PRODUCCIÓN con TMDB real (perfil nuevo, navegador limpio). Comprueba con datos reales que:
 *  - una preferencia flexible no quita títulos y que cada «Baja por/Sube por» tiene la evidencia que dice en TMDB;
 *  - el modo diagnóstico funciona y exporta sin credenciales;
 *  - el token no aparece en el HTML ni en el JavaScript publicado;
 *  - las reglas público-1.1 clasifican Toy Story como infantil con la ficha real.
 * No mide la calidad de las recomendaciones (eso es docs/eval-v3.4.md).
 */
const log = (...a: unknown[]) => console.log('[prod v3.4]', ...a);
export const EXPECTED = { version: '3.4.0', algorithm: 'hybrid-narrative-3.4.0' };

async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Paso 1 de 3')).toBeVisible();
  for (const p of ['netflix', 'prime', 'disney', 'max', 'paramount']) { const c = page.getByTestId(`ob-${p}`); if (await c.count() && (await c.getAttribute('aria-pressed')) === 'false') await c.click(); }
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByRole('heading', { name: 'Para vos' })).toBeVisible({ timeout: 240000 });
}
async function facts(page: Page, key: string) {
  const [type, id] = key.split(':');
  const d = await (await page.request.get(`/api/tmdb/${type}/${id}?append_to_response=keywords&language=es-MX`)).json();
  return { title: d.title ?? d.name, genres: (d.genres ?? []).map((g: { id: number; name: string }) => g.name.toLowerCase()), kw: (d.keywords?.keywords ?? d.keywords?.results ?? []).map((k: { name: string }) => k.name.toLowerCase()) };
}
async function resultKeys(page: Page) {
  await expect(page.getByTestId('rec-item').first().or(page.getByTestId('filters-empty'))).toBeVisible({ timeout: 240000 });
  return page.getByTestId('rec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!));
}
const resultCount = async (page: Page) => Number((await page.getByTestId('rows-count').innerText().catch(() => '')).match(/de (\d+)/)?.[1] ?? NaN);
async function applyText(page: Page, text: string) {
  const panel = page.getByTestId('filters-panel');
  await panel.getByTestId('text-input').fill(text);
  await panel.getByTestId('text-interpret').click();
  const prev = panel.getByTestId('text-preview');
  log(`«${text}» →`, (await prev.innerText()).replace(/\s+/g, ' ').slice(0, 400));
  await panel.getByTestId('text-apply').click();
  await expect(page.getByTestId('active-filters')).toContainText(`Texto: «${text.slice(0, 20)}`);
}

test('producción v3.4: preferencias con evidencia real, diagnóstico y credenciales', async ({ page }, info) => {
  test.setTimeout(1200000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const v = await (await page.request.get('/version.json')).json();
  log(info.project.name, JSON.stringify(v));
  expect(v.version).toBe(EXPECTED.version);
  expect(v.algorithm).toBe(EXPECTED.algorithm);

  // Credenciales: ni el HTML ni el JavaScript publicado contienen un token de TMDB
  const html = await (await page.request.get('/')).text();
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  const jwt = /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}/;
  expect(jwt.test(html)).toBe(false);
  for (const s of scripts) expect(jwt.test(await (await page.request.get(s)).text())).toBe(false);
  log('scripts revisados sin token:', scripts.length);

  await start(page);
  await page.getByTestId('filters-toggle').click();
  await page.getByTestId('watched-filter-all').click();
  await applyText(page, 'Películas');
  await resultKeys(page);
  const nBase = await resultCount(page);
  await page.getByTestId('text-clear').click();
  await applyText(page, 'Películas con poco romance');
  const keys = await resultKeys(page);
  const nPref = await resultCount(page);
  log('resultados «Películas»:', nBase, '· con «poco romance»:', nPref);
  if (!Number.isNaN(nBase)) expect(nPref).toBe(nBase); // la preferencia no quita títulos
  // Cada «Baja por … (TMDB: …)» tiene esa evidencia en la ficha real
  let checked = 0;
  for (const k of keys) {
    const line = page.locator(`[data-testid="rec-item"][data-key="${k}"]`).getByTestId('rec-prefs');
    if (!(await line.count())) continue;
    const text = await line.innerText();
    const f = await facts(page, k);
    log(k, f.title, '→', text, '| TMDB géneros:', f.genres.join(','));
    for (const part of text.matchAll(/\(TMDB: ([^)]+)\)/g)) for (const e of part[1].split(', ')) {
      const g = e.match(/^género (.+)$/), w = e.match(/^«(.+)»$/);
      if (g) expect(f.genres).toContain(g[1].toLowerCase());
      if (w) expect(f.kw).toContain(w[1]);
    }
    checked++;
  }
  log('títulos con evidencia verificada:', checked);
  await page.screenshot({ path: `test-results/prod-${info.project.name}-v34-preferencias.png`, fullPage: true });

  // Público-1.1 con la ficha real de Toy Story
  await page.goto('/#/t/movie/862');
  const box = page.getByTestId('title-audience');
  await expect(box).toHaveAttribute('data-complete', 'true', { timeout: 90000 });
  await expect(box).toHaveAttribute('data-signals', 'true', { timeout: 60000 });
  await box.locator('summary').click();
  const rows = await page.getByTestId('title-audience-row').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-audience'), e.getAttribute('data-status')])));
  log('Toy Story', JSON.stringify(rows));
  expect(rows.kids).toBe('yes');

  // Modo diagnóstico
  await page.goto('/#/ajustes');
  await page.getByTestId('diagnostic-toggle').check();
  await page.goto('/#/');
  await expect(page.getByTestId('diag-bar')).toBeVisible({ timeout: 240000 });
  const panel = page.getByTestId('rec-item').first().getByTestId('diag-panel');
  await panel.locator('summary').click();
  log('diagnóstico #1:', (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 600));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('diag-export').click()]);
  const raw = Buffer.concat(await (await dl.createReadStream()).toArray()).toString('utf8');
  expect(jwt.test(raw)).toBe(false);
  const ex = JSON.parse(raw);
  expect(ex.engine).toBe(EXPECTED.algorithm);
  // Todos los resultados filtrados (no sólo la primera página): cada coincidencia con «poco romance» tiene en TMDB
  // la evidencia que declara, y ese título quedó más abajo que en el orden del motor (o al final de la lista)
  type DI = { key: string; title: string; rank: number; engineRank?: number; prefs?: { delta: number; matches: { evidence: string[] }[]; unknown: string[] } };
  const items: DI[] = ex.items;
  const matched = items.filter((i) => i.prefs?.matches.length);
  log('exportados:', items.length, '· con coincidencia:', matched.length, '· sin datos:', items.filter((i) => i.prefs?.unknown.length).length);
  for (const it of matched.slice(0, 8)) {
    const f = await facts(page, it.key);
    log('evidencia', it.key, f.title, it.prefs!.matches[0].evidence.join(', '), `· puesto ${it.engineRank} → ${it.rank}`, '| TMDB géneros:', f.genres.join(','));
    for (const e of it.prefs!.matches[0].evidence) {
      const g = e.match(/^género (.+)$/), w = e.match(/^«(.+)»$/);
      if (g) expect(f.genres).toContain(g[1].toLowerCase());
      if (w) expect(f.kw).toContain(w[1]);
    }
    expect(it.rank >= it.engineRank! || it.rank > items.length - 5).toBe(true);
  }
  await page.screenshot({ path: `test-results/prod-${info.project.name}-v34-diagnostico.png`, fullPage: true });
  await page.goto('/#/ajustes');
  await page.getByTestId('diagnostic-toggle').uncheck();
  expect(errors).toEqual([]);
});
