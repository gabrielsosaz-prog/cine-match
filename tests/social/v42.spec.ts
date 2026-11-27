import { expect, test, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

/**
 * v4.2 Social · flujo completo entre DOS sesiones independientes (dos contextos de navegador = dos teléfonos):
 * A (Pixel 7) y B (pantalla de 360 px).
 *  - Local: servidor social simulado (FAKE_SOCIAL=1) y TMDB simulado.
 *  - CI «e2e»: Supabase de PRODUCCIÓN + TMDB real (a través del proxy publicado), compilación de la rama.
 *  - CI «prodlive»: la app publicada, Supabase y TMDB reales.
 * Las capturas v42-*.png no contienen datos personales (cuentas de prueba que se eliminan al final).
 */
const FAKE = process.env.FAKE_SOCIAL === '1';
const UPSTREAM = process.env.TMDB_UPSTREAM;
const run = Date.now().toString(36);
const email = (who: string) => `cmtest-${who}-${run}@example.com`;
const PASS = `Prueba-${run}!x`;
const catalog = buildCatalog(15);
const handler = fakeTmdbHandler(catalog);

async function mockTmdb(page: Page) {
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const url = route.request().url();
    let { status, body } = await handler(url);
    const m = new URL(url).pathname.replace(/^\/3/, '').match(/^\/(movie|tv)\/(\d+)(\/watch\/providers)?$/);
    if (status === 404 && m) {
      const id = Number(m[2]);
      const prov = { id, results: { AR: { link: 'https://www.themoviedb.org/', flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: null }] } } };
      status = 200;
      body = m[3] ? prov : { id, [m[1] === 'movie' ? 'title' : 'name']: `Título ${id}`, genres: [{ id: 18, name: 'Drama' }], overview: `Sinopsis del título ${id}.`, original_language: 'en', production_countries: [{ iso_3166_1: 'US' }], vote_average: 7, vote_count: 500, 'watch/providers': prov, credits: { cast: [], crew: [] } };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
}

async function phone(browser: Browser, device: string, who: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ ...devices[device], serviceWorkers: 'block' });
  if (FAKE) {
    // El servidor simulado se publica como https://social.prueba (la política de seguridad de la app sólo permite https)
    await ctx.addInitScript(() => { try { localStorage.setItem('cine-match:social-fake', 'https://social.prueba'); } catch { /* */ } });
    await ctx.route('https://social.prueba/**', async (route) => {
      const u = new URL(route.request().url());
      try { await route.fulfill({ response: await route.fetch({ url: `http://localhost:4174${u.pathname}` }) }); } catch { await route.abort('internetdisconnected'); }
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${who}] error de página:`, e.message));
  if (!UPSTREAM && !process.env.SOCIAL_BASE) await mockTmdb(page);
  if (UPSTREAM) {
    // TMDB real a través del proxy publicado (el token queda en el servidor)
    await page.route(/\/api\/(tmdb|health)/, async (route) => {
      const u = new URL(route.request().url());
      const r = await route.fetch({ url: `${UPSTREAM}${u.pathname}${u.search}`, headers: {} });
      await route.fulfill({ response: r });
    });
  }
  return { ctx, page };
}
async function onboard(page: Page) {
  await page.goto('./');
  if (!UPSTREAM && !process.env.SOCIAL_BASE) {
    await page.getByTestId('token-input').fill('eyJprueba');
    await page.getByTestId('save-token').click();
  }
  await page.getByTestId('ob-next').click();
  const cards = page.getByTestId('quick-card');
  await expect(cards.first()).toBeVisible({ timeout: 60000 });
  const n = Math.min(9, await cards.count());
  for (let i = 0; i < n; i++) await cards.nth(i).getByRole('button', { name: /: (9|8|7|6|5)$/ }).nth(i % 3).click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 90000 });
}
async function signUp(page: Page, name: string, who: string) {
  await page.goto('./#/ajustes/cuenta');
  await page.getByTestId('account-name').fill(name);
  await page.getByTestId('account-email').fill(email(who));
  await page.getByTestId('account-password').fill(PASS);
  await page.getByTestId('account-submit').click();
  await expect(page.getByTestId('account-display')).toHaveText(name, { timeout: 30000 });
}
const shot = (page: Page, name: string, full = false) => page.screenshot({ path: test.info().outputPath(`v42-${name}.png`), fullPage: full });
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
const noticeText = (page: Page) => page.getByTestId('notice-info').last();

test('v4.2 · dos teléfonos: vincular una vez, recomendar con un toque, recibir y ver juntos', async ({ browser }) => {
  test.setTimeout(600000);
  if (FAKE) await fetch('http://localhost:4174/admin/reset', { method: 'POST' });
  const A = await phone(browser, 'Pixel 7', 'A');
  const B = await phone(browser, 'Galaxy S5', 'B');
  const a = A.page, b = B.page;
  try {
    await Promise.all([onboard(a), onboard(b)]);
    // Uso sin cuenta: Compartir explica qué hace falta y no rompe nada
    await a.getByTestId('rec-item').first().getByTestId('share-main').click();
    await expect(a.getByTestId('share-need-account')).toBeVisible();
    await a.keyboard.press('Escape');

    await signUp(a, 'Ana Prueba', 'a');
    await signUp(b, 'Beto Prueba', 'b');

    // 1-2. A invita a B; B acepta con el enlace
    await a.goto('./#/ajustes/contactos');
    await a.getByTestId('invite-create').click();
    const code = (await a.getByTestId('invite-code').innerText()).replace(/-/g, '');
    expect(code).toMatch(/^[A-Z0-9]{12}$/);
    await b.goto(`./#/invitacion?c=${code}`);
    await expect(b.getByTestId('invite-from')).toHaveText('Ana Prueba', { timeout: 30000 });
    await b.getByTestId('invite-alias').fill('Ana');
    await b.getByTestId('invite-accept').click();
    await expect(b.getByTestId('invite-accepted')).toBeVisible();

    // 3. A: único contacto → se ofrece como favorito
    await a.reload();
    await expect(a.getByTestId('contact-row')).toHaveCount(1, { timeout: 30000 });
    await a.getByTestId('fav-offer-yes').click();
    await expect(a.getByTestId('contact-fav')).toHaveAttribute('aria-pressed', 'true');
    await shot(a, 'mis-contactos');

    // 4. A comparte con un toque desde Inicio
    await a.getByTestId('nav-inicio').click();
    const card = a.getByTestId('rec-item').first();
    await expect(card.getByTestId('card-actions')).toHaveAttribute('data-grid', '3x2');
    const key = (await card.getAttribute('data-key'))!;
    const title = (await card.locator('h3').innerText()).trim();
    await card.getByTestId('share-main').click();
    await expect(noticeText(a)).toContainText('Recomendación enviada a Beto Prueba');
    await expect(card.getByTestId('share-main')).toHaveAttribute('data-state', 'sent');
    await card.scrollIntoViewIfNeeded();
    await shot(a, 'compartir-favorito');
    // Duplicado: un segundo toque NO reenvía; muestra el estado y la opción explícita
    await card.getByTestId('share-main').click();
    await expect(a.getByTestId('share-already')).toBeVisible();
    await expect(a.getByTestId('share-resend')).toBeVisible();
    await a.keyboard.press('Escape');

    // 5-7. B recibe (tiempo real), ve el contador y la consulta
    await b.getByTestId('nav-inicio').click();
    await expect(b.getByTestId('inbox-badge')).toHaveText('1', { timeout: 30000 });
    await shot(b, 'barra-360-contador');
    await noHScroll(b);
    await b.getByTestId('nav-recibidas').click();
    const item = b.getByTestId('inbox-item').first();
    await expect(item.getByTestId('inbox-from-name')).toHaveText('Ana');
    await expect(item).toHaveAttribute('data-status', 'nueva');
    await expect(item.getByTestId('inbox-new')).toBeVisible();
    await expect(item.getByTestId('box-primary')).toHaveAttribute('data-label', 'Para vos');
    await expect(item.getByTestId('card-actions')).toBeVisible({ timeout: 60000 });
    await shot(b, 'me-recomendaron');
    await expect(b.getByTestId('inbox-badge')).toHaveCount(0, { timeout: 15000 });
    await noHScroll(b);

    // 8. B la guarda en Quiero ver (no desaparece de Me recomendaron)
    await item.getByTestId('quick-want').click();
    await expect(item.getByTestId('quick-want')).toHaveText(/Guardada/);
    await expect(item).toHaveAttribute('data-status', 'guardada');
    // A también la guarda
    await card.getByTestId('quick-want').click();
    await expect(card.getByTestId('quick-want')).toHaveText(/Guardada/);

    // 9-10. Ambos autorizan Para ver juntos → aparece la coincidencia
    for (const p of [a, b]) {
      await p.goto('./#/recibidas?tab=juntos');
      await p.getByTestId('together-enable').click();
      await expect(p.getByTestId('together-status')).toBeVisible({ timeout: 30000 });
    }
    await a.reload();
    await expect(a.locator(`[data-testid="together-item"][data-key="${key}"]`)).toBeVisible({ timeout: 60000 });
    await b.reload();
    const tb = b.locator(`[data-testid="together-item"][data-key="${key}"]`);
    await expect(tb).toBeVisible({ timeout: 60000 });
    await expect(tb.getByTestId('together-both')).toBeVisible();
    await expect(tb.getByTestId('together-their')).not.toHaveText('–', { timeout: 30000 });
    await shot(b, 'para-ver-juntos');

    // 11-12. B puntúa; la valoración de A queda intacta
    await tb.getByTestId('quick-score').click();
    await tb.getByRole('button', { name: 'Nota general 8' }).click();
    await tb.getByTestId('score-save').click();
    await expect(tb.getByTestId('quick-score')).toHaveText(/Tu nota 8/);
    await a.getByTestId('nav-inicio').click();
    await expect(a.locator(`[data-testid="rec-item"][data-key="${key}"]`).getByTestId('quick-score')).toHaveText(/Puntuar/);

    // 13. B → A con el selector de contactos (B no tiene favorito) y comentario
    await b.getByTestId('nav-buscar').click();
    await b.getByTestId('search-input').fill(FAKE ? catalog[3].name : 'Breaking Bad');
    const hit = b.getByTestId('search-result').first();
    await expect(hit).toBeVisible({ timeout: 30000 });
    await hit.getByTestId('share-icon').click();
    await expect(b.getByTestId('share-sheet')).toBeVisible();
    await b.getByTestId('share-comment').fill('Creo que esta nos puede gustar a los dos');
    await shot(b, 'selector-contactos');
    await b.getByTestId('share-send').click();
    await expect(noticeText(b)).toContainText('Recomendación enviada a Ana');
    await a.getByTestId('nav-recibidas').click();
    const ia = a.getByTestId('inbox-item').first();
    await expect(ia.getByTestId('inbox-comment')).toContainText('Creo que esta nos puede gustar', { timeout: 30000 });
    await expect(ia.getByTestId('inbox-when')).toContainText('Hoy');

    // Archivar con deshacer (no toca Quiero ver ni notas)
    await ia.getByTestId('inbox-archive').click({ timeout: 60000 });
    await expect(a.getByTestId('inbox-item')).toHaveCount(0);
    await a.getByTestId('inbox-filter-archivadas').click();
    await expect(a.getByTestId('inbox-item')).toHaveCount(1);
    await a.getByTestId('inbox-filter-todas').click();

    // Sin conexión: queda pendiente, sin confirmación falsa; al reconectar se envía
    await a.getByTestId('nav-inicio').click();
    await A.ctx.setOffline(true);
    if (FAKE) await fetch('http://localhost:4174/admin/outage', { method: 'POST', body: JSON.stringify({ on: true }) });
    const c2 = a.getByTestId('rec-item').nth(1);
    await c2.getByTestId('share-main').click();
    await expect(a.getByTestId('notice-info').last()).toContainText('pendiente');
    await expect(c2.getByTestId('share-main')).toHaveAttribute('data-state', 'pending');
    await A.ctx.setOffline(false);
    if (FAKE) await fetch('http://localhost:4174/admin/outage', { method: 'POST', body: JSON.stringify({ on: false }) });
    await a.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(c2.getByTestId('share-main')).toHaveAttribute('data-state', 'sent', { timeout: 30000 });

    // 15. B revoca: A deja de ver coincidencias
    await b.goto('./#/ajustes/privacidad');
    await b.getByTestId('privacy-matches').click();
    await expect(b.getByTestId('privacy-matches')).not.toBeChecked();
    await a.goto('./#/recibidas?tab=juntos');
    await expect(a.getByTestId('together-waiting')).toBeVisible({ timeout: 30000 });
    await expect(a.getByTestId('together-list')).toHaveCount(0);

    // Ajustes reorganizados y Mis gustos dentro de Ajustes
    await b.getByTestId('nav-ajustes').click();
    await expect(b.getByTestId('settings-menu')).toBeVisible();
    await b.getByTestId('settings-taste').click();
    await expect(b).toHaveURL(/#\/gustos/);
    await noHScroll(b);

    // Cambio de cuenta y persistencia: cerrar sesión no borra datos locales; al volver, todo sigue
    const ratedBefore = await b.evaluate(async () => { const r = indexedDB.open('cine-match'); const d: IDBDatabase = await new Promise((res) => { r.onsuccess = () => res(r.result); }); const n: number = await new Promise((res) => { const q = d.transaction('ratings').objectStore('ratings').count(); q.onsuccess = () => res(q.result); }); d.close(); return n; });
    await b.goto('./#/ajustes/cuenta');
    await b.getByTestId('account-signout').click();
    await expect(b.getByTestId('account-submit')).toBeVisible();
    await b.getByTestId('account-mode-signin').click();
    await b.getByTestId('account-email').fill(email('b'));
    await b.getByTestId('account-password').fill(PASS);
    await b.getByTestId('account-submit').click();
    await expect(b.getByTestId('account-display')).toHaveText('Beto Prueba', { timeout: 30000 });
    await b.reload();
    await b.getByTestId('nav-recibidas').click();
    await expect(b.getByTestId('inbox-item').first()).toBeVisible({ timeout: 30000 });
    const ratedAfter = await b.evaluate(async () => { const r = indexedDB.open('cine-match'); const d: IDBDatabase = await new Promise((res) => { r.onsuccess = () => res(r.result); }); const n: number = await new Promise((res) => { const q = d.transaction('ratings').objectStore('ratings').count(); q.onsuccess = () => res(q.result); }); d.close(); return n; });
    expect(ratedAfter).toBe(ratedBefore);
  } finally {
    // Eliminación de las cuentas de prueba desde la propia app
    for (const p of [a, b]) {
      try {
        await p.goto('./#/ajustes/cuenta');
        if (await p.getByTestId('account-delete').isVisible({ timeout: 5000 })) {
          await p.getByLabel('Confirmación').fill('ELIMINAR');
          await p.getByTestId('account-delete').click();
          await expect(p.getByTestId('account-submit')).toBeVisible({ timeout: 20000 });
        }
      } catch { /* la limpieza del workflow borra las que queden */ }
    }
    await A.ctx.close(); await B.ctx.close();
  }
});
