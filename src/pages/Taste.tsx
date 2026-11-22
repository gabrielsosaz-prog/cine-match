import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DIMENSIONS } from '../constants';
import { db } from '../db/db';
import { updateSettings } from '../db/repo';
import { describeFeatures, family, featureLabel } from '../engine/features';
import { migrateRating } from '../db/migrations';
import { useApp } from '../hooks/useApp';
import { getEngine, refreshRecommendations } from '../services/recommendations';
import type { DimensionId, TitleKey, TitleMeta } from '../types';
import { Card, Empty } from '../ui/components';
import { num } from '../ui/format';

function Bars({ items }: { items: { label: string; value: number; note: string }[] }) {
  const max = Math.max(0.5, ...items.map((i) => Math.abs(i.value)));
  return (
    <ul className="space-y-1.5">
      {items.map((i) => (
        <li key={i.label} className="text-sm">
          <div className="flex justify-between"><span className="truncate">{i.label}</span><span className="text-[11px] text-slate-400">{i.note}</span></div>
          <div className="relative h-2 rounded bg-ink-800">
            <div className={`absolute top-0 h-2 rounded ${i.value >= 0 ? 'left-1/2 bg-emerald-400' : 'right-1/2 bg-red-400'}`} style={{ width: `${(Math.abs(i.value) / max) * 50}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function Taste() {
  const { profileId, settings } = useApp();
  const rawRatings = useLiveQuery(() => db.ratings.where('profileId').equals(profileId).toArray(), [profileId]);
  const ratings = useMemo(() => (rawRatings ?? []).map(migrateRating), [rawRatings]);
  const titles = useLiveQuery(() => db.titles.bulkGet(ratings.map((r) => r.key)), [ratings]) ?? [];
  const snapshots = useLiveQuery(() => db.snapshots.where('profileId').equals(profileId).sortBy('at'), [profileId]) ?? [];
  const { profile, info } = useMemo(() => {
    const map = new Map<TitleKey, TitleMeta>(titles.filter(Boolean).map((t) => [t!.key, t!]));
    return { profile: getEngine().buildProfile(ratings, map, settings), info: describeFeatures([...map.values()]) };
  }, [ratings, titles, settings.dimensionWeights]);

  const feats = [...profile.features].filter(([f]) => !info.get(f)?.spoiler);
  const top = (fam: string, sign: 1 | -1, n = 6) => feats.filter(([f, a]) => family(f) === fam && a.count >= 1 && sign * a.affinity > 0.05)
    .sort((a, b) => sign * (b[1].affinity - a[1].affinity)).slice(0, n)
    .map(([f, a]) => ({ label: featureLabel(f, info), value: a.affinity, note: `${a.count} ${a.count === 1 ? 'título' : 'títulos'}` }));
  const rejected = [...top('g', -1, 4), ...top('k', -1, 4), ...top('lang', -1, 2), ...top('len', -1, 2)].sort((a, b) => a.value - b.value).slice(0, 8);
  const aspectPatterns = DIMENSIONS.map((d) => {
    const m = profile.dimFeatures.get(d.id);
    if (!m) return null;
    const fs = [...m].filter(([f, a]) => ['g', 'k', 'len', 'seas'].includes(family(f)) && a.count >= 2 && !info.get(f)?.spoiler);
    const likes = fs.filter(([, a]) => a.affinity > 0.3).sort((a, b) => b[1].affinity - a[1].affinity).slice(0, 3).map(([f]) => featureLabel(f, info));
    const dislikes = fs.filter(([, a]) => a.affinity < -0.3).sort((a, b) => a[1].affinity - b[1].affinity).slice(0, 2).map(([f]) => featureLabel(f, info));
    return likes.length || dislikes.length ? { dim: d.id, label: d.label, likes, dislikes } : null;
  }).filter((x): x is NonNullable<typeof x> => Boolean(x));
  const setWeight = async (d: DimensionId, v: number) => {
    await updateSettings(profileId, { dimensionWeights: { ...settings.dimensionWeights, [d]: v } });
  };

  if (!ratings.length) return <div className="space-y-3"><h1 className="text-2xl font-bold">Mi perfil de gustos</h1><Empty>Puntuá algunos títulos y acá vas a ver qué aprende el sistema sobre vos.</Empty></div>;
  const evo = snapshots.slice(-30);
  const w = 300, h = 70;
  const pts = evo.map((s, i) => `${(i / Math.max(1, evo.length - 1)) * w},${h - ((s.mean - 1) / 9) * h}`).join(' ');
  const first = evo[0], last = evo[evo.length - 1];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Mi perfil de gustos</h1>
      <p className="text-xs text-slate-400">Basado en {profile.ratedCount} valoraciones y {Math.max(0, profile.signalCount - profile.ratedCount)} señales (pendientes, abandonadas, descartadas). Marcar algo como visto, sin nota, no cuenta como que te gustó. Tu nota media: {num(profile.mean)}.{profile.ratedCount < 5 && ' Perfil provisional.'}</p>
      <Card><h2 className="mb-2 font-semibold">Géneros preferidos</h2>{top('g', 1).length ? <Bars items={top('g', 1)} /> : <p className="text-sm text-slate-400">Aún sin preferencias claras.</p>}</Card>
      <Card><h2 className="mb-2 font-semibold">Temáticas preferidas</h2>{top('k', 1, 8).length ? <Bars items={top('k', 1, 8)} /> : <p className="text-sm text-slate-400">Se completan cuando hay fichas con palabras clave.</p>}</Card>
      <Card><h2 className="mb-2 font-semibold">Características rechazadas</h2>{rejected.length ? <Bars items={rejected} /> : <p className="text-sm text-slate-400">Nada rechazado por ahora.</p>}</Card>
      <Card>
        <h2 className="mb-1 font-semibold">Dimensiones</h2>
        <p className="mb-2 text-[11px] text-slate-400">Tu promedio en cada aspecto y su peso: cuánto explica tu nota general (regresión sobre tu historial, mezclada con un peso parejo mientras haya pocos datos). 1,00 = peso promedio. Podés ajustarlo a mano.</p>
        <ul className="space-y-3">
          {profile.dimensions.map((d) => (
            <li key={d.id} className="text-sm" data-testid={`dimstat-${d.id}`}>
              <div className="flex justify-between"><span>{DIMENSIONS.find((x) => x.id === d.id)!.label}</span><span className="text-slate-400">{d.count ? `${num(d.mean)} · ${d.count}` : 'sin datos'} · peso {num(d.importance, 2)}{d.learned !== null ? ' (aprendido)' : ''}</span></div>
              <input type="range" min={0} max={2} step={0.25} value={settings.dimensionWeights[d.id] ?? 1} onChange={(e) => setWeight(d.id, Number(e.target.value))} className="w-full accent-amber-400" aria-label={`Peso manual de ${d.id}`} />
            </li>
          ))}
        </ul>
        <button onClick={() => refreshRecommendations(profileId, { trigger: 'ajuste de pesos' })} className="mt-2 text-sm text-accent underline">Recalcular ranking con estos pesos</button>
      </Card>
      <Card data-testid="aspect-patterns">
        <h2 className="mb-1 font-semibold">Patrones por aspecto</h2>
        <p className="mb-2 text-[11px] text-slate-400">Qué rasgos se asocian con tus notas altas o bajas en cada aspecto (sólo títulos donde puntuaste ese aspecto).</p>
        {aspectPatterns.length ? (
          <ul className="space-y-1.5 text-sm">
            {aspectPatterns.map((p) => (
              <li key={p.dim}><span className="font-medium">{p.label}:</span>{' '}
                {p.likes.length > 0 && <span className="text-emerald-300">te gusta en {p.likes.join(', ')}</span>}
                {p.likes.length > 0 && p.dislikes.length > 0 && ' · '}
                {p.dislikes.length > 0 && <span className="text-red-300">te falla en {p.dislikes.join(', ')}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-slate-400">Puntuá aspectos en algunos títulos para ver patrones.</p>}
      </Card>
      {evo.length > 1 && (
        <Card>
          <h2 className="mb-2 font-semibold">Evolución</h2>
          <svg viewBox={`0 0 ${w} ${h}`} className="h-20 w-full" role="img" aria-label="Evolución de tu nota media"><polyline points={pts} fill="none" stroke="#f5b83d" strokeWidth="2" /></svg>
          <p className="text-[11px] text-slate-400">Nota media: {num(first.mean)} → {num(last.mean)} · valoraciones: {first.ratingsCount} → {last.ratingsCount}</p>
          <p className="mt-1 text-[11px] text-slate-400">Rasgos fuertes ahora: {last.topFeatures.filter((f) => f.affinity > 0).slice(0, 5).map((f) => f.label).join(', ') || '—'}</p>
        </Card>
      )}
    </div>
  );
}
