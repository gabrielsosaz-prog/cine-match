import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { PLATFORMS } from '../constants';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { useRecommendations } from '../hooks/useRecs';
import { streamingPlatforms } from '../services/availability';
import type { MediaType, PlatformId, RecommendationItem, TitleMeta } from '../types';
import { AvailabilityLine, Chip, Empty, ErrorNote, Poster, ScoreBadge, Spinner, TitleLink, TypeBadge, PlatformPill } from '../ui/components';
import { relTime } from '../ui/format';

function RecRow({ item, meta, snap }: { item: RecommendationItem; meta?: TitleMeta; snap?: any }) {
  const [open, setOpen] = useState(false);
  if (!meta) return null;
  return (
    <li className="rounded-2xl bg-ink-900 p-3 ring-1 ring-white/5" data-testid="rec-item">
      <div className="flex gap-3">
        <TitleLink k={item.key} className="shrink-0"><Poster path={meta.posterPath} title={meta.title} className="h-28 w-[76px]" /></TitleLink>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="text-sm font-bold text-slate-500">#{item.rank}</span>
            <TitleLink k={item.key} className="min-w-0 flex-1"><h3 className="truncate font-semibold leading-tight">{meta.title}</h3></TitleLink>
            <ScoreBadge score={item.score} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
            <TypeBadge type={meta.type} />{meta.year && <span>{meta.year}</span>}
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${item.confidenceLabel === 'alta' ? 'bg-emerald-500/15 text-emerald-300' : item.confidenceLabel === 'media' ? 'bg-sky-500/15 text-sky-300' : 'bg-slate-500/15 text-slate-300'}`}>confianza {item.confidenceLabel}</span>
            {item.exploration && <span className="rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] text-fuchsia-300">exploración</span>}
          </div>
          <div className="mt-1.5"><AvailabilityLine snap={snap} compact /></div>
          <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 text-left text-xs text-slate-300" data-testid="rec-explanation">
            {open ? item.explanation.map((l, i) => <p key={i} className="mb-0.5">• {l}</p>) : <span className="line-clamp-2">{item.explanation[0]}</span>}
          </button>
        </div>
      </div>
    </li>
  );
}

export default function Home() {
  const { profileId, settings } = useApp();
  const { run, titles, busy, error, refresh } = useRecommendations(profileId);
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all');
  const [type, setType] = useState<MediaType | 'all'>('all');
  const pendingCount = useLiveQuery(() => db.ratings.where('[profileId+status]').equals([profileId, 'want']).count(), [profileId]);
  const snaps = useLiveQuery(() => db.availability.bulkGet((run?.items ?? []).map((i) => `${i.key}|${settings.country}`)), [run?.id, settings.country]);
  const events = useLiveQuery(() => db.availabilityEvents.where('country').equals(settings.country).reverse().sortBy('detectedAt').then((e) => e.slice(0, 6)), [settings.country]);
  const eventTitles = useLiveQuery(() => db.titles.bulkGet((events ?? []).map((e) => e.key)), [events]);

  const rows = useMemo(() => {
    if (!run || !titles) return [];
    return run.items.map((item, i) => ({ item, meta: titles[i], snap: snaps?.[i] }))
      .filter((r) => r.meta && (type === 'all' || r.meta.type === type))
      .filter((r) => platform === 'all' || streamingPlatforms(r.snap).includes(platform))
      .map((r, i) => ({ ...r, item: { ...r.item, rank: i + 1 } }));
  }, [run, titles, snaps, type, platform]);
  const featured = rows.filter((r) => r.meta?.backdropPath || r.meta?.posterPath).slice(0, 3);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Para vos</h1>
          <p className="text-xs text-slate-400">{run ? `Actualizado ${relTime(run.createdAt)} · ${run.ratingsCount} valoraciones · ${run.algorithmVersion}` : 'Calculando tu ranking…'}</p>
        </div>
        <button onClick={() => refresh(true)} disabled={busy} className="rounded-full bg-ink-800 px-3 py-2 text-sm ring-1 ring-white/10 disabled:opacity-50" aria-label="Actualizar recomendaciones">{busy ? '…' : '↻ Actualizar'}</button>
      </header>

      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        <Chip active={platform === 'all'} onClick={() => setPlatform('all')}>Todas</Chip>
        {PLATFORMS.filter((p) => settings.platforms.includes(p.id)).map((p) => <Chip key={p.id} testId={`filter-${p.id}`} active={platform === p.id} onClick={() => setPlatform(p.id)}>{p.label}</Chip>)}
      </div>
      <div className="flex gap-2">
        <Chip active={type === 'all'} onClick={() => setType('all')}>Todo</Chip>
        <Chip active={type === 'movie'} onClick={() => setType('movie')} testId="filter-movie">Películas</Chip>
        <Chip active={type === 'tv'} onClick={() => setType('tv')} testId="filter-tv">Series</Chip>
        <Link to="/pendientes" className="ml-auto shrink-0 rounded-full bg-ink-800 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10">Pendientes ({pendingCount ?? 0})</Link>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {run?.warning && <ErrorNote>{run.warning}</ErrorNote>}
      {busy && !run && <Spinner label="Buscando títulos en tus plataformas…" />}

      {featured.length > 0 && (
        <section aria-label="Destacadas" className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4">
          {featured.map(({ item, meta }) => (
            <TitleLink key={item.key} k={item.key} className="relative w-[85%] shrink-0 snap-start overflow-hidden rounded-2xl">
              <Poster path={meta!.backdropPath ?? meta!.posterPath} size="w780" title={meta!.title} className="aspect-video w-full" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
              <div className="absolute bottom-0 p-3">
                <div className="text-xs font-semibold text-accent">#{item.rank} · {item.score.toFixed(1).replace('.', ',')} estimada</div>
                <div className="text-lg font-bold leading-tight">{meta!.title}</div>
              </div>
            </TitleLink>
          ))}
        </section>
      )}

      {run && rows.length === 0 && !busy && (
        <Empty>No hay recomendaciones con estos filtros. {settings.includeUnconfirmed ? '' : 'Podés incluir títulos con disponibilidad no confirmada en Ajustes.'} <br /><Link to="/buscar" className="text-accent underline">Valorá más títulos</Link> para mejorar el ranking.</Empty>
      )}
      <ol className="space-y-3" aria-label="Ranking personalizado">
        {rows.map((r) => <RecRow key={r.item.key} {...r} />)}
      </ol>

      {events && events.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Cambios detectados en plataformas</h2>
          <p className="text-[11px] text-slate-400">Detectados al comparar verificaciones; el proveedor no informa la fecha exacta del cambio.</p>
          {events.map((e, i) => (
            <div key={e.id} className="flex items-center gap-2 text-sm">
              <span className={e.change === 'added' ? 'text-emerald-300' : 'text-red-300'}>{e.change === 'added' ? '＋ Llegó a' : '－ Salió de'}</span>
              <PlatformPill id={e.platform} small />
              <TitleLink k={e.key} className="truncate underline">{eventTitles?.[i]?.title ?? e.key}</TitleLink>
              <span className="ml-auto shrink-0 text-[11px] text-slate-500">{relTime(e.detectedAt)}</span>
            </div>
          ))}
        </section>
      )}
      <p className="pt-2 text-center text-[10px] text-slate-500">La nota estimada es una afinidad calculada (1-10), no una probabilidad. Datos: TMDB · Disponibilidad: JustWatch.</p>
    </div>
  );
}
