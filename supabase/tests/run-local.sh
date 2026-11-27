#!/usr/bin/env bash
# Prueba el esquema social en un Postgres local limpio: bootstrap (emulación de Supabase) + migraciones + seguridad.
set -euo pipefail
cd "$(dirname "$0")/../.."
PSQL="psql -X -v ON_ERROR_STOP=1 ${PGURL:-postgresql://postgres@localhost/postgres}"
DB=cm_social_test
$PSQL -qc "drop database if exists $DB" -c "create database $DB"
T="psql -X -v ON_ERROR_STOP=1 ${PGURL_DB:-postgresql://postgres@localhost/$DB}"
$T -q -f supabase/tests/bootstrap-local.sql
for f in supabase/migrations/*.sql; do $T -q -f "$f"; done
# Segunda pasada: las migraciones deben ser idempotentes
for f in supabase/migrations/*.sql; do $T -q -f "$f"; done
$T -f supabase/tests/security.sql
$T -f supabase/tests/security-v43.sql
