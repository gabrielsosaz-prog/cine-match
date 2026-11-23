/**
 * v3.4 · Modo diagnóstico (para desarrollo). Se activa en Ajustes; no cambia el ranking ni los datos.
 * Para cada recomendación reúne lo que el motor y los filtros ya calcularon, sin agregar explicaciones nuevas:
 * puntaje final, aporte de cada canal (separando datos de inferencias), coincidencias con preferencias,
 * penalizaciones, metadatos faltantes, filtros aplicados, motivo de inclusión y posición.
 */
import { CHANNEL_LABEL, ALGORITHM_VERSION } from '../engine/recommender';
import type { ChannelId, RecommendationItem, TitleMeta } from '../types';
import { activeFilters, countriesOf, filterLabel, keywordNames, type RankFilters } from './filters';
import { audienceDataVersion } from './audience';
import { getNarrativeIndex } from './narrativeCatalog';
import { PREF_SHIFT } from './preferences';

const KEY = 'cine-match:diagnostic';
export const diagnosticOn = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
export const setDiagnostic = (on: boolean) => { try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* sin almacenamiento */ } };

/** Qué tipo de evidencia es cada canal. */
export const CHANNEL_BASIS: Record<ChannelId, 'datos' | 'aproximado'> = {
  theme: 'datos', comments: 'aproximado', aspects: 'datos', actors: 'datos', crew: 'datos', narrative: 'aproximado',
  similar: 'datos', genre: 'datos', format: 'datos', rejection: 'datos', quality: 'datos',
};
export const CHANNEL_SOURCE: Record<ChannelId, string> = {
  theme: 'palabras clave de TMDB × tus notas', comments: 'tus textos en «Otros» (análisis por palabras, en el dispositivo)', aspects: 'estrellas por aspecto que diste',
  actors: 'reparto de TMDB × tus notas', crew: 'dirección y guion de TMDB × tus notas', narrative: 'vectores semánticos y rasgos inferidos del catálogo (sinopsis + Wikipedia)',
  similar: 'rasgos de TMDB de títulos que puntuaste', genre: 'géneros de TMDB × tus notas', format: 'tipo, época, duración e idioma × tus notas',
  rejection: 'tus «No me interesa»', quality: 'nota pública de TMDB',
};

export interface Diagnostic {
  key: string; title: string; rank: number; engineRank?: number; score: number; base?: number; confidence: number; exploration: boolean; lowEvidence: boolean;
  channels: { id: ChannelId; label: string; contribution: number; weight: number; value: number; evidence: number; basis: 'datos' | 'aproximado'; source: string }[];
  penalties: string[];
  prefs?: RecommendationItem['prefs'];
  missing: string[];
  filters: string[];
  reason: string[];
}
export function diagnose(item: RecommendationItem, meta: TitleMeta, f: RankFilters, names: { genre: (id: number) => string; platform: (id: never) => string }): Diagnostic {
  const missing = [...meta.missing];
  if (!keywordNames(meta)?.length) missing.push('palabras clave');
  if (!countriesOf(meta).length) missing.push('país');
  if (!meta.certifications || !Object.keys(meta.certifications).length) missing.push(`clasificación por edad${audienceDataVersion() ? ' (se usa la del catálogo si está)' : ''}`);
  if (!getNarrativeIndex()?.get(meta.key)) missing.push('vector semántico y rasgos del catálogo (no está en el catálogo)');
  if (!meta.overview) missing.push('sinopsis');
  const penalties: string[] = [];
  if (item.rejectionPenalty) penalties.push(`descartes parecidos: ${item.rejectionPenalty} puntos`);
  for (const c of item.channels ?? []) if (c.contribution < -0.05 && c.id !== 'rejection') penalties.push(`${CHANNEL_LABEL[c.id]}: ${c.contribution} puntos`);
  for (const m of item.prefs?.matches ?? []) if (m.polarity < 0) penalties.push(`preferencia «${m.label}»: baja ${PREF_SHIFT} posiciones respecto del orden del motor (${m.evidence.join(', ')})`);
  return {
    key: item.key, title: meta.title, rank: item.rank, engineRank: item.engineRank, score: item.score, base: item.base, confidence: item.confidence, exploration: item.exploration, lowEvidence: Boolean(item.lowEvidence),
    channels: (item.channels ?? []).map((c) => ({ id: c.id, label: CHANNEL_LABEL[c.id], contribution: c.contribution, weight: c.weight, value: c.value, evidence: c.evidence, basis: CHANNEL_BASIS[c.id], source: CHANNEL_SOURCE[c.id] })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    penalties, prefs: item.prefs, missing: [...new Set(missing)],
    filters: activeFilters(f).map((id) => filterLabel(id, f, names.genre, names.platform as never)),
    reason: [item.exploration ? 'Puesto de exploración (1 de cada 6): título bien valorado poco parecido a tu historial.' : 'Elegido por su nota estimada, con diversidad (MMR).', ...(item.lowEvidence ? ['Llegó por una búsqueda extra en TMDB para tus filtros (poca evidencia propia).'] : []), ...item.explanation],
  };
}
/** Exportación para analizar errores (sin datos personales más allá de las notas estimadas). */
export function exportDiagnostics(ds: Diagnostic[], f: RankFilters) {
  return { app: 'Cine Match', engine: ALGORITHM_VERSION, exportedAt: new Date().toISOString(), filters: f, items: ds };
}
