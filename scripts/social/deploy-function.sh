#!/usr/bin/env bash
# Publica la función «notify» con la CLI de Supabase (sólo CI). Necesita SUPABASE_ACCESS_TOKEN.
set -euo pipefail
REF=$(node -e "import('./scripts/social/mgmt.mjs').then(async m=>{const p=await m.findProject();console.log(p.id??p.ref)})")
npx --yes supabase@2.122.1 functions deploy notify --project-ref "$REF" --use-api
echo "Función notify publicada en $REF"
