/**
 * Evaluación offline con datos SINTÉTICOS. Los resultados miden coherencia interna del motor,
 * no precisión con usuarios reales.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '../../src/engine/profile';
import { rank, ALGORITHM_VERSION, hybridEngine } from '../../src/engine/recommender';
import type { TitleKey } from '../../src/types';
import { rng } from '../fixtures/fakeTmdb';
import { simulateHistory, syntheticMetas, USERS } from '../fixtures/synthetic';

const ndcg = (ranked: TitleKey[], rel: Map<TitleKey, number>, k = 10) => {
  const gain = (r: number) => Math.max(0, r - 6); // relevancia graduada: 7→1 … 10→4
  const dcg = ranked.slice(0, k).reduce((a, key, i) => a + gain(rel.get(key) ?? 0) / Math.log2(i + 2), 0);
  const ideal = [...rel.values()].sort((a, b) => b - a).slice(0, k).reduce((a, r, i) => a + gain(r) / Math.log2(i + 2), 0);
  return ideal ? dcg / ideal : 0;
};
const recall = (ranked: TitleKey[], relevant: Set<TitleKey>, k = 10) => (relevant.size ? ranked.slice(0, k).filter((x) => relevant.has(x)).length / Math.min(k, relevant.size) : 0);

describe('Evaluación offline (sintética)', () => {
  it('el motor supera a las líneas base de popularidad, calidad y azar', async () => {
    const { catalog, metas, byKey } = await syntheticMetas(25, 42);
    const methods = ['motor', 'motorPesosAprendidos', 'popularidad', 'calidad', 'azar'] as const;
    const acc = Object.fromEntries(methods.map((m) => [m, { ndcg: 0, recall: 0, items: new Set<TitleKey>() }])) as Record<(typeof methods)[number], { ndcg: number; recall: number; items: Set<TitleKey> }>;
    let runs = 0;
    const perUser: Record<string, { ndcg: number; recall: number }> = {};
    for (const [ui, u] of USERS.entries()) {
      let un = 0, ur = 0;
      for (let s = 0; s < 5; s++) {
        const { ratings, scores } = simulateHistory(u, catalog, 30, 1000 * ui + s);
        const train = new Set(ratings.map((r) => r.key));
        const test = [...metas.keys()].filter((k) => !train.has(k));
        const rel = new Map(test.map((k) => [k, scores.get(k)!]));
        const relevant = new Set(test.filter((k) => scores.get(k)! >= 8));
        const profile = buildProfile(ratings, metas);
        const lists: Record<string, TitleKey[]> = {
          // «motor»: pesos de canal previos; «motorPesosAprendidos»: pesos re-estimados por validación cruzada con
          // las 30 notas de entrenamiento (la evaluación es sobre títulos NO usados para aprender)
          motor: rank({ profile, ratings, titles: metas, candidates: test, limit: 10, seed: s }).map((i) => i.key),
          motorPesosAprendidos: rank({ profile: hybridEngine.buildProfile(ratings, metas), ratings, titles: metas, candidates: test, limit: 10, seed: s }).map((i) => i.key),
          popularidad: [...test].sort((a, b) => byKey.get(b)!.popularity - byKey.get(a)!.popularity),
          calidad: [...test].sort((a, b) => byKey.get(b)!.vote - byKey.get(a)!.vote),
          azar: (() => { const r = rng(s + 9); return [...test].sort(() => r() - 0.5); })(),
        };
        for (const m of methods) {
          const n = ndcg(lists[m], rel), rc = recall(lists[m], relevant);
          acc[m].ndcg += n; acc[m].recall += rc; lists[m].slice(0, 10).forEach((k) => acc[m].items.add(k));
          if (m === 'motor') { un += n; ur += rc; }
        }
        runs++;
      }
      perUser[u.name] = { ndcg: +(un / 5).toFixed(3), recall: +(ur / 5).toFixed(3) };
    }
    const summary = Object.fromEntries(methods.map((m) => [m, {
      'NDCG@10': +(acc[m].ndcg / runs).toFixed(3),
      'Recall@10': +(acc[m].recall / runs).toFixed(3),
      cobertura: +(acc[m].items.size / metas.size).toFixed(3),
    }]));
    const report = { algorithmVersion: ALGORITHM_VERSION, generatedAt: new Date().toISOString(), dataset: `sintético: ${metas.size} títulos, ${USERS.length} perfiles × 5 semillas, 30 valoraciones de entrenamiento c/u`, aviso: 'Datos sintéticos: no demuestran precisión con usuarios reales.', resumen: summary, motorPorPerfil: perUser };
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/evaluation-results.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    expect(summary.motor['NDCG@10']).toBeGreaterThan(summary.popularidad['NDCG@10']);
    expect(summary.motor['NDCG@10']).toBeGreaterThan(summary.calidad['NDCG@10']);
    expect(summary.motor['NDCG@10']).toBeGreaterThan(summary.azar['NDCG@10']);
    expect(summary.motor['Recall@10']).toBeGreaterThan(summary.popularidad['Recall@10']);
    expect(summary.motor.cobertura).toBeGreaterThan(0.25);
  });
});
