// v4.3 · Punto de recuperación de la base social ANTES de migrar: copia las tablas de v4.2 a un esquema privado
// (backup_v42) dentro del mismo proyecto. Los datos no salen de Supabase ni se imprimen: sólo cantidades y huellas.
// Idempotente: si la copia ya existe no se pisa (se conserva la primera, la de v4.2).
import { findProject, sql } from './mgmt.mjs';
const ref = (await findProject()).id;
const TABLES = ['social_profiles', 'invites', 'contacts', 'recommendations', 'rec_inbox', 'want_items', 'push_subscriptions'];
await sql(ref, `create schema if not exists backup_v42; revoke all on schema backup_v42 from public, anon, authenticated;`);
for (const t of TABLES) {
  await sql(ref, `do $$ begin
    if not exists (select 1 from information_schema.tables where table_schema = 'backup_v42' and table_name = '${t}') then
      execute 'create table backup_v42.${t} as table public.${t}';
      execute 'revoke all on backup_v42.${t} from public, anon, authenticated';
    end if; end $$;`);
}
await sql(ref, `create table if not exists backup_v42._meta (k text primary key, v text not null);
  insert into backup_v42._meta (k, v) values ('created_at', now()::text) on conflict (k) do nothing;`);
const rows = await sql(ref, TABLES.map((t) => `select '${t}' as tabla,
  (select count(*) from public.${t})::int as actual, (select count(*) from backup_v42.${t})::int as copia,
  (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.${t} x) = (select md5(coalesce(string_agg(y::text, '|' order by y::text), '')) from backup_v42.${t} y) as identica`).join(' union all '));
const meta = await sql(ref, `select v from backup_v42._meta where k = 'created_at'`);
console.log('Copia backup_v42 creada:', meta?.[0]?.v);
for (const r of rows) console.log(`${r.tabla}: actual ${r.actual} · copia ${r.copia} · ${r.identica ? 'idéntica' : 'DIFERENTE (cambió después de la copia)'}`);
