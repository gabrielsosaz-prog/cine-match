// Escribe en src/social/config.ts los valores PÚBLICOS del proyecto (URL, clave anon, clave pública VAPID) leídos
// con la API de administración. La clave anon es pública por diseño (RLS decide qué puede hacer cada usuario);
// las claves service_role / secret y la privada VAPID nunca se escriben.
import { readFileSync, writeFileSync } from 'node:fs';
import { findProject, keys, sql } from './mgmt.mjs';

const p = await findProject();
if (!p) throw new Error('No existe el proyecto');
const k = await keys(p.id);
const anon = k.anon ?? k.publishable;
if (!anon || /service_role|sb_secret_/.test(anon)) throw new Error('Clave pública no disponible');
const rows = await sql(p.id, "select v from public.app_public_config where k = 'vapid_public_key'");
const vapid = rows?.[0]?.v ?? '';
const f = 'src/social/config.ts';
let src = readFileSync(f, 'utf8');
src = src.replace(/url: '[^']*'/, `url: 'https://${p.id}.supabase.co'`).replace(/anonKey: '[^']*'/, `anonKey: '${anon}'`).replace(/vapidPublicKey: '[^']*'/, `vapidPublicKey: '${vapid}'`);
writeFileSync(f, src);
console.log('config.ts actualizado:', `https://${p.id}.supabase.co`, 'anon', anon.slice(0, 12) + '…', 'vapid', vapid.slice(0, 10) + '…');
