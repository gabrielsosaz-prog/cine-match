// Elimina las cuentas de prueba (correo cmtest-*@example.com) y todos sus datos sociales (cascada).
import { findProject, sql } from './mgmt.mjs';
const p = await findProject();
if (!p) { console.log('Sin proyecto'); process.exit(0); }
const r = await sql(p.id ?? p.ref, `with d as (delete from auth.users where email like 'cmtest-%@example.com' returning 1) select count(*)::int as n from d`);
console.log('Cuentas de prueba eliminadas:', r?.[0]?.n ?? 0);
