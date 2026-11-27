/**
 * Fichas para mostrar títulos recibidos sin guardarlos en el catálogo local (lo recibido no cambia los datos con que
 * se calcula el próximo ranking). Caché en memoria por sesión; si el título ya está en el dispositivo se usa ese.
 */
import { db } from '../db/db';
import { getClient } from '../services/catalog';
import { parseKey, type AvailabilitySnapshot, type TitleKey, type TitleMeta } from '../types';

export interface DisplayTitle { meta: TitleMeta; snap?: AvailabilitySnapshot | null }
const cache = new Map<string, Promise<DisplayTitle>>();

export function displayTitle(k: TitleKey, opts: { language: string; country: string }): Promise<DisplayTitle> {
  const ck = `${k}|${opts.language}|${opts.country}`;
  let p = cache.get(ck);
  if (!p) {
    p = (async () => {
      const [local, snap] = await Promise.all([db.titles.get(k), db.availability.get(`${k}|${opts.country}`)]);
      if (local && local.completeness === 'full' && snap) return { meta: local, snap };
      const { type, id } = parseKey(k);
      const d = await (await getClient()).details(type, id, opts.language, opts.country);
      return { meta: local?.completeness === 'full' ? local : d.meta, snap: snap ?? d.availability };
    })();
    p.catch(() => cache.delete(ck));
    cache.set(ck, p);
  }
  return p;
}
