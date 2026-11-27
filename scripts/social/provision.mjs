// Crea (si no existe) y configura el proyecto Supabase de Cine Match Social. Idempotente.
//  1) proyecto Free en São Paulo  2) migraciones  3) autenticación por correo y contraseña sin confirmación por correo
//  4) claves VAPID (la privada queda sólo en los secretos de Supabase)  5) muestra URL y clave pública (anon).
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, webcrypto } from 'node:crypto';
import { api, findProject, keys, sql, PROJECT_NAME } from './mgmt.mjs';

const APP = process.env.APP_URL ?? 'https://cine-match-pied-tau.vercel.app';
let p = await findProject();
if (!p) {
  const { data: orgs } = await api('GET', '/organizations');
  console.log('Organizaciones:', orgs.map((o) => `${o.name} (${o.id})`).join(', '));
  if (!orgs.length) throw new Error('No hay organizaciones en la cuenta de Supabase');
  const body = { name: PROJECT_NAME, organization_id: orgs[0].id, region: 'sa-east-1', db_pass: randomBytes(24).toString('base64url') };
  const r = await api('POST', '/projects', body, { allow: [400, 422] });
  if (r.status >= 400) {
    console.log('Reintento con organization_slug:', JSON.stringify(r.data).slice(0, 300));
    const { organization_id, ...rest } = body;
    p = (await api('POST', '/projects', { ...rest, organization_slug: orgs[0].slug ?? organization_id })).data;
  } else p = r.data;
  console.log('Proyecto creado:', p.id ?? p.ref);
}
const ref = p.id ?? p.ref;
for (let i = 0; i < 90; i++) {
  const { data } = await api('GET', `/projects/${ref}`);
  console.log(`Estado: ${data.status}`);
  if (data.status === 'ACTIVE_HEALTHY') break;
  if (i === 89) throw new Error('El proyecto no quedó activo a tiempo');
  await new Promise((r) => setTimeout(r, 10000));
}
// Migraciones (cada archivo es idempotente)
for (const f of readdirSync('supabase/migrations').filter((x) => x.endsWith('.sql')).sort()) {
  await sql(ref, readFileSync(`supabase/migrations/${f}`, 'utf8'));
  console.log('Migración aplicada:', f);
}
// Autenticación: correo + contraseña, sin correo de confirmación (el SMTP gratuito no envía a terceros)
await api('PATCH', `/projects/${ref}/config/auth`, {
  site_url: APP, uri_allow_list: `${APP}/**`, mailer_autoconfirm: true, password_min_length: 8, disable_signup: false,
  external_email_enabled: true, external_anonymous_users_enabled: false,
});
console.log('Autenticación configurada');
// VAPID
const { data: secrets } = await api('GET', `/projects/${ref}/secrets`);
if (!secrets.some((s) => s.name === 'VAPID_PUBLIC_KEY')) {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  await api('POST', `/projects/${ref}/secrets`, [
    { name: 'VAPID_PUBLIC_KEY', value: pub }, { name: 'VAPID_PRIVATE_JWK', value: JSON.stringify(jwk) }, { name: 'VAPID_SUBJECT', value: APP },
  ]);
  // La clave pública también queda en la base (lectura pública) para recuperarla sin regenerar
  await sql(ref, `create table if not exists public.app_public_config (k text primary key, v text not null);
    alter table public.app_public_config enable row level security;
    revoke all on public.app_public_config from anon, authenticated;
    insert into public.app_public_config (k, v) values ('vapid_public_key', '${pub}') on conflict (k) do update set v = excluded.v;`);
  console.log('VAPID generada');
}
const vp = await sql(ref, `select v from public.app_public_config where k = 'vapid_public_key'`).catch(() => []);
const k = await keys(ref);
console.log('Claves disponibles:', k.names.join(', '));
console.log('==== CONFIGURACIÓN PÚBLICA (src/social/config.ts) ====');
console.log(`url: https://${ref}.supabase.co`);
console.log(`anonKey: ${k.anon ?? k.publishable}`);
console.log(`vapidPublicKey: ${vp?.[0]?.v ?? '(ver secretos)'}`);
