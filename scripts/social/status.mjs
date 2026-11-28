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
  (select count(*) from public.shared_interests)::int as intereses_compartidos,
  (select count(*) from public.social_events)::int as eventos,
  pg_size_pretty(pg_database_size(current_database())) as tamano_base`).catch((e) => [{ error: String(e).slice(0, 200) }]);
console.log(JSON.stringify(rows?.[0]));
const fns = await api('GET', `/projects/${ref}/functions`).catch(() => ({ data: [] }));
console.log('Funciones:', (fns.data ?? []).map((f) => `${f.slug} v${f.version} ${f.status} verify_jwt=${f.verify_jwt}`).join(', ') || 'ninguna');
// Comparación con el punto de recuperación de v4.2 (sólo cantidades): filas de la copia que ya no están y filas nuevas.
const diff = await sql(ref, `select case when to_regclass('backup_v42.want_items') is null then null else json_build_object(
  'quiero_ver_faltan', (select count(*) from backup_v42.want_items b where not exists (select 1 from public.want_items w where (w.owner, w.media_type, w.tmdb_id) = (b.owner, b.media_type, b.tmdb_id))),
  'quiero_ver_nuevas', (select count(*) from public.want_items w where not exists (select 1 from backup_v42.want_items b where (w.owner, w.media_type, w.tmdb_id) = (b.owner, b.media_type, b.tmdb_id))),
  'quiero_ver_ultimo_cambio', (select max(added_at) from public.want_items),
  'usuarios_faltan', (select count(*) from backup_v42.social_profiles b where not exists (select 1 from public.social_profiles p where p.user_id = b.user_id)),
  'contactos_faltan', (select count(*) from backup_v42.contacts b where not exists (select 1 from public.contacts c where (c.owner, c.contact) = (b.owner, b.contact))),
  'recomendaciones_faltan', (select count(*) from backup_v42.recommendations b where not exists (select 1 from public.recommendations r where r.id = b.id))
) end as v`).catch((e) => [{ v: String(e).slice(0, 200) }]);
console.log('Frente a backup_v42:', JSON.stringify(diff?.[0]?.v));
