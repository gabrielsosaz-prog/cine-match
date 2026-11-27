// v4.3 · Aplica las migraciones (todas idempotentes) al proyecto de producción, en orden. No toca autenticación ni secretos.
import { readFileSync, readdirSync } from 'node:fs';
import { findProject, sql } from './mgmt.mjs';
const ref = (await findProject()).id;
for (const f of readdirSync('supabase/migrations').filter((x) => x.endsWith('.sql')).sort()) {
  await sql(ref, readFileSync(`supabase/migrations/${f}`, 'utf8'));
  console.log('Migración aplicada:', f);
}
