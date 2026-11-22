/**
 * Filtros de personas (v3.2): títulos donde participan (o no) ciertas personas, por id único de TMDB.
 * Se recuperan de sus filmografías completas (/person/{id}/combined_credits), no del ranking: así aparecen también
 * títulos que el motor nunca había considerado.
 *
 * Reglas (documentadas también en services/filters.ts):
 *  - Actuación: crédito de reparto que no sea «como sí mismo» ni talk show/noticiero/documental. Producción y equipo
 *    técnico NO cuentan para una persona de actuación.
 *  - Dirección/guion (u otro departamento): créditos de su departamento.
 *  - Series: cuenta cualquier crédito de reparto de la serie, también como invitado (TMDB agrupa los créditos por
 *    serie con la cantidad de episodios). «Todos» exige que todos figuren en la serie, no necesariamente en el mismo
 *    episodio.
 *  - Excluir: se quita el título si la persona aparece en él (en reparto, también como sí misma; o en su departamento).
 *  - La exclusión tiene prioridad sobre la inclusión.
 */
import type { TitleKey } from '../types';
import { personFilmography } from './catalog';
import { includedPeople, type PersonRef, type RankFilters } from './filters';

const isActing = (p: PersonRef) => !p.department || p.department === 'Acting';

export async function creditKeys(p: PersonRef, language: string, purpose: 'include' | 'exclude'): Promise<Set<TitleKey>> {
  if (isActing(p)) {
    const list = await personFilmography(p.id, language, { role: 'cast', fiction: purpose === 'include' });
    return new Set(list.map((c) => c.key));
  }
  const list = await personFilmography(p.id, language, { role: 'crew' });
  // Si la caché es anterior a v3.2 no tiene departamento: se acepta cualquier crédito de equipo
  return new Set(list.filter((c) => !c.department || c.department === p.department || (p.department === 'Directing' && c.job === 'Director') || (p.department === 'Writing' && c.department === 'Writing')).map((c) => c.key));
}

export interface PeopleSets {
  /** títulos permitidos por la inclusión (undefined = sin inclusión) */
  allow?: Set<TitleKey>;
  /** títulos quitados por la exclusión */
  deny: Set<TitleKey>;
  /** cantidad de títulos de cada persona incluida (para explicar resultados vacíos) */
  perPerson: { person: PersonRef; count: number }[];
}

export async function peopleSets(f: RankFilters, language: string): Promise<PeopleSets | undefined> {
  const inc = includedPeople(f);
  const exc = f.excludePeople ?? [];
  if (!inc.length && !exc.length) return undefined;
  const incSets = await Promise.all(inc.map((p) => creditKeys(p, language, 'include')));
  const excSets = await Promise.all(exc.map((p) => creditKeys(p, language, 'exclude')));
  let allow: Set<TitleKey> | undefined;
  if (incSets.length) {
    if (f.peopleMode === 'all') allow = new Set([...incSets[0]].filter((k) => incSets.every((s) => s.has(k))));
    else allow = new Set(incSets.flatMap((s) => [...s]));
  }
  const deny = new Set(excSets.flatMap((s) => [...s]));
  if (allow) for (const k of deny) allow.delete(k);
  return { allow, deny, perPerson: inc.map((person, i) => ({ person, count: incSets[i].size })) };
}
