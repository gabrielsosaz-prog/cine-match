import { expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

/** Ayudas compartidas por los flujos sociales de dos sesiones (copiadas de v42.spec.ts, que queda intacto). */
export const FAKE = process.env.FAKE_SOCIAL === '1';
export const UPSTREAM = process.env.TMDB_UPSTREAM;
export const run = Date.now().toString(36);
export const email = (who: string) => `cmtest-${who}-${run}@example.com`;
export const PASS = `Prueba-${run}!x`;
export const catalog = buildCatalog(15);
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

export async function phone(browser: Browser, device: string, who: string): Promise<{ ctx: BrowserContext; page: Page }> {
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
export async function onboard(page: Page) {
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
export async function signUp(page: Page, name: string, who: string) {
  await page.goto('./#/ajustes/cuenta');
  await page.getByTestId('account-name').fill(name);
  await page.getByTestId('account-email').fill(email(who));
  await page.getByTestId('account-password').fill(PASS);
  await page.getByTestId('account-submit').click();
  await expect(page.getByTestId('account-display')).toHaveText(name, { timeout: 30000 });
}
export const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
export const noticeText = (page: Page) => page.getByTestId('notice-info').last();
export async function deleteAccounts(pages: Page[]) {
  for (const p of pages) {
    try {
      await p.goto('./#/ajustes/cuenta');
      if (await p.getByTestId('account-delete').isVisible({ timeout: 5000 })) {
        await p.getByLabel('Confirmación').fill('ELIMINAR');
        await p.getByTestId('account-delete').click();
        await expect(p.getByTestId('account-submit')).toBeVisible({ timeout: 20000 });
      }
    } catch { /* la limpieza del workflow borra las que queden */ }
  }
}
/** A invita, B acepta con el enlace; A (único contacto) lo marca favorito. */
export async function link(a: Page, b: Page, aliasForA: string) {
  await a.goto('./#/ajustes/contactos');
  await a.getByTestId('invite-create').click();
  const code = (await a.getByTestId('invite-code').innerText()).replace(/-/g, '');
  await b.goto(`./#/invitacion?c=${code}`);
  await expect(b.getByTestId('invite-from')).toBeVisible({ timeout: 30000 });
  await b.getByTestId('invite-alias').fill(aliasForA);
  await b.getByTestId('invite-accept').click();
  await expect(b.getByTestId('invite-accepted')).toBeVisible();
  await a.reload();
  await expect(a.getByTestId('contact-row')).toHaveCount(1, { timeout: 30000 });
  await a.getByTestId('fav-offer-yes').click();
}
