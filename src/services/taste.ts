/**
 * v4.0 · Perfil de gustos, respuestas de interés y registro de recomendaciones mostradas.
 *
 * - Todo vive en el dispositivo (IndexedDB) y viaja en la exportación/copia de seguridad. Nada se envía a servidores.
 * - Las respuestas de interés («No me interesa», «Podría interesarme», «Me interesa», «Tengo muchas ganas», «Ya la vi»)
 *   NO son valoraciones: se guardan aparte, como historial (vale la más reciente por título).
 * - «No me interesa» además marca el descarte habitual de la app (lo usan todos los motores), igual que el botón de
 *   siempre. «Ya la vi» marca la vista. Ninguna respuesta cambia una nota existente.
 */
import { db } from '../db/db';
import { saveRating } from '../db/repo';
import { emptyTasteProfile, latestInterests } from '../engine/attraction';
import type { InterestAnswer, InterestRecord, Rating, RecommendationItem, ShownRecord, TasteProfile, TitleKey } from '../types';
import { scheduleLocalBackup } from './backups';
import { recordLedgerSoon } from './storageSafety';
import { requestRecompute } from './recompute';

export const INTEREST_ANSWERS: { id: InterestAnswer; label: string; short: string }[] = [
  { id: 'no', label: 'No me interesa', short: 'No' },
  { id: 'quiza', label: 'Podría interesarme', short: 'Podría' },
  { id: 'si', label: 'Me interesa', short: 'Me interesa' },
  { id: 'mucho', label: 'Tengo muchas ganas de verla', short: 'Muchas ganas' },
  { id: 'visto', label: 'Ya la vi', short: 'Ya la vi' },
];

export async function getTaste(profileId: string): Promise<TasteProfile> {
  return (await db.taste.get(profileId)) ?? emptyTasteProfile(profileId);
}
export async function saveTaste(t: TasteProfile): Promise<TasteProfile> {
  const prev = await db.taste.get(t.profileId);
  const next = { ...t, updatedAt: Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1) };
  await db.taste.put(next);
  scheduleLocalBackup();
  return next;
}

export async function listInterests(profileId: string): Promise<InterestRecord[]> {
  return db.interests.where('profileId').equals(profileId).toArray();
}
/** Última respuesta por título. */
export async function interestMap(profileId: string): Promise<Map<TitleKey, InterestRecord>> {
  return latestInterests(await listInterests(profileId));
}

/** Guarda una respuesta de interés (historial; nunca borra respuestas anteriores). */
export async function recordInterest(profileId: string, key: TitleKey, answer: InterestAnswer, o: { engine?: string; rank?: number; seenRating?: number; source?: string; recompute?: boolean } = {}): Promise<InterestRecord> {
  const prev = await db.interests.where('[profileId+key]').equals([profileId, key]).toArray();
  const at = Math.max(Date.now(), ...prev.map((p) => p.at + 1));
  const rec: InterestRecord = { id: `${profileId}|${key}|${at}`, profileId, key, answer, at, source: o.source ?? 'app' };
  if (o.engine) rec.engine = o.engine;
  if (o.rank !== undefined) rec.rank = o.rank;
  if (o.seenRating !== undefined) rec.seenRating = o.seenRating;
  await db.transaction('rw', [db.interests, db.ratings], async () => {
    await db.interests.put(rec);
    // Coherencia con el resto de la app (todos los motores): descarte y vista. No toca notas.
    if (answer === 'no') await saveRating(profileId, key, { notInterested: true });
    else if (answer === 'visto') await saveRating(profileId, key, { watched: true, notInterested: false });
    else {
      const r = await db.ratings.get(`${profileId}|${key}`);
      if (r?.notInterested) await saveRating(profileId, key, { notInterested: false });
    }
  });
  recordLedgerSoon(profileId);
  scheduleLocalBackup();
  // Igual que al valorar o descartar: el ranking se recalcula en segundo plano (la lista visible no cambia hasta
  // «Actualizar ranking», así el título respondido no desaparece bajo el dedo).
  if (o.recompute !== false) void requestRecompute(profileId, { trigger: 'interés', extraKeys: [key] }, 600).catch(() => undefined);
  return rec;
}

/**
 * Registra qué motor mostró cada título (y su mejor puesto). Se llama al calcular un ranking, con cualquier motor,
 * para los primeros puestos (los que realmente se ven).
 */
export async function recordShown(profileId: string, engine: string, items: RecommendationItem[], top = 30) {
  const now = Date.now();
  const list = items.filter((i) => i.rank <= top);
  if (!list.length) return;
  const ids = list.map((i) => `${profileId}|${i.key}|${engine}`);
  const prev = await db.shown.bulkGet(ids);
  const next: ShownRecord[] = list.map((i, n) => {
    const p = prev[n];
    if (p) return { ...p, lastAt: now, bestRank: Math.min(p.bestRank, i.rank) };
    const r: ShownRecord = { id: ids[n], profileId, key: i.key, engine, firstAt: now, lastAt: now, bestRank: i.rank };
    if (i.attraction) { r.attraction = i.attraction.value; r.satisfaction = i.attraction.satisfaction; }
    return r;
  });
  await db.shown.bulkPut(next).catch(() => undefined);
}

// ───────── Estadísticas por motor ─────────
export interface EngineStats {
  engine: string;
  /** Títulos mostrados en los primeros puestos */
  shown: number;
  /** Respuestas de interés a títulos que mostró este motor */
  answered: number;
  counts: Record<InterestAnswer, number>;
  /** % «Me interesa» o más entre los no vistos respondidos */
  interestRate: number | null;
  /** Mostrados que después se marcaron vistos o se puntuaron */
  watched: number;
  /** Notas posteriores (puntuadas después de mostrarse) */
  ratedAfter: number;
  meanRatingAfter: number | null;
  /** Diferencia media nota real − satisfacción estimada (sólo v4.0) */
  satisfactionError: number | null;
}
/**
 * Un título mostrado y no visto NO cuenta como fallo: sólo se cuenta lo que respondiste o viste.
 * Las notas «posteriores» son las que se guardaron después de que el motor mostró el título.
 */
export function engineStats(shown: ShownRecord[], interests: InterestRecord[], ratings: Rating[]): EngineStats[] {
  const byEngine = new Map<string, ShownRecord[]>();
  for (const s of shown) byEngine.set(s.engine, [...(byEngine.get(s.engine) ?? []), s]);
  // respuestas atribuidas: la que se dio estando el título en la lista de ese motor (o con ese motor registrado)
  const rating = new Map(ratings.map((r) => [r.key, r]));
  const out: EngineStats[] = [];
  for (const [engine, list] of byEngine) {
    const keys = new Map(list.map((s) => [s.key, s]));
    const counts: Record<InterestAnswer, number> = { no: 0, quiza: 0, si: 0, mucho: 0, visto: 0 };
    const last = new Map<TitleKey, InterestRecord>();
    for (const it of [...interests].sort((a, b) => a.at - b.at)) {
      const s = keys.get(it.key);
      if (!s || it.at < s.firstAt) continue;
      if (it.engine && it.engine !== engine) continue;
      last.set(it.key, it);
    }
    // «No me interesa» con el botón de siempre (sin respuesta de interés) también cuenta como «No»
    for (const s of list) {
      const r = rating.get(s.key);
      if (!last.has(s.key) && r?.notInterested && (r.notInterestedAt ?? r.updatedAt) >= s.firstAt) last.set(s.key, { id: '', profileId: s.profileId, key: s.key, answer: 'no', at: r.notInterestedAt ?? r.updatedAt });
    }
    for (const it of last.values()) counts[it.answer]++;
    const unseen = counts.no + counts.quiza + counts.si + counts.mucho;
    let watched = 0, ratedAfter = 0, sum = 0, errSum = 0, errN = 0;
    for (const s of list) {
      const r = rating.get(s.key);
      if (!r) continue;
      const after = (r.watchedAt ?? r.updatedAt) >= s.firstAt;
      if (r.watched && after) watched++;
      if (r.overall !== undefined && r.overall !== null && r.updatedAt >= s.firstAt) {
        ratedAfter++; sum += r.overall;
        if (s.satisfaction !== undefined) { errSum += r.overall - s.satisfaction; errN++; }
      }
    }
    out.push({
      engine, shown: list.length, answered: last.size, counts,
      interestRate: unseen ? (counts.si + counts.mucho) / unseen : null,
      watched, ratedAfter, meanRatingAfter: ratedAfter ? sum / ratedAfter : null, satisfactionError: errN ? errSum / errN : null,
    });
  }
  return out.sort((a, b) => a.engine.localeCompare(b.engine));
}
export async function loadEngineStats(profileId: string) {
  const [shown, interests, ratings] = await Promise.all([
    db.shown.where('profileId').equals(profileId).toArray(), listInterests(profileId), db.ratings.where('profileId').equals(profileId).toArray(),
  ]);
  return engineStats(shown, interests, ratings);
}
