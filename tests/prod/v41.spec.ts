import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * v4.1 en PRODUCCIÓN con TMDB real (perfil nuevo, navegador limpio, emulación Android): tarjeta común en Inicio,
 * Quiero ver y Similares; sinopsis en español; tráiler bajo pedido; guardado, vista, nota, aspectos, comentario e
 * interés; persistencia; los tres motores; barra de 7 accesos; capturas cerradas y desplegadas.
 */
const log = (...a: unknown[]) => console.log('[prod v4.1]', ...a);
const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
const dump = (page: Page, store: string) => page.evaluate(async (s) => {
  const req = indexedDB.open('cine-match');
  const d: IDBDatabase = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const all: any[] = await new Promise((res) => { const r = d.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
  d.close();
  return all;
}, store);
const ratingOf = async (page: Page, key: string) => (await dump(page, 'ratings')).find((r) => r.key === key);

async function exercise(page: Page, card: Locator, shots: string) {
  const key = (await card.getAttribute('data-key'))!;
  await expect(card.getByTestId('card-synopsis')).not.toContainText('Cargando', { timeout: 60000 });
  log(shots, key, 'sinopsis:', (await card.getByTestId('card-synopsis').innerText()).slice(0, 90));
  const want = card.getByTestId('quick-want');
  if ((await want.getAttribute('aria-pressed')) !== 'true') await want.click();
  await expect(want).toHaveText(/Guardada/);
  await expect.poll(async () => (await ratingOf(page, key))?.list).toBe('want');
  await card.getByTestId('interest-mucho').click();
  await expect(card.getByTestId('interest-mucho')).toHaveAttribute('aria-checked', 'true');
  // tráiler con TMDB real, bajo pedido
  const y = await page.evaluate(() => window.scrollY);
  const t0 = Date.now();
  await card.getByTestId('trailer-button').click();
  const modal = page.getByTestId('trailer-modal');
  await expect(modal.or(card.getByTestId('trailer-none')).first()).toBeVisible({ timeout: 60000 });
  if (await modal.isVisible()) {
    log(shots, 'tráiler en', Date.now() - t0, 'ms:', await modal.getByTestId('trailer-audio').innerText());
    await page.screenshot({ path: `test-results/prod-${shots}-trailer.png` });
    await page.getByTestId('trailer-close').click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 5);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - y)).toBeLessThanOrEqual(5);
  } else log(shots, 'sin tráiler en TMDB');
  await card.getByTestId('quick-score').click();
  await card.getByRole('button', { name: 'Nota general 7' }).click();
  await card.getByTestId('score-save').click();
  await expect.poll(async () => { const r = await ratingOf(page, key); return [r?.overall, r?.watched]; }).toEqual([7, true]);
  await card.getByTestId('more-toggle').click();
  await expect(card.getByTestId('more-tech')).not.toContainText('Cargando', { timeout: 60000 });
  log(shots, 'técnica:', (await card.getByTestId('more-tech').innerText()).replace(/\s+/g, ' '));
  await card.getByTestId('more-panel').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await expect.poll(() => card.getByTestId('more-panel').locator('img').evaluateAll((im) => im.every((i) => (i as HTMLImageElement).complete)), { timeout: 15000 }).toBe(true);
  await page.screenshot({ path: `test-results/prod-${shots}-desplegada.png` });
  await card.getByTestId('quick-aspects').click();
  await card.getByRole('radio', { name: 'Trama y guion: 4 estrellas' }).click();
  await card.getByTestId('aspects-save').click();
  await expect.poll(async () => (await ratingOf(page, key))?.dimensions?.story).toBe(4);
  await card.getByTestId('card-comment').click();
  await card.getByTestId('comment').fill('Prueba automática de producción.');
  await card.getByTestId('comment-save').click();
  await expect.poll(async () => (await ratingOf(page, key))?.comment).toBe('Prueba automática de producción.');
  await card.getByTestId('more-close').click();
  await noHorizontalScroll(page);
  return key;
}

test('producción v4.1: tarjeta común con TMDB real en las tres pantallas y los tres motores', async ({ page }, info) => {
  test.setTimeout(900000);
  const shots = info.project.name;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const v = await (await page.request.get('/version.json')).json();
  log(shots, JSON.stringify(v));
  expect(v.version).toBe('4.2.0');
  await page.goto('/');
  await expect(page.getByText('Paso 1 de 3')).toBeVisible();
  await page.getByTestId('ob-next').click();
  const cards = page.getByTestId('quick-card');
  await expect(cards.first()).toBeVisible({ timeout: 120000 });
  const n = Math.min(10, await cards.count());
  for (let i = 0; i < n; i++) await cards.nth(i).getByRole('button', { name: new RegExp(`: ${[9, 4, 8, 3, 10, 6, 7, 2, 9, 5][i]}$`) }).first().click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 240000 });

  // Barra de 7 accesos
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  expect(await nav.getByRole('link').allInnerTexts()).toEqual(['Inicio', 'Buscar', 'Similares', 'Quiero ver', 'Recibidas', 'Notas', 'Ajustes']);
  for (const l of await nav.getByRole('link').all()) { const b = (await l.boundingBox())!; expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44); }
  await noHorizontalScroll(page);

  // Inicio (v3.4): sinopsis en español en las tarjetas visibles
  const t0 = Date.now();
  const first = page.getByTestId('rec-item').first();
  await expect(first.getByTestId('card-synopsis')).not.toContainText('Cargando', { timeout: 60000 });
  log(shots, 'primera sinopsis visible en', Date.now() - t0, 'ms');
  const syn = await page.getByTestId('rec-item').getByTestId('card-synopsis').allInnerTexts();
  log(shots, 'sinopsis disponibles:', syn.filter((s) => !/no disponible|no tiene la sinopsis|Cargando/.test(s)).length, 'de', syn.length);
  await first.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `test-results/prod-${shots}-inicio-cerrada.png` });
  const homeKey = await exercise(page, page.getByTestId('rec-item').nth(1), `${shots}-inicio`);
  // «Ver más» dos veces: 30 tarjetas, sin precargar reproductores
  await page.getByTestId('show-more').click();
  await page.getByTestId('show-more').click();
  await expect(page.getByTestId('rec-item')).toHaveCount(30);
  expect(await page.locator('iframe').count()).toBe(0);

  // Quiero ver: «Guardada» y sincronizado
  await page.getByTestId('nav-pendientes').click();
  const w = page.locator(`[data-testid="want-item"][data-key="${homeKey}"]`);
  await expect(w.getByTestId('quick-want')).toHaveText(/Guardada/, { timeout: 30000 });
  await expect(w.getByTestId('quick-score')).toHaveText(/Tu nota 7/);
  await page.screenshot({ path: `test-results/prod-${shots}-quiero-ver-cerrada.png` });
  await w.getByTestId('quick-want').click();
  await expect.poll(async () => (await ratingOf(page, homeKey))?.list).toBeUndefined();
  await w.getByTestId('quick-want').click();
  await expect.poll(async () => (await ratingOf(page, homeKey))?.list).toBe('want');

  // Similares
  await page.getByTestId('nav-similares').click();
  await page.getByTestId('similar-search').fill('Breaking Bad');
  await page.getByTestId('similar-hit').first().click();
  const s = page.getByTestId('similar-item').first();
  await expect(s).toBeVisible({ timeout: 240000 });
  await expect(s.getByTestId('card-compat')).toContainText('Similitud');
  await page.screenshot({ path: `test-results/prod-${shots}-similares-cerrada.png` });
  const simKey = await exercise(page, s, `${shots}-similares`);
  await page.getByTestId('nav-pendientes').click();
  await expect(page.locator(`[data-testid="want-item"][data-key="${simKey}"]`).getByTestId('quick-want')).toHaveText(/Guardada/, { timeout: 30000 });

  // Persistencia al cerrar y abrir
  const before = JSON.stringify((await dump(page, 'ratings')).sort((a, b) => a.key.localeCompare(b.key)));
  await page.reload();
  await expect(page.locator(`[data-testid="want-item"][data-key="${simKey}"]`)).toBeVisible({ timeout: 30000 });
  expect(JSON.stringify((await dump(page, 'ratings')).sort((a, b) => a.key.localeCompare(b.key)))).toBe(before);

  // Motores: v3.5 y v4.0 (satisfacción propia, advertencia en el desplegable)
  for (const e of ['v3.5', 'v4.0'] as const) {
    await page.goto('/#/ajustes');
    await page.getByTestId(`engine-${e}`).check();
    const t1 = Date.now();
    await page.goto('/#/');
    await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', e, { timeout: 240000 });
    const c = page.getByTestId('rec-item').first();
    await expect(c).toBeVisible({ timeout: 240000 });
    log(shots, e, 'ranking visible en', Date.now() - t1, 'ms');
    await expect(c.getByTestId('box-primary')).toHaveAttribute('data-label', e === 'v4.0' ? 'Satisfacción' : 'Para vos');
    if (e === 'v4.0') {
      await expect(c.getByTestId('card-compat')).toContainText('Compatibilidad');
      await expect(c.getByTestId('card-synopsis')).not.toContainText('Cargando', { timeout: 60000 });
      await c.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: `test-results/prod-${shots}-v40-cerrada.png` });
      await c.getByTestId('more-toggle').click();
      await expect(c.getByTestId('more-reliability')).toContainText('poco fiable');
      const own = (await c.locator('h3').innerText()).trim();
      const refs = (await c.getByTestId('similar-ref-row').allInnerTexts()).map((t) => t.split('\n')[0].trim());
      log(shots, 'v4.0 «Parecida a» de', own, '→', refs);
      expect(refs).not.toContain(own);
      await c.getByTestId('more-panel').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      // pósters chicos de «Parecida a»: carga diferida; se espera a que terminen antes de la captura
      await expect.poll(() => c.getByTestId('similar-ref-row').locator('img').evaluateAll((im) => im.every((i) => (i as HTMLImageElement).complete)), { timeout: 15000 }).toBe(true);
      log(shots, 'pósters «Parecida a» (ancho natural):', await c.getByTestId('similar-ref-row').locator('img').evaluateAll((im) => im.map((i) => (i as HTMLImageElement).naturalWidth)));
      await page.screenshot({ path: `test-results/prod-${shots}-v40-desplegada.png` });
    }
    await noHorizontalScroll(page);
  }
  expect(errors).toEqual([]);
});
