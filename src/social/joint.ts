/**
 * «Para ver juntos» · orden por mejor coincidencia conjunta. Criterio transparente, fuera de los motores:
 *   conjunta = promedio de las dos puntuaciones − ¼ de su diferencia.
 * Favorece títulos bien valorados por ambos y penaliza diferencias grandes (8 y 8 → 8; 10 y 6 → 7).
 * Sin las dos puntuaciones no se calcula (no se inventan datos faltantes).
 */
export const JOINT_PENALTY = 0.25;
export function jointScore(mine?: number, theirs?: number): number | undefined {
  if (mine === undefined || theirs === undefined || !Number.isFinite(mine) || !Number.isFinite(theirs)) return undefined;
  return (mine + theirs) / 2 - JOINT_PENALTY * Math.abs(mine - theirs);
}
