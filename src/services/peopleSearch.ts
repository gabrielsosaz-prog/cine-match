/**
 * Búsqueda de personas tolerante (v3.2).
 *
 * TMDB ya resuelve nombres alternativos («Michael Fox» encuentra a Michael J. Fox, id 521, porque figura en sus
 * «también conocido como») y tildes. Lo que no resuelve son errores de escritura («Ben Afleck», «Jenifer Lopez»,
 * «Leonard DiCaprio»): ahí devuelve 0 resultados. Esta capa:
 *  1. Consulta /search/person además de /search/multi (en /search/multi las personas quedan detrás de títulos).
 *  2. Ordena las personas por coincidencia del nombre (ignorando iniciales intermedias, tildes y puntos) y
 *     popularidad, sin fusionar nunca dos ids distintos.
 *  3. Si nadie coincide bien, prueba variantes concretas (consonantes dobles/simples, «Di Caprio»/«DiCaprio», apellido
 *     solo) y se queda sólo con personas cuyo nombre se parezca al escrito (distancia de edición), marcadas
 *     «¿quisiste decir?».
 */
import type { PersonHit } from '../providers/tmdb';

export const normName = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.'’\-]/g, ' ').replace(/\s+/g, ' ').trim();
/** Tokens significativos: sin iniciales sueltas («j»), para que «Michael Fox» = «Michael J. Fox». */
export const nameTokens = (s: string) => normName(s).split(' ').filter((t) => t.length > 1);

export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * Coincidencia 0-1 entre lo escrito y un nombre: 1 = todos los tokens escritos están en el nombre (en cualquier
 * orden, iniciales ignoradas); valores menores = parecido aproximado (prefijos y errores de escritura).
 */
export function nameMatch(query: string, name: string): number {
  const q = nameTokens(query), n = nameTokens(name);
  if (!q.length || !n.length) return 0;
  const joinedQ = q.join(''), joinedN = n.join('');
  if (joinedQ === joinedN) return 1;
  let sum = 0;
  for (const t of q) {
    let best = 0;
    for (const u of n) {
      if (t === u) { best = 1; break; }
      if (u.startsWith(t) && t.length >= 3) best = Math.max(best, 0.9);
      const d = editDistance(t, u);
      const sim = 1 - d / Math.max(t.length, u.length);
      if (d <= (t.length >= 6 ? 2 : 1)) best = Math.max(best, Math.min(0.88, sim + 0.05));
    }
    sum += best;
  }
  // «Di Caprio» vs «DiCaprio»: comparar sin espacios
  const glued = 1 - editDistance(joinedQ, joinedN) / Math.max(joinedQ.length, joinedN.length);
  return Math.max(sum / q.length, glued >= 0.85 ? glued * 0.95 : 0);
}

/** Variantes para errores típicos: doblar o simplificar consonantes, unir partículas, apellido solo. */
export function spellingVariants(query: string): string[] {
  const toks = normName(query).split(' ').filter(Boolean);
  const out: string[] = [];
  if (toks.length >= 2) out.push(toks[toks.length - 1]); // apellido solo (TMDB ordena por popularidad)
  for (let i = 0; i + 1 < toks.length; i++) if (/^(di|de|da|del|van|von|la|le|mc|mac|o)$/.test(toks[i])) out.push([...toks.slice(0, i), toks[i] + toks[i + 1], ...toks.slice(i + 2)].join(' '));
  // Consonantes dobles/simples, empezando por los apellidos
  const order = toks.map((_, i) => i).sort((x, y) => (x === 0 ? 1 : 0) - (y === 0 ? 1 : 0));
  for (const i of order) {
    const t = toks[i];
    for (let k = 1; k < t.length; k++) {
      const ch = t[k];
      if (!'fnlstrpmcgb'.includes(ch)) continue;
      if (t[k - 1] === ch) out.push([...toks.slice(0, i), t.slice(0, k) + t.slice(k + 1), ...toks.slice(i + 1)].join(' '));
      else if (t[k + 1] !== ch && /[aeiou]/.test(t[k - 1]) && /[aeiou]/.test(t[k + 1] ?? '') ) out.push([...toks.slice(0, i), t.slice(0, k) + ch + t.slice(k), ...toks.slice(i + 1)].join(' '));
      else if (t[k + 1] !== ch && /[aeiou]/.test(t[k - 1]) && /[lr]/.test(t[k + 1] ?? '') && ch === 'f') out.push([...toks.slice(0, i), t.slice(0, k) + ch + t.slice(k), ...toks.slice(i + 1)].join(' '));
    }
  }
  const q = normName(query);
  return [...new Set(out)].filter((x) => x !== q);
}

export interface RankedPerson extends PersonHit { match: number; fuzzy?: boolean }

/** Ordena por coincidencia del nombre y popularidad; un mismo id nunca aparece dos veces. */
export function rankPeople(query: string, lists: PersonHit[][], fuzzy = false): RankedPerson[] {
  const by = new Map<number, RankedPerson>();
  for (const l of lists) for (const p of l) if (!by.has(p.id)) by.set(p.id, { ...p, match: nameMatch(query, p.name), fuzzy });
  // Coincidencia del nombre + popularidad: «Michael Fox» → Michael J. Fox (muy conocido) antes que otro Michael Fox;
  // «Jenifer Lopez» → Jennifer Lopez antes que una homónima casi desconocida
  const score = (p: RankedPerson) => p.match + 0.15 * Math.log10(1 + (p.popularity ?? 0)) + (p.knownFor.length ? 0.02 : 0);
  return [...by.values()].sort((a, b) => score(b) - score(a));
}

/**
 * Busca personas con tolerancia. `search` = la consulta a TMDB (/search/person). Devuelve las personas ordenadas y si
 * se usaron variantes de escritura. Máximo 6 consultas extra.
 */
export async function tolerantPeopleSearch(query: string, search: (q: string) => Promise<PersonHit[]>, first?: PersonHit[]): Promise<{ people: RankedPerson[]; corrected?: string }> {
  const base = first ?? (await search(query));
  let people = rankPeople(query, [base]);
  // Coincidencia completa con alguien conocido: no hace falta corregir
  if (people.some((p) => p.match >= 0.95 && (p.popularity ?? 0) >= 0.5)) return { people };
  const variants = spellingVariants(query).slice(0, 6);
  const found: PersonHit[][] = [];
  let corrected: string | undefined;
  for (const v of variants) {
    const r = await search(v).catch(() => [] as PersonHit[]);
    const good = r.filter((p) => nameMatch(query, p.name) >= 0.72);
    if (good.length) { found.push(good); corrected ??= good[0].name; }
    if (good.some((p) => nameMatch(query, p.name) >= 0.85 && (p.popularity ?? 0) >= 0.5)) break;
  }
  if (!found.length) return { people };
  people = rankPeople(query, [base, ...found], false).map((p) => ({ ...p, fuzzy: !base.some((b) => b.id === p.id) }));
  return { people: people.filter((p) => p.match >= 0.5 || !p.fuzzy), corrected };
}
