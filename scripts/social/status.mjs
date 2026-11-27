// Resumen del proyecto: estado, tamaño de la base y cantidad de filas (sin datos personales).
import { api, findProject, sql } from './mgmt.mjs';
const p = await findProject();
if (!p) { console.log('Proyecto aún no creado'); process.exit(0); }
const ref = p.id ?? p.ref;
const { data } = await api('GET', `/projects/${ref}`);
console.log(`Proyecto ${ref} · ${data.status} · región ${data.region}`);
const rows = await sql(ref, `select
  (select count(*) from auth.users)::int as usuarios,
  (select count(*) from public.contacts)::int as contactos,
  (select count(*) from public.recommendations)::int as recomendaciones,
  (select count(*) from public.want_items)::int as quiero_ver_sync,
  (select count(*) from public.push_subscriptions)::int as push,
  pg_size_pretty(pg_database_size(current_database())) as tamano_base`).catch((e) => [{ error: String(e).slice(0, 200) }]);
console.log(JSON.stringify(rows?.[0]));
const fns = await api('GET', `/projects/${ref}/functions`).catch(() => ({ data: [] }));
console.log('Funciones:', (fns.data ?? []).map((f) => `${f.slug} v${f.version} ${f.status} verify_jwt=${f.verify_jwt}`).join(', ') || 'ninguna');
