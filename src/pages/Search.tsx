import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { STATUS_LABELS } from '../constants';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { friendlyError } from '../providers/errors';
import { refreshAvailability, searchTitles, type SearchHit } from '../services/catalog';
import { AvailabilityLine, Empty, ErrorNote, Poster, Spinner, TitleLink, TypeBadge } from '../ui/components';

export function useSearch(query: string, language: string, country: string) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); setError(undefined); return; }
    const id = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true); setError(undefined);
      try {
        const r = await searchTitles(q, language);
        if (id !== seq.current) return;
        setHits(r);
        refreshAvailability(r.slice(0, 10).map((h) => h.key), country, 10).catch(() => undefined);
      } catch (e) { if (id === seq.current) { setError(friendlyError(e)); setHits([]); } } finally { if (id === seq.current) setBusy(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [query, language, country]);
  return { hits, busy, error };
}

export function SearchResults({ hits, country, profileId }: { hits: SearchHit[]; country: string; profileId: string }) {
  const snaps = useLiveQuery(() => db.availability.bulkGet(hits.map((h) => `${h.key}|${country}`)), [hits, country]);
  const ratings = useLiveQuery(() => db.ratings.bulkGet(hits.map((h) => `${profileId}|${h.key}`)), [hits, profileId]);
  return (
    <ul className="space-y-2" aria-label="Resultados">
      {hits.map((h, i) => (
        <li key={h.key} data-testid="search-result">
          <TitleLink k={h.key} className="flex gap-3 rounded-2xl bg-ink-900 p-2.5 ring-1 ring-white/5">
            <Poster path={h.posterPath} title={h.title} className="h-24 w-16 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold leading-tight">{h.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                <TypeBadge type={h.type} /><span>{h.year ?? 'año s/d'}</span>
                {h.originalTitle && h.originalTitle !== h.title && <span className="truncate italic">«{h.originalTitle}»</span>}
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-500">{h.genres.map((g) => g.name).join(' · ') || 'Géneros sin datos'}</div>
              <div className="mt-1"><AvailabilityLine snap={snaps?.[i]} compact /></div>
              {ratings?.[i] && <div className="mt-1 text-xs font-semibold text-accent">{STATUS_LABELS[ratings[i]!.status]}{ratings[i]!.overall ? ` · ${ratings[i]!.overall}/10` : ''}</div>}
            </div>
          </TitleLink>
        </li>
      ))}
    </ul>
  );
}

export default function Search() {
  const { settings, profileId } = useApp();
  const [q, setQ] = useState('');
  const { hits, busy, error } = useSearch(q, settings.language, settings.country);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Buscar</h1>
      <input autoFocus type="search" data-testid="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Película o serie…" aria-label="Buscar película o serie"
        className="w-full rounded-xl bg-ink-800 px-4 py-3 text-base ring-1 ring-white/10 focus:outline-none focus:ring-accent" />
      {busy && <Spinner label="Buscando…" />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {!busy && !error && q.trim().length >= 2 && hits.length === 0 && <Empty>Sin resultados para «{q}».</Empty>}
      <SearchResults hits={hits} country={settings.country} profileId={profileId} />
    </div>
  );
}
