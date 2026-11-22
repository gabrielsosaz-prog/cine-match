import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useParams } from 'react-router-dom';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { oneOf, usePersistentState } from '../hooks/usePersistentState';
import { useRatings } from '../hooks/useRatings';
import { useScrollRestore } from '../hooks/useScrollRestore';
import { friendlyError } from '../providers/errors';
import { IMG } from '../providers/tmdb';
import { matchesPlatforms } from '../services/availability';
import { genreNames, getPerson, personFilmography, refreshAvailability, type PersonCredit, type PersonInfo } from '../services/catalog';
import { predictFor } from '../services/recommendations';
import type { MediaType, RecommendationItem, TitleKey } from '../types';
import { AvailabilityLine, Empty, ErrorNote, Poster, publicScore, ScorePair, Spinner, TitleLink, TypeBadge } from '../ui/components';

type Role = 'any' | 'cast' | 'crew';
type PSort = 'affinity' | 'public' | 'year';
const PAGE = 15;
const DEPT: Record<string, string> = { Acting: 'Actuación', Directing: 'Dirección', Writing: 'Guion', Production: 'Producción', Sound: 'Sonido', Camera: 'Fotografía', Editing: 'Montaje', Art: 'Arte', 'Costume & Make-Up': 'Vestuario y maquillaje', Crew: 'Equipo técnico', 'Visual Effects': 'Efectos visuales', Lighting: 'Iluminación', Creator: 'Creación' };
export const departmentLabel = (d?: string) => (d ? DEPT[d] ?? d : 'Sin datos');

/**
 * Ficha de persona (v3.1): nombre, foto, profesión y filmografía completa de TMDB (por id único, sin confundir
 * homónimos), con disponibilidad en tus plataformas, filtros por año, género y tipo, y orden por afinidad o nota pública.
 */
export default function Person() {
  const { id } = useParams();
  const personId = Number(id);
  const { settings, profileId } = useApp();
  const [info, setInfo] = useState<PersonInfo>();
  const [credits, setCredits] = useState<PersonCredit[]>();
  const [err, setErr] = useState<string>();
  const [role, setRole] = usePersistentState<Role>(`cine-match:person-role:${profileId}`, 'any', oneOf(['any', 'cast', 'crew'] as const));
  const [sort, setSort] = usePersistentState<PSort>(`cine-match:person-sort:${profileId}`, 'affinity', oneOf(['affinity', 'public', 'year'] as const));
  const [type, setType] = useState<'' | MediaType>('');
  const [genre, setGenre] = useState<number>(0);
  const [yearMin, setYearMin] = useState('');
  const [onlyMine, setOnlyMine] = usePersistentState<boolean>(`cine-match:person-mine:${profileId}`, false, (v): v is boolean => typeof v === 'boolean');
  const [preds, setPreds] = useState<Map<TitleKey, RecommendationItem>>(new Map());
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [ready, setReady] = useState(false);
  const { page, setPage } = useScrollRestore(`person-${personId}`, ready);
  const rs = useRatings(profileId);

  useEffect(() => {
    let alive = true;
    setErr(undefined);
    Promise.all([getPerson(personId, settings.language), personFilmography(personId, settings.language, { role: 'any', fiction: true }), genreNames(settings.language)])
      .then(async ([p, c, g]) => {
        if (!alive) return;
        setInfo(p); setCredits(c); setNames(g);
        const keys = [...new Set(c.map((x) => x.key))];
        predictFor(profileId, keys).then((m) => alive && setPreds(m)).catch(() => undefined);
        refreshAvailability(keys.slice(0, 60), settings.country, 60).catch(() => undefined);
      })
      .catch((e) => alive && setErr(friendlyError(e)));
    return () => { alive = false; };
  }, [personId, settings.language]);

  const uniq = useMemo(() => {
    const m = new Map<TitleKey, PersonCredit & { roles: string[] }>();
    for (const c of credits ?? []) {
      if (role !== 'any' && c.kind !== role) continue;
      const r = c.kind === 'cast' ? (c.character ? `como ${c.character}` : 'actuación') : (c.job ?? 'equipo');
      const e = m.get(c.key);
      if (e) { if (!e.roles.includes(r)) e.roles.push(r); } else m.set(c.key, { ...c, roles: [r] });
    }
    return [...m.values()];
  }, [credits, role]);
  const keys = uniq.map((c) => c.key);
  const snaps = useLiveQuery(() => db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`)), [keys.join(','), settings.country]);
  const metas = useLiveQuery(() => db.titles.bulkGet(keys), [keys.join(',')]);
  const rows = useMemo(() => {
    const list = uniq.map((c, i) => ({ c, snap: snaps?.[i], meta: metas?.[i] })).filter(({ c, snap }) =>
      (!type || c.type === type) && (!genre || c.genreIds.includes(genre)) && (!yearMin || (c.year ?? 0) >= Number(yearMin)) && (!onlyMine || matchesPlatforms(snap, settings.platforms, settings.includeUnconfirmed)));
    const v = (x: (typeof list)[number]) => (sort === 'affinity' ? preds.get(x.c.key)?.score : sort === 'public' ? publicScore(x.c) : x.c.year);
    return list.sort((a, b) => {
      const x = v(a), y = v(b);
      if (x === undefined && y === undefined) return (b.c.voteCount ?? 0) - (a.c.voteCount ?? 0);
      if (x === undefined) return 1; if (y === undefined) return -1;
      return y - x || (b.c.voteCount ?? 0) - (a.c.voteCount ?? 0);
    });
  }, [uniq, snaps, metas, type, genre, yearMin, onlyMine, sort, preds]);
  useEffect(() => { if (rows.length) setReady(true); }, [rows.length]);
  const genres = useMemo(() => [...new Set(uniq.flatMap((c) => c.genreIds))].map((g) => ({ id: g, name: names.get(g) ?? `Género ${g}` })).sort((a, b) => a.name.localeCompare(b.name, 'es')), [uniq, names]);
  const available = uniq.filter((_, i) => matchesPlatforms(snaps?.[i], settings.platforms, settings.includeUnconfirmed)).length;

  if (err) return <ErrorNote>{err}</ErrorNote>;
  if (!info || !credits) return <Spinner label="Cargando filmografía…" />;
  return (
    <div className="space-y-3">
      <header className="flex items-center gap-3" data-testid="person-header">
        {info.profilePath ? <img src={`${IMG}w185${info.profilePath}`} alt={`Foto de ${info.name}`} className="h-24 w-16 shrink-0 rounded-lg object-cover" loading="lazy" />
          : <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-2xl text-slate-500" aria-hidden>👤</div>}
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight" data-testid="person-name">{info.name}</h1>
          <p className="text-xs text-slate-400">{departmentLabel(info.department)}{info.placeOfBirth ? ` · ${info.placeOfBirth}` : ''}</p>
          <p className="text-[11px] text-slate-500" data-testid="person-counts">{uniq.length} títulos en TMDB · {available} en tus plataformas (verificados hasta ahora)</p>
        </div>
      </header>
      <div className="flex flex-wrap gap-2 text-sm">
        <select aria-label="Rol" value={role} onChange={(e) => { setRole(e.target.value as Role); setPage(1); }} data-testid="person-role" className="rounded-lg bg-ink-800 p-1.5 ring-1 ring-white/10">
          <option value="any">Todos los roles</option><option value="cast">Actuación</option><option value="crew">Dirección, guion y equipo</option>
        </select>
        <select aria-label="Tipo" value={type} onChange={(e) => { setType(e.target.value as '' | MediaType); setPage(1); }} data-testid="person-type" className="rounded-lg bg-ink-800 p-1.5 ring-1 ring-white/10">
          <option value="">Películas y series</option><option value="movie">Películas</option><option value="tv">Series</option>
        </select>
        <select aria-label="Género" value={genre} onChange={(e) => { setGenre(Number(e.target.value)); setPage(1); }} data-testid="person-genre" className="rounded-lg bg-ink-800 p-1.5 ring-1 ring-white/10">
          <option value={0}>Todos los géneros</option>{genres.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <input inputMode="numeric" placeholder="Desde (año)" aria-label="Desde el año" value={yearMin} maxLength={4} onChange={(e) => { setYearMin(e.target.value.replace(/\D/g, '')); setPage(1); }} data-testid="person-year" className="w-28 rounded-lg bg-ink-800 p-1.5 ring-1 ring-white/10" />
        <select aria-label="Ordenar" value={sort} onChange={(e) => setSort(e.target.value as PSort)} data-testid="person-sort" className="rounded-lg bg-ink-800 p-1.5 ring-1 ring-white/10">
          <option value="affinity">Para vos</option><option value="public">Público (TMDB)</option><option value="year">Más recientes</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" checked={onlyMine} onChange={(e) => { setOnlyMine(e.target.checked); setPage(1); }} data-testid="person-only-mine" />Sólo en mis plataformas</label>
      </div>
      {rows.length === 0 && <Empty>No hay títulos con estos filtros.</Empty>}
      <ul className="space-y-2">
        {rows.slice(0, page * PAGE).map(({ c, snap, meta }) => (
          <li key={c.key} data-key={c.key} data-testid="person-credit" className="rounded-2xl bg-ink-900 p-2.5 ring-1 ring-white/5">
            <TitleLink k={c.key} className="flex gap-3">
              <Poster path={c.posterPath} title={c.title} className="h-24 w-16 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold leading-tight">{c.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400"><TypeBadge type={c.type} /><span>{c.year ?? 'año s/d'}</span><span className="truncate">{c.roles.slice(0, 2).join(' · ')}</span></div>
                <div className="mt-1"><ScorePair item={preds.get(c.key)} meta={meta ?? c} userScore={rs.byKey.get(c.key)?.overall} compact /></div>
                <div className="mt-1"><AvailabilityLine snap={snap} compact /></div>
              </div>
            </TitleLink>
          </li>
        ))}
      </ul>
      {rows.length > page * PAGE && <button type="button" data-testid="person-more" onClick={() => setPage(page + 1)} className="w-full rounded-xl bg-ink-800 py-2.5 text-sm font-semibold ring-1 ring-white/10">Ver más ({rows.length - page * PAGE} restantes)</button>}
      <p className="text-center text-[10px] text-slate-500">Filmografía de TMDB (sin apariciones como sí mismo ni programas de entrevistas). La disponibilidad se verifica por título.</p>
    </div>
  );
}
