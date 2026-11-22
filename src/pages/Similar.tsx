import { useEffect, useMemo, useRef, useState } from 'react';
import { useScrollRestore } from '../hooks/useScrollRestore';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSearchParams } from 'react-router-dom';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { usePersistentState, oneOf } from '../hooks/usePersistentState';
import { useRatings } from '../hooks/useRatings';
import { friendlyError } from '../providers/errors';
import { DEFAULT_FILTERS, type RankFilters } from '../services/filters';
import { safely } from '../services/notices';
import { setNotInterested, setWatched } from '../services/ratings';
import { explainSimilar, findSimilar, MAX_REFS, type RefWeight, type SimilarMode, type SimilarResponse, type SimilarResult } from '../services/similar';
import type { Named, TitleKey, TitleMeta } from '../types';
import { AvailabilityLine, ChannelBars, Empty, ErrorNote, Poster, publicScore, ScorePair, Spinner, TitleLink, TypeBadge } from '../ui/components';
import FilterPanel from '../ui/FilterPanel';
import { TrailerButton } from '../ui/Trailer';
import { num } from '../ui/format';
import { useSearch } from './Search';

type SimSort = 'combined' | 'similarity' | 'affinity' | 'public' | 'year' | 'title';
/** «Relevancia» aplica variedad (sagas y redundancia); los demás órdenes son estrictos por el valor elegido. */
const SORTS: [SimSort, string][] = [['combined', 'Relevancia (con variedad)'], ['similarity', 'Similitud (estricto)'], ['affinity', 'Para vos'], ['public', 'Público (TMDB)'], ['year', 'Año'], ['title', 'Título']];
const WEIGHTS: [RefWeight, string][] = [[0.5, 'Menos'], [1, 'Normal'], [2, 'Más']];
const PAGE = 10;

/**
 * «Similares»: elegí de 1 a 5 títulos de referencia y obtené otros parecidos, con similitud y afinidad separadas,
 * explicación de la coincidencia, disponibilidad, acciones rápidas y los mismos filtros avanzados.
 */
export default function Similar() {
  const { profileId, settings } = useApp();
  const [params, setParams] = useSearchParams();
  const [refs, setRefs] = usePersistentState<TitleKey[]>(`cine-match:similar-refs:${profileId}`, [], (v): v is TitleKey[] => Array.isArray(v) && v.every((x) => typeof x === 'string'));
  const [filters, setFilters] = usePersistentState<RankFilters>(`cine-match:similar-filters:${profileId}`, { ...DEFAULT_FILTERS, watched: 'unwatched' });
  const [sort, setSort] = usePersistentState<SimSort>(`cine-match:similar-sort:${profileId}`, 'combined', oneOf(SORTS.map(([v]) => v)));
  const [mode, setMode] = usePersistentState<SimilarMode>(`cine-match:similar-mode:${profileId}`, 'common', oneOf(['common', 'combine'] as const));
  const [weights, setWeights] = usePersistentState<Record<string, RefWeight>>(`cine-match:similar-weights:${profileId}`, {}, (v): v is Record<string, RefWeight> => typeof v === 'object' && v !== null && !Array.isArray(v));
  const [onlyMine, setOnlyMine] = usePersistentState<boolean>(`cine-match:similar-mine:${profileId}`, true, (v): v is boolean => typeof v === 'boolean');
  const [q, setQ] = useState('');
  const { hits, busy: searching, error: searchError } = useSearch(q, settings.language, settings.country);
  const [resp, setResp] = useState<SimilarResponse>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [listReady, setListReady] = useState(false);
  const { page, setPage } = useScrollRestore('similar', listReady);
  const rs = useRatings(profileId);

  // Referencia recibida desde la ficha de un título
  useEffect(() => {
    const r = params.get('ref') as TitleKey | null;
    if (r && !refs.includes(r)) setRefs([...refs, r].slice(-MAX_REFS));
    if (r) { params.delete('ref'); setParams(params, { replace: true }); }
  }, []);
  const refMetas = useLiveQuery(() => db.titles.bulkGet(refs), [refs.join(',')]) ?? [];
  const title = (k: TitleKey) => refMetas.find((m) => m?.key === k)?.title ?? k;
  const addRef = (k: TitleKey) => { if (!refs.includes(k) && refs.length < MAX_REFS) setRefs([...refs, k]); setQ(''); };

  const first = useRef(true);
  const run = async () => {
    if (!refs.length) return;
    setBusy(true); setErr(undefined);
    if (!first.current) setPage(1);
    first.current = false;
    try { setResp(await findSimilar(profileId, refs, filters, { onlyMyPlatforms: onlyMine, mode, weights: weights as any })); }
    catch (e) { setErr(friendlyError(e)); }
    finally { setBusy(false); }
  };
  // Recalcular al cambiar referencias, filtros o el alcance de plataformas
  useEffect(() => { if (refs.length) run(); else setResp(undefined); }, [refs.join(','), JSON.stringify(filters), onlyMine, mode, JSON.stringify(weights)]);

  const keys = resp?.results.map((r) => r.key) ?? [];
  const metas = useLiveQuery(() => db.titles.bulkGet(keys), [keys.join(',')]);
  const snaps = useLiveQuery(() => db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`)), [keys.join(','), settings.country]);
  const rows = useMemo(() => {
    const list = (resp?.results ?? []).map((r, i) => ({ r, meta: metas?.[i], snap: snaps?.[i] })).filter((x) => x.meta) as { r: SimilarResult; meta: TitleMeta; snap: any }[];
    const v = (x: (typeof list)[number]): number | string | undefined => sort === 'combined' ? x.r.order : sort === 'similarity' ? x.r.similarity : sort === 'affinity' ? x.r.affinity?.score
      : sort === 'public' ? publicScore(x.meta) : sort === 'year' ? x.meta.year : x.meta.title;
    return [...list].sort((a, b) => {
      const x = v(a), y = v(b);
      if (x === undefined && y === undefined) return b.r.order - a.r.order;
      if (x === undefined) return 1; if (y === undefined) return -1;
      const c = typeof x === 'string' ? x.localeCompare(y as string, 'es') : (y as number) - x;
      return c || b.r.order - a.r.order;
    });
  }, [resp, metas, snaps, sort]);
  useEffect(() => { if (rows.length) setListReady(true); }, [rows.length]);
  const genres = useMemo(() => {
    const m = new Map<number, Named>();
    for (const t of metas ?? []) for (const g of t?.genres ?? []) if (!/^Género \d+$/.test(g.name)) m.set(g.id, g);
    return [...m.values()];
  }, [metas]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold">Similares</h1>
        <p className="text-xs text-slate-400">Elegí de 1 a {MAX_REFS} títulos de referencia y encontrá otros parecidos.</p>
      </header>
      <section className="space-y-2" aria-label="Títulos de referencia">
        <div className="flex flex-wrap gap-1.5" data-testid="similar-refs">
          {refs.map((k) => (
            <span key={k} className="flex items-center gap-1 rounded-full bg-accent/15 py-1 pl-2.5 pr-1 text-xs text-accent" data-testid="similar-ref">
              {title(k)}
              {refs.length > 1 && (
                <select aria-label={`Importancia de ${title(k)}`} data-testid="similar-ref-weight" value={weights[k] ?? 1} onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) as RefWeight })}
                  className="rounded-full bg-ink-900/70 px-1 py-0.5 text-[10px] text-slate-200">
                  {WEIGHTS.map(([w, l]) => <option key={w} value={w}>{l}</option>)}
                </select>
              )}
              <button type="button" aria-label={`Quitar ${title(k)}`} onClick={() => setRefs(refs.filter((x) => x !== k))} className="ml-0.5 px-1">✕</button>
            </span>
          ))}
          {!refs.length && <span className="text-xs text-slate-500">Todavía no elegiste referencias.</span>}
        </div>
        {refs.length < MAX_REFS ? (
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={refs.length ? 'Agregar otra referencia…' : 'Buscá un título de referencia…'} data-testid="similar-search"
            className="w-full rounded-xl bg-ink-800 px-4 py-3 text-base ring-1 ring-white/10" aria-label="Buscar título de referencia" />
        ) : <p className="text-[11px] text-slate-500">Máximo {MAX_REFS} referencias.</p>}
        {searching && <Spinner label="Buscando…" />}
        {searchError && <ErrorNote>{searchError}</ErrorNote>}
        {q.trim().length >= 2 && hits.length > 0 && (
          <ul className="max-h-72 space-y-1 overflow-y-auto rounded-xl bg-ink-900 p-1 ring-1 ring-white/10">
            {hits.slice(0, 8).map((h) => (
              <li key={h.key}>
                <button type="button" data-testid="similar-hit" onClick={() => addRef(h.key)} disabled={refs.includes(h.key)} className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left disabled:opacity-40">
                  <Poster path={h.posterPath} title={h.title} className="h-12 w-8 shrink-0" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm">{h.title}</span><span className="text-[11px] text-slate-400">{h.type === 'tv' ? 'Serie' : 'Película'} · {h.year ?? 's/d'}</span></span>
                  <span className="text-xs text-accent">＋</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {refs.length > 1 && (
        <div className="space-y-1">
          <div className="flex rounded-xl bg-ink-800 p-1 ring-1 ring-white/10" role="radiogroup" aria-label="Modo de búsqueda">
            {([['common', 'En común'], ['combine', 'Combinar']] as const).map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={mode === v} data-testid={`similar-mode-${v}`} onClick={() => setMode(v)}
                className={`flex-1 rounded-lg py-1.5 text-sm font-semibold ${mode === v ? 'bg-accent text-ink-950' : 'text-slate-300'}`}>{l}</button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">{mode === 'common' ? 'En común: títulos que se parecen a todas las referencias y comparten lo que tienen en común.' : 'Combinar: títulos que mezclan rasgos de distintas referencias, aunque no estén en todas.'}</p>
        </div>
      )}
      <FilterPanel value={filters} onChange={(f) => setFilters(f)} genres={genres} userPlatforms={settings.platforms} language={settings.language} />
      <div className="flex rounded-xl bg-ink-800 p-1 ring-1 ring-white/10" role="radiogroup" aria-label="Filtrar por vistos">
        {([['unwatched', 'No vistos'], ['watched', 'Vistos'], ['all', 'Todos']] as const).map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={filters.watched === v} data-testid={`similar-watched-${v}`} onClick={() => setFilters({ ...filters, watched: v })}
            className={`flex-1 rounded-lg py-1.5 text-sm font-semibold ${filters.watched === v ? 'bg-accent text-ink-950' : 'text-slate-300'}`}>{l}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} data-testid="similar-only-mine" />Sólo en mis plataformas</label>
        <select value={sort} onChange={(e) => setSort(e.target.value as SimSort)} data-testid="similar-sort" aria-label="Ordenar" className="ml-auto rounded-lg bg-ink-800 p-1.5 text-sm ring-1 ring-white/10">
          {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      {busy && <Spinner label="Analizando las referencias y comparando con el catálogo narrativo…" />}
      {err && <ErrorNote>{err}</ErrorNote>}
      {resp?.warning && <ErrorNote>{resp.warning}</ErrorNote>}
      {resp && !busy && (
        <div className="space-y-1 rounded-xl bg-ink-900 p-2.5 text-[11px] text-slate-400 ring-1 ring-white/5" data-testid="similar-profile">
          {resp.profile.core.length > 0 && <p data-testid="similar-core">{refs.length > 1 ? 'Lo que comparten las referencias' : 'Lo que buscamos'}: {resp.profile.core.slice(0, 6).map((c) => c.label).join(' · ')}.</p>}
          {refs.length > 1 && resp.profile.core.length === 0 && <p data-testid="similar-core">Las referencias casi no comparten rasgos narrativos documentados{mode === 'common' ? ': probá el modo «Combinar».' : '.'}</p>}
          {resp.profile.distinctive.filter((d) => d.labels.length).map((d) => <p key={d.key} data-testid="similar-distinctive">Propio de {title(d.key)}: {d.labels.join(' · ')}.</p>)}
          {resp.profile.contrasts.slice(0, 3).map((c, i) => <p key={i}>Diferencia entre referencias: {c}.</p>)}
          <p data-testid="similar-semantic">{resp.semantic.available
            ? `Análisis semántico real: vectores del modelo ${resp.semantic.model?.split('/').pop()} sobre sinopsis y argumento (catálogo ${resp.semantic.catalog}, ${resp.semantic.titles} títulos); ${resp.semantic.refsWithVector} de ${refs.length} referencias tienen vector.`
            : 'Sin análisis semántico en esta búsqueda: se comparan rasgos y palabras clave de TMDB.'}</p>
          <p data-testid="similar-personalized">{resp.personalized
            ? `Personalizado con tus ${resp.ratedCount} valoraciones: la similitud se combina con tu afinidad («Para vos»).`
            : `Resultado no del todo personalizado: tenés ${resp.ratedCount} valoraciones (hacen falta al menos 5). El orden se basa sobre todo en la similitud.`}</p>
        </div>
      )}
      {resp && !busy && rows.length === 0 && <Empty><span data-testid="similar-empty">No encontramos títulos parecidos con estos filtros{onlyMine ? ' en tus plataformas' : ''}.</span></Empty>}
      <ul className="space-y-3">
        {rows.slice(0, page * PAGE).map(({ r, meta, snap }) => (
          <SimilarCard key={r.key} r={r} meta={meta} snap={snap} profileId={profileId} userScore={rs.byKey.get(r.key)?.overall} watched={rs.byKey.get(r.key)?.watched ?? false}
            lines={explainSimilar(r, title, refs.length)} refName={title} onAddRef={refs.length < MAX_REFS && !refs.includes(r.key) ? () => addRef(r.key) : undefined} />
        ))}
      </ul>
      {rows.length > page * PAGE && (
        <button type="button" data-testid="similar-more" onClick={() => setPage(page + 1)} className="w-full rounded-xl bg-ink-800 py-2.5 text-sm font-semibold ring-1 ring-white/10">Ver más ({rows.length - page * PAGE} restantes)</button>
      )}
      <p className="text-center text-[10px] text-slate-500">«Similitud» mide el parecido narrativo con las referencias (100 % sólo para el mismo título); la confianza indica cuánta evidencia la respalda. «Para vos» estima cuánto te gustaría y «TMDB» es la nota del público. Son medidas distintas.</p>
    </div>
  );
}

function SimilarCard({ r, meta, snap, profileId, userScore, watched, lines, onAddRef, refName }: {
  r: SimilarResult; meta: TitleMeta; snap: any; profileId: string; userScore?: number; watched: boolean; lines: string[]; onAddRef?: () => void; refName: (k: TitleKey) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-2xl bg-ink-900 p-3 ring-1 ring-white/5" data-testid="similar-item" data-key={r.key}>
      <div className="flex gap-3">
        <TitleLink k={r.key} className="shrink-0"><Poster path={meta.posterPath} title={meta.title} className="h-28 w-[76px]" /></TitleLink>
        <div className="min-w-0 flex-1">
          <TitleLink k={r.key} className="block min-w-0"><h3 className="line-clamp-2 font-semibold leading-tight">{meta.title}</h3></TitleLink>
          <div className="mt-1"><ScorePair item={r.affinity} meta={meta} userScore={userScore} compact /></div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
            <TypeBadge type={meta.type} />{meta.year && <span>{meta.year}</span>}
            <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200" data-testid="similarity">Similitud {r.percent}%</span>
            <span className="text-[10px]" data-testid="similarity-confidence">confianza {r.confidence}</span>
            {r.sameFranchise && <span className="text-[10px] text-amber-200">misma saga</span>}
          </div>
          <div className="mt-1.5"><AvailabilityLine snap={snap} compact /></div>
          <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 text-left text-xs text-slate-300" data-testid="similar-explanation">
            {open ? lines.map((l, i) => <p key={i}>• {l}</p>) : <span className="line-clamp-2">{lines[0]}</span>}
          </button>
          {open && r.perRef.length > 1 && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-slate-400" data-testid="similar-per-ref">
              {r.perRef.map((p) => <li key={p.key} className="flex items-center gap-2"><span className="w-28 truncate">{refName(p.key)}</span><span className="h-1.5 flex-1 rounded bg-ink-800"><span className="block h-1.5 rounded bg-violet-400/70" style={{ width: `${p.percent}%` }} /></span><span className="w-8 text-right">{p.percent}%</span></li>)}
            </ul>
          )}
          {open && <div className="mt-2 flex flex-wrap items-center gap-2"><TrailerButton k={r.key} originalLanguage={meta.originalLanguage} compact /></div>}
          {open && r.affinity && <div className="mt-2 rounded-lg bg-ink-950/60 p-2"><p className="mb-1 text-[10px] text-slate-500">«Para vos» (afinidad, distinta de la similitud):</p><ChannelBars channels={r.affinity.channels} base={r.affinity.base} score={r.affinity.score} /></div>}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <button type="button" data-testid="similar-watched" aria-pressed={watched} onClick={() => safely(() => setWatched(profileId, r.key, !watched), 'la marca de vista')}
          className={`rounded-lg px-1 py-1.5 text-[11px] font-semibold ${watched ? 'bg-emerald-500/20 text-emerald-300' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>{watched ? '✓ Vista' : '○ Vista'}</button>
        <button type="button" data-testid="similar-not-interested" onClick={() => safely(() => setNotInterested(profileId, r.key, true), '«No me interesa»')}
          className="rounded-lg bg-ink-800 px-1 py-1.5 text-[11px] font-semibold text-slate-300 ring-1 ring-white/10">✕ No me interesa</button>
        {onAddRef ? <button type="button" data-testid="similar-add-ref" onClick={onAddRef} className="rounded-lg bg-ink-800 px-1 py-1.5 text-[11px] font-semibold text-accent ring-1 ring-white/10">＋ Referencia</button>
          : <TitleLink k={r.key} className="rounded-lg bg-ink-800 px-1 py-1.5 text-center text-[11px] font-semibold text-slate-300 ring-1 ring-white/10">Puntuar</TitleLink>}
      </div>
      {userScore !== undefined && r.affinity && <p className="mt-1 text-[10px] text-slate-500">Tu nota {num(userScore, 0)} · estimación para vos {num(r.affinity.score)} (se muestran por separado).</p>}
    </li>
  );
}
