import ShareAction from '../ui/ShareAction';
import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LIST_LABELS } from '../constants';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { useRatings } from '../hooks/useRatings';
import { friendlyError } from '../providers/errors';
import { Link } from 'react-router-dom';
import { refreshAvailability, searchAll, searchTitles, type PersonHit, type SearchHit, type UnifiedSearch } from '../services/catalog';
import { IMG } from '../providers/tmdb';
import { useScrollRestore } from '../hooks/useScrollRestore';
import { departmentLabel } from './Person';
import { CastSearch } from './CastSearch';
import { oneOf, usePersistentState } from '../hooks/usePersistentState';
import type { RankedPerson } from '../services/peopleSearch';
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
  const { byKey } = useRatings(profileId);
  const ratings = hits.map((h) => byKey.get(h.key));
  return (
    <ul className="space-y-2" aria-label="Resultados">
      {hits.map((h, i) => (
        <li key={h.key} data-testid="search-result" data-key={h.key} className="relative">
          {/* v4.2: Compartir sin entrar a la ficha */}
          <div className="absolute bottom-2.5 right-2.5 z-10"><ShareAction variant="icon" target={{ k: h.key, title: h.title, year: h.year, posterPath: h.posterPath }} /></div>
          <TitleLink k={h.key} className="flex gap-3 rounded-2xl bg-ink-900 p-2.5 pr-14 ring-1 ring-white/5">
            <Poster path={h.posterPath} title={h.title} className="h-24 w-16 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold leading-tight">{h.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                <TypeBadge type={h.type} /><span>{h.year ?? 'año s/d'}</span>
                {h.originalTitle && h.originalTitle !== h.title && <span className="truncate italic">«{h.originalTitle}»</span>}
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-500">{h.genres.map((g) => g.name).join(' · ') || 'Géneros sin datos'}</div>
              <div className="mt-1"><AvailabilityLine snap={snaps?.[i]} compact /></div>
              {ratings?.[i] && <div className="mt-1 text-xs font-semibold text-accent">{[ratings[i]!.watched ? 'Vista' : 'No vista', ratings[i]!.list ? LIST_LABELS[ratings[i]!.list!] : '', ratings[i]!.overall !== undefined ? `${ratings[i]!.overall}/10` : ''].filter(Boolean).join(' · ')}</div>}
            </div>
          </TitleLink>
        </li>
      ))}
    </ul>
  );
}

function usePersonResults(query: string, language: string) {
  const [res, setRes] = useState<UnifiedSearch & { q: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setRes(undefined); setError(undefined); return; }
    const id = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true); setError(undefined);
      try { const r = await searchAll(q, language); if (id === seq.current) setRes({ ...r, q }); }
      catch (e) { if (id === seq.current) { setError(friendlyError(e)); setRes(undefined); } }
      finally { if (id === seq.current) setBusy(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [query, language]);
  return { res, busy, error };
}

export function PeopleResults({ people }: { people: (PersonHit & Partial<RankedPerson>)[] }) {
  return (
    <section aria-label="Personas" className="space-y-2" data-testid="people-section">
      <h2 className="text-sm font-semibold text-slate-300">Personas</h2>
      <ul className="space-y-2">
        {people.slice(0, 6).map((p) => (
          <li key={p.id} data-key={`person:${p.id}`}>
            <Link to={`/persona/${p.id}`} data-testid="person-result" data-person-id={p.id} className="flex items-center gap-3 rounded-2xl bg-ink-900 p-2.5 ring-1 ring-white/5">
              {p.profilePath ? <img src={`${IMG}w92${p.profilePath}`} alt={`Foto de ${p.name}`} loading="lazy" className="h-16 w-12 shrink-0 rounded-lg object-cover" />
                : <span className="flex h-16 w-12 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-xl text-slate-500" aria-hidden>👤</span>}
              <span className="min-w-0 flex-1">
                <span className="block font-semibold leading-tight">{p.name}{p.fuzzy && <span className="ml-1 text-[10px] font-normal text-amber-300" data-testid="person-fuzzy">¿quisiste decir?</span>}</span>
                <span className="block text-xs text-slate-400">{departmentLabel(p.department)}</span>
                {p.knownFor.length > 0 && <span className="block truncate text-[11px] text-slate-500">{p.knownFor.join(' · ')}</span>}
              </span>
              <span className="text-xs text-accent">Filmografía ›</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Buscar (v3.1): búsqueda unificada de películas, series y personas (actuación, dirección, guion). Los resultados de
 * personas se muestran en una sección propia; van primero sólo si TMDB los considera lo más relevante. La búsqueda
 * se conserva al abrir una ficha y volver.
 */
export default function Search() {
  const { profileId } = useApp();
  const [mode, setMode] = usePersistentState<'all' | 'cast'>(`cine-match:search-mode:${profileId}`, 'all', oneOf(['all', 'cast'] as const));
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Buscar</h1>
      <div className="flex gap-1.5" role="tablist" aria-label="Tipo de búsqueda">
        {([['all', 'Títulos y personas'], ['cast', 'Buscar por reparto']] as const).map(([m, l]) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} data-testid={`search-mode-${m}`} onClick={() => setMode(m)}
            className={`rounded-full px-3 py-1.5 text-sm ${mode === m ? 'bg-accent text-ink-950 font-semibold' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>{l}</button>
        ))}
      </div>
      {mode === 'cast' ? <CastSearch /> : <UnifiedSearchView />}
    </div>
  );
}

function UnifiedSearchView() {
  const { settings, profileId } = useApp();
  const [q, setQRaw] = useState(() => { try { return sessionStorage.getItem('cine-match:search-q') ?? ''; } catch { return ''; } });
  const setQ = (v: string) => { setQRaw(v); try { sessionStorage.setItem('cine-match:search-q', v); } catch { /* */ } };
  const { res, busy, error } = usePersonResults(q, settings.language);
  const hits = res?.titles ?? [];
  const people = res?.people ?? [];
  const [ready, setReady] = useState(false);
  useScrollRestore('search', ready);
  useEffect(() => { if (res) setReady(true); }, [res]);
  useEffect(() => { if (hits.length) refreshAvailability(hits.slice(0, 10).map((h) => h.key), settings.country, 10).catch(() => undefined); }, [res]);
  const titlesBlock = hits.length > 0 && (
    <section aria-label="Películas y series" className="space-y-2" data-testid="titles-section">
      {people.length > 0 && <h2 className="text-sm font-semibold text-slate-300">Películas y series</h2>}
      <SearchResults hits={hits} country={settings.country} profileId={profileId} />
    </section>
  );
  const peopleBlock = people.length > 0 && <PeopleResults people={people} />;
  return (
    <div className="space-y-3" data-testid="search-view" data-results-for={busy ? '' : res?.q ?? ''}>
      <input autoFocus={!q} type="search" data-testid="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Película, serie, actor o director…" aria-label="Buscar película, serie o persona"
        className="w-full rounded-xl bg-ink-800 px-4 py-3 text-base ring-1 ring-white/10 focus:outline-none focus:ring-accent" />
      {busy && <Spinner label="Buscando…" />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {!busy && !error && res && q.trim().length >= 2 && hits.length === 0 && people.length === 0 && <Empty>Sin resultados para «{q}».</Empty>}
      {res && res.usedQuery !== q.trim().replace(/\s+/g, ' ') && (hits.length > 0 || people.length > 0) && <p className="text-[11px] text-slate-500" data-testid="search-variant">Mostrando resultados para «{res.usedQuery}».</p>}
      {res?.correctedPerson && people.some((p) => p.fuzzy) && <p className="text-[11px] text-amber-200" data-testid="search-corrected">No hay personas con «{q.trim()}» exacto en TMDB; ¿quisiste decir {res.correctedPerson}?</p>}
      {res?.peopleFirst ? <>{peopleBlock}{titlesBlock}</> : <>{titlesBlock}{peopleBlock}</>}
    </div>
  );
}
