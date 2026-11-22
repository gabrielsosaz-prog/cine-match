import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { friendlyError } from '../providers/errors';
import { getTitle } from '../services/catalog';
import { similarTo } from '../engine/recommender';
import { availabilityState } from '../services/availability';
import type { MediaType, TitleKey, TitleMeta } from '../types';
import { titleKey } from '../types';
import { AvailabilityLine, Card, ChannelBars, ErrorNote, personalState, Poster, publicScore, ScorePair, Spinner, TitleLink, TypeBadge } from '../ui/components';
import { predictFor } from '../services/recommendations';
import type { RecommendationItem } from '../types';
import { num } from '../ui/format';
import { dateTime } from '../ui/format';
import RatingEditor from '../ui/RatingEditor';
import { useRatings } from '../hooks/useRatings';

export default function TitlePage() {
  const { type, id } = useParams();
  const key = titleKey(type as MediaType, Number(id)) as TitleKey;
  const { settings, profileId } = useApp();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true); setError(undefined);
    getTitle(key, { language: settings.language, country: settings.country }).then((r) => { if (r.error) setError(friendlyError(r.error)); }).finally(() => setLoading(false));
  }, [key, settings.language, settings.country]);
  const meta = useLiveQuery(() => db.titles.get(key), [key]);
  const snap = useLiveQuery(() => db.availability.get(`${key}|${settings.country}`), [key, settings.country]);
  const rs = useRatings(profileId);
  const rating = rs.byKey.get(key);
  // «Para vos»: estimación con el modelo actual. Si ya lo puntuaste, se estima SIN tu nota (no es un eco de ella)
  const [pred, setPred] = useState<RecommendationItem | null>();
  useEffect(() => {
    let alive = true;
    if (!meta) return;
    predictFor(profileId, [key], { holdOut: true }).then((m) => { if (alive) setPred(m.get(key) ?? null); }).catch(() => { if (alive) setPred(null); });
    return () => { alive = false; };
  }, [key, meta?.fetchedAt, rating?.updatedAt, rs.ratings.length]);
  const related = useLiveQuery(async () => {
    if (!meta?.related?.length) return [];
    const rel = (await db.titles.bulkGet(meta.related)).filter((m): m is TitleMeta => Boolean(m));
    const map = new Map<TitleKey, TitleMeta>([[meta.key, meta], ...rel.map((m) => [m.key, m] as [TitleKey, TitleMeta])]);
    return similarTo(meta.key, map, rel.map((r) => r.key), 10).map((s) => map.get(s.key)!);
  }, [meta?.key, meta?.fetchedAt]);

  if (!meta && loading) return <Spinner />;
  if (!meta) return <ErrorNote>{error ?? 'No se encontró el título.'}</ErrorNote>;
  const st = availabilityState(snap);
  return (
    <article className="space-y-4">
      {meta.backdropPath && <Poster path={meta.backdropPath} size="w780" title={meta.title} className="-mx-4 -mt-4 aspect-video w-[calc(100%+2rem)] max-w-none rounded-none opacity-60" />}
      <div className={`flex gap-3 ${meta.backdropPath ? '-mt-20 relative' : ''}`}>
        <Poster path={meta.posterPath} size="w342" title={meta.title} className="h-40 w-28 shrink-0 shadow-xl" />
        <div className="min-w-0 self-end">
          <h1 className="text-xl font-bold leading-tight">{meta.title}</h1>
          {meta.originalTitle && meta.originalTitle !== meta.title && <div className="text-sm italic text-slate-400">{meta.originalTitle}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
            <TypeBadge type={meta.type} />
            <span>{meta.year ?? 'Año sin datos'}</span>
            {meta.runtime && <span>· {meta.runtime} min{meta.type === 'tv' ? '/ep.' : ''}</span>}
            {meta.numberOfSeasons && <span>· {meta.numberOfSeasons} {meta.numberOfSeasons === 1 ? 'temporada' : 'temporadas'}</span>}
          </div>
        </div>
      </div>
      <Card className="space-y-2" data-testid="title-scores">
        <div className="flex items-center gap-3">
          <ScorePair item={pred ?? undefined} meta={meta} />
          {rating?.overall !== undefined && (
            <div className="flex flex-col items-center rounded-xl bg-emerald-500/15 px-2 py-1 text-emerald-300" data-testid="title-user-score">
              <span className="text-lg font-bold leading-none">{num(rating.overall, rating.overall % 1 ? 1 : 0)}</span><span className="text-[9px] uppercase tracking-wide">tu nota</span>
            </div>
          )}
          <div className="min-w-0 text-[11px] text-slate-400">
            {pred === undefined ? 'Calculando «Para vos»…'
              : !pred ? 'Sin estimación disponible.'
              : personalState(pred).kind === 'insufficient' ? 'Info insuficiente para estimar: puntuá más títulos.'
              : <>Para vos: estimación {personalState(pred).kind === 'provisional' ? 'provisional ' : ''}de cuánto lo disfrutarías. Confianza {pred.confidenceLabel}.{rating?.overall !== undefined ? ' Calculada sin tu nota, para compararla.' : ''}</>}
            {publicScore(meta) !== undefined ? <span className="block">TMDB: {num(publicScore(meta))} con {meta.voteCount?.toLocaleString('es-AR')} votos.</span> : <span className="block">TMDB: sin votos suficientes.</span>}
          </div>
        </div>
        {pred && (
          <details data-testid="title-diagnostic">
            <summary className="cursor-pointer text-xs text-accent">¿Por qué esta estimación?</summary>
            <ul className="mt-1 space-y-0.5 text-xs text-slate-300">{pred.explanation.map((l, i) => <li key={i}>• {l}</li>)}</ul>
            <div className="mt-2"><ChannelBars channels={pred.channels} base={pred.base} score={pred.score} /></div>
          </details>
        )}
      </Card>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap gap-1.5">{meta.genres.map((g) => <span key={g.id} className="rounded-full bg-ink-800 px-2.5 py-1 text-xs">{g.name}</span>)}</div>
      <p className="text-sm leading-relaxed text-slate-300">{meta.overview ?? <span className="italic text-slate-500">Sinopsis no disponible.</span>}{meta.overviewLang === 'en' && <span className="block text-[11px] text-slate-500">(Sinopsis en inglés: no hay traducción al español en TMDB.)</span>}</p>

      <Card className="space-y-2">
        <h2 className="font-semibold">Dónde verla ({settings.country})</h2>
        <AvailabilityLine snap={snap} />
        {snap?.status === 'ok' && snap.offers.filter((o) => !o.platform).length > 0 && (
          <p className="text-xs text-slate-400">Otras opciones: {[...new Set(snap.offers.filter((o) => !o.platform).map((o) => `${o.providerName} (${o.kind === 'rent' ? 'alquiler' : o.kind === 'buy' ? 'compra' : 'suscripción'})`))].slice(0, 6).join(', ')}</p>
        )}
        <p className="text-[11px] text-slate-500">
          {snap ? <>Fuente: {snap.source} · última verificación {dateTime(snap.checkedAt)}. </> : null}
          {st.kind !== 'confirmed' && 'La disponibilidad puede no estar confirmada. '}
          {snap?.link && <a href={snap.link} target="_blank" rel="noreferrer" className="text-accent underline">Ver en JustWatch/TMDB</a>}
        </p>
      </Card>

      <Card><h2 className="mb-3 font-semibold">Tu valoración</h2><RatingEditor key={key} profileId={profileId} k={key} existing={rating} isTv={meta.type === 'tv'} title={meta} /></Card>

      {(meta.directors.length > 0 || meta.cast.length > 0) && (
        <Card className="space-y-1 text-sm">
          {meta.directors.length > 0 && <p><span className="text-slate-400">{meta.type === 'movie' ? 'Dirección' : 'Creación'}:</span> {meta.directors.map((d) => d.name).join(', ')}</p>}
          {(meta.writers?.length ?? 0) > 0 && <p><span className="text-slate-400">Guion:</span> {meta.writers!.slice(0, 4).map((d) => d.name).join(', ')}</p>}
          {meta.cast.length > 0 && <p><span className="text-slate-400">Reparto:</span> {meta.cast.slice(0, 6).map((c) => c.name).join(', ')}</p>}
        </Card>
      )}
      {meta.seasons && meta.seasons.length > 0 && (
        <details className="rounded-2xl bg-ink-900 p-4 text-sm ring-1 ring-white/5"><summary className="font-semibold">Temporadas ({meta.seasons.length})</summary>
          <ul className="mt-2 space-y-1 text-slate-300">{meta.seasons.map((s) => <li key={s.number}>{s.name} · {s.episodes ?? '?'} episodios{s.airDate ? ` · ${s.airDate.slice(0, 4)}` : ''}</li>)}</ul>
        </details>
      )}
      {meta.missing.length > 0 && <p className="text-[11px] text-slate-500">Datos no disponibles en el proveedor: {meta.missing.join(', ')}.</p>}

      {related && related.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Títulos similares</h2><Link to={`/similares?ref=${encodeURIComponent(key)}`} className="text-xs text-accent underline" data-testid="open-similar">Buscar similares a fondo</Link></div>
          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
            {related.map((r) => (
              <TitleLink key={r.key} k={r.key} className="w-24 shrink-0">
                <Poster path={r.posterPath} title={r.title} className="h-36 w-24" />
                <div className="mt-1 line-clamp-2 text-xs">{r.title}</div>
              </TitleLink>
            ))}
          </div>
        </section>
      )}
      <p className="text-center text-[10px] text-slate-500">Metadatos: TMDB. Este producto usa la API de TMDB pero no está avalado ni certificado por TMDB. Disponibilidad: JustWatch.</p>
    </article>
  );
}
