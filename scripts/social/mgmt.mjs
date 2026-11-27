// Cliente mínimo de la Management API de Supabase (sólo CI). Usa SUPABASE_ACCESS_TOKEN de los secretos de GitHub.
export const API = 'https://api.supabase.com/v1';
export const PROJECT_NAME = 'cine-match-social';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) { console.error('::error::Falta el secreto SUPABASE_ACCESS_TOKEN'); process.exit(1); }
export async function api(method, path, body, { allow = [] } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (r.ok || allow.includes(r.status)) return { status: r.status, data };
    if ((r.status === 429 || r.status >= 500) && attempt < 5) { await new Promise((res) => setTimeout(res, 3000 * (attempt + 1))); continue; }
    throw new Error(`${method} ${path} → ${r.status}: ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400)}`);
  }
}
export async function findProject() {
  const { data } = await api('GET', '/projects');
  return (data ?? []).find((p) => p.name === PROJECT_NAME);
}
export async function sql(ref, query) {
  const { data } = await api('POST', `/projects/${ref}/database/query`, { query });
  return data;
}
export async function keys(ref) {
  const { data } = await api('GET', `/projects/${ref}/api-keys`);
  const anon = data.find((k) => k.name === 'anon' || k.type === 'legacy' && k.name === 'anon');
  const publishable = data.find((k) => k.type === 'publishable');
  return { anon: anon?.api_key, publishable: publishable?.api_key, names: data.map((k) => `${k.name}:${k.type ?? ''}`) };
}
