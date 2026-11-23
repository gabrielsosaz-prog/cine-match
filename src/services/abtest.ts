/**
 * v3.5 · Comparación a ciegas de motores (v3.4 publicado frente a v3.5 candidato).
 *
 * - Intercalado «team draft» (Radlinski et al., 2008): en cada ronda se sortea qué motor elige primero y cada uno
 *   aporta su título mejor ubicado que todavía no está en la lista. La lista mezclada no dice de qué motor viene cada
 *   título; los motores se asignan al azar a «A» y «B» en cada comparación.
 * - Respuestas: «Me interesa mucho» (2), «Me interesa algo» (1), «No me interesa» (0). «Ya la vi» y «No puedo
 *   evaluarla» NO cuentan como rechazo: quedan registradas pero fuera del puntaje.
 * - Todo se guarda sólo en este dispositivo (localStorage) y se puede exportar. Nunca modifica tus valoraciones.
 */
import { getSettings, listRatings } from '../db/repo';
import { db } from '../db/db';
import { hybridEngine, ALGORITHM_VERSION } from '../engine/recommender';
import { personalEngine, PERSONAL_ENGINE_VERSION } from '../engine/personalEngine';
import type { TitleKey, TitleMeta } from '../types';
import { latestRun, narrativeReady } from './recommendations';

export type AbAnswer = 'mucho' | 'algo' | 'no' | 'vista' | 'nose';
export const AB_ANSWERS: { id: AbAnswer; label: string }[] = [
  { id: 'mucho', label: 'Me interesa mucho' },
  { id: 'algo', label: 'Me interesa algo' },
  { id: 'no', label: 'No me interesa' },
  { id: 'vista', label: 'Ya la vi' },
  { id: 'nose', label: 'No puedo evaluarla' },
];
export const AB_POINTS: Partial<Record<AbAnswer, number>> = { mucho: 2, algo: 1, no: 0 };
export type Team = 'A' | 'B';
export interface AbItem { key: TitleKey; title: string; poster?: string | null; year?: number; team: Team; rankA?: number; rankB?: number; answer?: AbAnswer; at?: number }
export interface AbSession { id: string; createdAt: number; engines: Record<Team, string>; items: AbItem[] }
export const AB_SIZE = 12;

/** Generador determinista (mulberry32) para poder reproducir el sorteo en pruebas. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Team draft: lista mezclada sin repetidos; cada título queda acreditado al motor que lo eligió. */
export function teamDraft(a: TitleKey[], b: TitleKey[], n: number, rand: () => number): { key: TitleKey; team: Team }[] {
  const out: { key: TitleKey; team: Team }[] = [];
  const used = new Set<TitleKey>();
  let ia = 0, ib = 0, na = 0, nb = 0;
  const next = (list: TitleKey[], i: number) => { while (i < list.length && used.has(list[i])) i++; return i; };
  while (out.length < n) {
    ia = next(a, ia); ib = next(b, ib);
    const aLeft = ia < a.length, bLeft = ib < b.length;
    if (!aLeft && !bLeft) break;
    // el que tiene menos elegidos elige; si empatan, sorteo
    const pickA = !bLeft || (aLeft && (na < nb || (na === nb && rand() < 0.5)));
    if (pickA) { used.add(a[ia]); out.push({ key: a[ia], team: 'A' }); na++; }
    else { used.add(b[ib]); out.push({ key: b[ib], team: 'B' }); nb++; }
  }
  return out;
}

export interface EngineSummary { engine: string; shown: number; scored: number; points: number; mean: number | null; mucho: number; no: number; vista: number }
export interface AbSummary { sessions: number; answered: number; perEngine: EngineSummary[]; wins: Record<string, number>; ties: number }
/** Resumen por motor. «Ya la vi» y «No puedo evaluarla» no suman ni restan. Una comparación la gana el motor con más puntos. */
export function summarize(sessions: AbSession[]): AbSummary {
  const per = new Map<string, EngineSummary>();
  const wins: Record<string, number> = {}; let ties = 0, answered = 0;
  const get = (e: string) => { let s = per.get(e); if (!s) { s = { engine: e, shown: 0, scored: 0, points: 0, mean: null, mucho: 0, no: 0, vista: 0 }; per.set(e, s); } return s; };
  for (const s of sessions) {
    const pts: Record<Team, number> = { A: 0, B: 0 };
    let any = false;
    for (const it of s.items) {
      const e = get(s.engines[it.team]);
      e.shown++;
      if (!it.answer) continue;
      answered++;
      if (it.answer === 'vista') e.vista++;
      const p = AB_POINTS[it.answer];
      if (p === undefined) continue;
      any = true; e.scored++; e.points += p; pts[it.team] += p;
      if (it.answer === 'mucho') e.mucho++;
      if (it.answer === 'no') e.no++;
    }
    if (!any) continue;
    if (pts.A === pts.B) ties++;
    else { const w = s.engines[pts.A > pts.B ? 'A' : 'B']; wins[w] = (wins[w] ?? 0) + 1; }
  }
  for (const e of per.values()) e.mean = e.scored ? Math.round((e.points / e.scored) * 100) / 100 : null;
  return { sessions: sessions.length, answered, perEngine: [...per.values()].sort((x, y) => x.engine.localeCompare(y.engine)), wins, ties };
}

const storeKey = (profileId: string) => `cm-ab-v1:${profileId}`;
export function loadSessions(profileId: string): AbSession[] {
  try { const raw = localStorage.getItem(storeKey(profileId)); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveSessions(profileId: string, sessions: AbSession[]) {
  try { localStorage.setItem(storeKey(profileId), JSON.stringify(sessions)); } catch { /* sin almacenamiento: la comparación sigue en memoria */ }
}
export function answerItem(profileId: string, sessionId: string, key: TitleKey, answer: AbAnswer): AbSession[] {
  const all = loadSessions(profileId);
  const s = all.find((x) => x.id === sessionId);
  const it = s?.items.find((i) => i.key === key);
  if (it) { it.answer = answer; it.at = Date.now(); saveSessions(profileId, all); }
  return all;
}
export function clearSessions(profileId: string) { try { localStorage.removeItem(storeKey(profileId)); } catch { /* nada */ } }
/** Exportación: sólo la comparación (títulos mostrados, motor de cada uno, respuestas). Sin valoraciones ni claves. */
export function exportSessions(profileId: string) {
  const sessions = loadSessions(profileId);
  return { kind: 'cine-match-ab', version: 1, exportedAt: new Date().toISOString(), engines: [ALGORITHM_VERSION, PERSONAL_ENGINE_VERSION], summary: summarize(sessions), sessions };
}

/**
 * Arma una comparación nueva con los candidatos del último cálculo (los mismos que ve «Para vos»).
 * Excluye todo lo que ya tiene un registro tuyo (valorado, visto, descartado o pendiente) y lo ya respondido en
 * comparaciones anteriores, para que cada respuesta sea información nueva.
 */
export async function newSession(profileId: string, seed = Date.now()): Promise<AbSession | { error: string }> {
  const run = await latestRun(profileId);
  if (!run) return { error: 'Todavía no hay recomendaciones calculadas. Abrí «Para vos» primero.' };
  await narrativeReady(4000);
  const settings = await getSettings(profileId);
  const ratings = await listRatings(profileId);
  const mine = new Set(ratings.map((r) => r.key));
  const prev = new Set(loadSessions(profileId).flatMap((s) => s.items.filter((i) => i.answer).map((i) => i.key)));
  const cands = [...new Set([...(run.eligible ?? []), ...run.items.map((i) => i.key)])].filter((k) => !mine.has(k) && !prev.has(k));
  const metas = await db.titles.bulkGet([...new Set([...ratings.map((r) => r.key), ...cands])]);
  const titles = new Map(metas.filter((m): m is TitleMeta => Boolean(m)).map((m) => [m.key, m]));
  const candidates = cands.filter((k) => titles.has(k));
  if (candidates.length < AB_SIZE) return { error: 'No hay suficientes títulos nuevos para comparar. Actualizá las recomendaciones o valorá algunos títulos.' };
  await new Promise((r) => setTimeout(r, 0)); // deja pintar la interfaz antes de calcular
  const profile = hybridEngine.buildProfile(ratings, titles, settings);
  const input = { profile, ratings, titles, candidates, settings, limit: 40, seed: Math.floor(seed / 86400000) };
  const r34 = hybridEngine.rank(input).map((i) => i.key);
  await new Promise((r) => setTimeout(r, 0));
  const r35 = personalEngine.rank(input).map((i) => i.key);
  const rand = rng(seed);
  const flip = rand() < 0.5;
  const engines: Record<Team, string> = flip ? { A: PERSONAL_ENGINE_VERSION, B: ALGORITHM_VERSION } : { A: ALGORITHM_VERSION, B: PERSONAL_ENGINE_VERSION };
  const listA = flip ? r35 : r34, listB = flip ? r34 : r35;
  const items: AbItem[] = teamDraft(listA, listB, AB_SIZE, rand).map(({ key, team }) => {
    const m = titles.get(key)!;
    const ra = listA.indexOf(key), rb = listB.indexOf(key);
    return { key, team, title: m.title, poster: m.posterPath, year: m.year, rankA: ra >= 0 ? ra + 1 : undefined, rankB: rb >= 0 ? rb + 1 : undefined };
  });
  const session: AbSession = { id: `ab-${seed.toString(36)}`, createdAt: Date.now(), engines, items };
  saveSessions(profileId, [...loadSessions(profileId), session]);
  return session;
}
