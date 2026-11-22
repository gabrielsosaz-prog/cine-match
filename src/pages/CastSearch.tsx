import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { oneOf, usePersistentState } from '../hooks/usePersistentState';
import { useRatings } from '../hooks/useRatings';
import { useScrollRestore } from '../hooks/useScrollRestore';
import { friendlyError } from '../providers/errors';
import { genreNames } from '../services/catalog';
import { DEFAULT_FILTERS, type CountryField, type PersonRef, type RankFilters } from '../services/filters';
import { latestRun, rankWithFilters, type FilteredResult } from '../services/recommendations';
import type { MediaType, RecommendationRun, TitleKey } from '../types';
import { AvailabilityLine, Empty, ErrorNote, personalState, Poster, publicScore, ScorePair, Spinner, TitleLink, TypeBadge } from '../ui/components';
import { CountryPicker, PeoplePicker } from '../ui/FilterPanel';

type CastSort = 'affinity' | 'public' | 'year' | 'title';
const PAGE = 15;
interface CastState { include: PersonRef[]; exclude: PersonRef[]; mode: 'any' | 'all'; type: '' | MediaType; genre: number; incC: string[]; excC: string[]; field: CountryField; onlyMine: boolean }
const EMPTY: CastState = { include: [], exclude: [], mode: 'all', type: '', genre: 0, incC: [], excC: [], field: 'both', onlyMine: false };
const isState = (v: unknown): v is CastState => typeof v === 'object' && v !== null && Array.isArray((v as CastState).include);

/**
 * Buscar por reparto (v3.2): 1 a 5 personas elegidas de los resultados reales de TMDB (id único).
 * «Todos» = títulos donde todas tienen créditos de actuación; «Cualquiera» = al menos una. Se pueden excluir personas
 * (la exclusión manda) y combinar con tipo, género, países y plataformas. Los títulos salen de las filmografías
 * completas de TMDB, no del ranking.
 */
export function CastSearch() {
  const { settings, profileId } = useApp();
  const [st, setSt] = usePersistentState<CastState>(`cine-match:cast-search:${profileId}`, EMPTY, isState);
  const [sort, setSort] = usePersistentState<CastSort>(`cine-match:cast-sort:${profileId}`, 'affinity', oneOf(['affinity', 'public', 'year', 'title'] as const));
  const [res, setRes] = useState<FilteredResult & { sig: string }>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [genres, setGenres] = useState<Map<number, string>>(new Map());
  const [ready, setReady] = useState(false);
  const { page, setPage } = useScrollRestore('cast-search', ready);
  const rs = useRatings(profileId);
  const seq = useRef(0);
  const first = useRef(true);
  useEffect(() => { genreNames(settings.language).then(setGenres).catch(() => undefined); }, [settings.language]);
  const sig = JSON.stringify(st);

  useEffect(() => {
    if (!st.include.length) { setRes(undefined); return; }
    const my = ++seq.current;
    setBusy(true); setErr(undefined);
    if (!first.current) setPage(1);
    first.current = false;
    (async () => {
      const run: RecommendationRun = (await latestRun(profileId)) ?? { profileId, algorithmVersion: '', createdAt: 0, trigger: '', ratingsCount: 0, country: settings.country, items: [], pool: [] };
      const f: RankFilters = {
        ...DEFAULT_FILTERS, watched: 'all', includePeople: st.include, excludePeople: st.exclude, peopleMode: st.mode,
        types: st.type ? [st.type] : [], includeGenres: st.genre ? [st.genre] : [], includeCountries: st.incC, excludeCountries: st.excC, countryField: st.field,
      };
      return rankWithFilters(profileId, run, f, { discover: false, anyPlatform: !st.onlyMine });
    })().then((r) => { if (my === seq.current) setRes({ ...r, sig }); })
      .catch((e) => { if (my === seq.current) setErr(friendlyError(e)); })
      .finally(() => { if (my === seq.current) setBusy(false); });
  }, [sig]);

  const keys = res?.items.map((i) => i.key) ?? [];
  const metas = useLiveQuery(() => db.titles.bulkGet(keys), [keys.join(',')]);
  const snaps = useLiveQuery(() => db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`)), [keys.join(','), settings.country]);
  const rows = useMemo(() => {
    const list = (res?.items ?? []).map((item, i) => ({ item, meta: metas?.[i], snap: snaps?.[i] })).filter((x) => x.meta);
    const v = (x: (typeof list)[number]): number | string | undefined => sort === 'affinity' ? (personalState(x.item).kind === 'insufficient' ? undefined : x.item.score)
      : sort === 'public' ? publicScore(x.meta) : sort === 'year' ? x.meta!.year : x.meta!.title;
    return [...list].sort((a, b) => {
      const x = v(a), y = v(b);
      if (x === undefined && y === undefined) return (b.meta!.voteCount ?? 0) - (a.meta!.voteCount ?? 0);
      if (x === undefined) return 1; if (y === undefined) return -1;
      const c = typeof x === 'string' ? x.localeCompare(y as string, 'es') : (y as number) - x;
      return c || (b.meta!.voteCount ?? 0) - (a.meta!.voteCount ?? 0);
    });
  }, [res, metas, snaps, sort]);
  useEffect(() => { if (rows.length) setReady(true); }, [rows.length]);
  const current = !busy && res?.sig === sig;
  const names = st.include.map((p) => p.name);

  return (
    <div className="space-y-3" data-testid="cast-search">
      <PeoplePicker title="Reparto (de 1 a 5 personas)" include={st.include} exclude={st.exclude} mode={st.mode} language={settings.language}
        onChange={(include, exclude, mode) => setSt({ ...st, include, exclude, mode })} />
      {st.include.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select aria-label="Tipo" value={st.type} onChange={(e) => setSt({ ...st, type: e.target.value as CastState['type'] })} data-testid="cast-type" className="rounded-lg bg-ink-800 p-1.5 ring-1 ring-white/10">
            <option value="">Películas y series</option><option value="movie">Películas</option><option value="tv">Series</option>
          </select>
          <select aria-label="Género" value={st.genre} onChange={(e) => setSt({ ...st, genre: Number(e.target.value) })} data-testid="cast-genre" className="max-w-[45vw] rounded-lg bg-ink-800 p-1.5 ring-1 ring-white/10">
            <option value={0}>Todos los géneros</option>{[...genres].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
          <select aria-label="Ordenar" value={sort} onChange={(e) => setSort(e.target.value as CastSort)} data-testid="cast-sort" className="rounded-lg bg-ink-800 p-1.5 ring-1 ring-white/10">
            <option value="affinity">Para vos</option><option value="public">Puntuación TMDB</option><option value="year">Año</option><option value="title">Título</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" checked={st.onlyMine} onChange={(e) => setSt({ ...st, onlyMine: e.target.checked })} data-testid="cast-only-mine" />Sólo en mis plataformas</label>
        </div>
      )}
      {st.include.length > 0 && <CountryPicker include={st.incC} exclude={st.excC} field={st.field} onChange={(incC, excC, field) => setSt({ ...st, incC, excC, field })} />}
      {st.include.length === 0 && <p className="text-xs text-slate-400">Elegí al menos una persona. Con dos o más, «Todos» busca obras donde actúen todas a la vez.</p>}
      {busy && <Spinner label="Buscando en las filmografías de TMDB…" />}
      {err && <ErrorNote>{err}</ErrorNote>}
      {res?.warning && <ErrorNote>{res.warning}</ErrorNote>}
      {current && res && (
        <p className="text-[11px] text-slate-500" data-testid="cast-summary">
          {res.peopleTotal ?? 0} {res.peopleTotal === 1 ? 'título' : 'títulos'} {st.mode === 'all' && names.length > 1 ? `con ${names.join(' y ')} a la vez` : `con ${names.join(' o ')}`}
          {st.exclude.length ? `, sin ${st.exclude.map((p) => p.name).join(' ni ')}` : ''} · {rows.length} con los demás filtros
          {res.outsidePlatforms ? ` · ${res.outsidePlatforms} fuera de tus plataformas` : ''}.
        </p>
      )}
      {current && res && rows.length === 0 && (
        <Empty><span data-testid="cast-empty">{(res.peopleTotal ?? 0) === 0
          ? (st.mode === 'all' && names.length > 1 ? `TMDB no registra películas ni series donde actúen ${names.join(' y ')} a la vez.` : 'Las personas elegidas no tienen créditos de actuación que cumplan la selección.')
          : 'Hay títulos con este reparto, pero ninguno cumple los demás filtros.'}</span></Empty>
      )}
      {current && (
        <ul className="space-y-2">
          {rows.slice(0, page * PAGE).map(({ item, meta, snap }) => (
            <li key={item.key} data-key={item.key} data-testid="cast-result" className="rounded-2xl bg-ink-900 p-2.5 ring-1 ring-white/5">
              <TitleLink k={item.key} className="flex gap-3">
                <Poster path={meta!.posterPath} title={meta!.title} className="h-24 w-16 shrink-0" />
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold leading-tight">{meta!.title}</h3>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400"><TypeBadge type={meta!.type} /><span>{meta!.year ?? 'año s/d'}</span></div>
                  <div className="mt-1"><ScorePair item={item} meta={meta} userScore={rs.byKey.get(item.key as TitleKey)?.overall} compact /></div>
                  <div className="mt-1"><AvailabilityLine snap={snap} compact /></div>
                </div>
              </TitleLink>
            </li>
          ))}
        </ul>
      )}
      {current && rows.length > page * PAGE && <button type="button" data-testid="cast-more" onClick={() => setPage(page + 1)} className="w-full rounded-xl bg-ink-800 py-2.5 text-sm font-semibold ring-1 ring-white/10">Ver más ({rows.length - page * PAGE} restantes)</button>}
    </div>
  );
}
