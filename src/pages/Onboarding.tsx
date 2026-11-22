import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { COUNTRIES, PLATFORMS } from '../constants';
import { db } from '../db/db';
import { saveRating, updateSettings } from '../db/repo';
import { useApp } from '../hooks/useApp';
import { friendlyError } from '../providers/errors';
import { discoverCandidates } from '../services/catalog';
import { refreshRecommendations } from '../services/recommendations';
import type { PlatformId, TitleKey, WatchStatus } from '../types';
import type { SearchResult } from '../providers/tmdb';
import { Chip, ErrorNote, Poster, Spinner, TypeBadge } from '../ui/components';
import { SearchResults, useSearch } from './Search';

/** Selección diversa de títulos conocidos: muy votados, intercalando películas/series y géneros. */
export function diversePicks(lists: SearchResult[][], n = 24): SearchResult[] {
  const all = lists.flat();
  const seen = new Set<string>();
  const byGenre = new Map<number, SearchResult[]>();
  for (const r of all.sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0))) {
    if (seen.has(r.key)) continue; seen.add(r.key);
    const g = r.genreIds[0] ?? 0;
    byGenre.set(g, [...(byGenre.get(g) ?? []), r]);
  }
  const out: SearchResult[] = [];
  const queues = [...byGenre.values()];
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) { const x = q.shift(); if (x) out.push(x); if (out.length >= n) break; }
  }
  return out;
}

function QuickRate({ r, profileId, onDone }: { r: SearchResult; profileId: string; onDone: () => void }) {
  const existing = useLiveQuery(() => db.ratings.get(`${profileId}|${r.key}`), [r.key]);
  const set = async (status: WatchStatus, overall?: number) => { await saveRating(profileId, r.key as TitleKey, { status, overall }); onDone(); };
  return (
    <div className="rounded-2xl bg-ink-900 p-2.5 ring-1 ring-white/5" data-testid="quick-card">
      <div className="flex gap-2.5">
        <Poster path={r.posterPath} title={r.title} className="h-20 w-14 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium leading-tight">{r.title}</div>
          <div className="flex items-center gap-1 text-xs text-slate-400"><TypeBadge type={r.type} />{r.year}</div>
          {existing && <div className="text-xs text-accent">{existing.overall ? `Tu nota: ${existing.overall}` : existing.status === 'want' ? 'Quiero verla' : existing.status === 'not_interested' ? 'No me interesa' : 'No la vi'}</div>}
        </div>
      </div>
      <div className="mt-2 flex gap-0.5">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button key={n} onClick={() => set('rated', n)} aria-label={`${r.title}: ${n}`} className={`h-8 flex-1 rounded text-xs font-semibold ${existing?.overall === n ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-400'}`}>{n}</button>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5 text-xs">
        <button onClick={() => set('want')} className="rounded-full bg-ink-800 px-2.5 py-1">Quiero verla</button>
        <button onClick={() => set('not_interested')} className="rounded-full bg-ink-800 px-2.5 py-1">No me interesa</button>
      </div>
    </div>
  );
}

export default function Onboarding() {
  const { profileId, settings } = useApp();
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [picks, setPicks] = useState<SearchResult[]>([]);
  const [err, setErr] = useState<string>();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const { hits } = useSearch(q, settings.language, settings.country);
  const count = useLiveQuery(() => db.ratings.where('profileId').equals(profileId).count(), [profileId]) ?? 0;
  useEffect(() => {
    if (step !== 2 || picks.length) return;
    const base = { language: settings.language, country: settings.country, providerIds: [] as number[], sort: 'vote_count.desc', minVotes: 2000 };
    Promise.all([discoverCandidates({ ...base, type: 'movie' }), discoverCandidates({ ...base, type: 'tv' }), discoverCandidates({ ...base, type: 'movie', page: 2 }), discoverCandidates({ ...base, type: 'tv', page: 2 })])
      .then((l) => setPicks(diversePicks(l)))
      .catch((e) => setErr(friendlyError(e)));
  }, [step]);
  const finish = async () => {
    setBusy(true);
    await updateSettings(profileId, { onboarded: true });
    await refreshRecommendations(profileId, { trigger: 'incorporación', rebuildPool: true }).catch(() => undefined);
    setBusy(false);
    nav('/');
  };
  if (step === 1) return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Bienvenido a Cine Match <span className="text-accent">AI</span></h1>
      <p className="text-slate-300">Paso 1 de 3 · ¿Qué plataformas usás?</p>
      <div className="flex flex-wrap gap-2">{PLATFORMS.map((p) => <Chip key={p.id} testId={`ob-${p.id}`} active={settings.platforms.includes(p.id)} onClick={() => updateSettings(profileId, { platforms: settings.platforms.includes(p.id) ? settings.platforms.filter((x) => x !== p.id) : [...settings.platforms, p.id as PlatformId] })}>{p.label}</Chip>)}</div>
      <label className="block text-sm">País
        <select value={settings.country} onChange={(e) => updateSettings(profileId, { country: e.target.value })} className="mt-1 w-full rounded-lg bg-ink-800 p-2.5 ring-1 ring-white/10">{COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
      </label>
      <button disabled={!settings.platforms.length} onClick={() => setStep(2)} data-testid="ob-next" className="w-full rounded-xl bg-accent py-3 font-semibold text-ink-950 disabled:opacity-40">Continuar</button>
    </div>
  );
  return (
    <div className="space-y-4">
      <p className="text-slate-300">Paso 2 de 3 · Puntuá rápido lo que ya viste (nota general del 1 al 10). Podés saltear los que no viste. Más adelante podés puntuar cada aspecto.</p>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar una película o serie que conozcas…" className="w-full rounded-xl bg-ink-800 px-4 py-3 ring-1 ring-white/10" data-testid="ob-search" />
      {q.trim().length >= 2 ? <SearchResults hits={hits} country={settings.country} profileId={profileId} /> : (
        <>
          {err && <ErrorNote>{err}</ErrorNote>}
          {!picks.length && !err && <Spinner label="Cargando títulos conocidos…" />}
          <div className="space-y-2">{picks.map((r) => <QuickRate key={r.key} r={r} profileId={profileId} onDone={() => undefined} />)}</div>
        </>
      )}
      <div className="safe-bottom sticky bottom-0 -mx-4 bg-ink-950/95 px-4 py-3">
        <button onClick={finish} disabled={busy} data-testid="ob-finish" className="w-full rounded-xl bg-accent py-3 font-semibold text-ink-950 disabled:opacity-50">
          {busy ? 'Paso 3 de 3 · Generando recomendaciones…' : count ? `Ver mis recomendaciones (${count} títulos)` : 'Saltear y ver recomendaciones provisionales'}
        </button>
      </div>
    </div>
  );
}
