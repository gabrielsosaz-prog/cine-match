import { useEffect, useState } from 'react';
import { friendlyError } from '../providers/errors';
import { findTrailers, needsExternalSearch, youtubeSearchUrl, type TrailerChoice } from '../services/trailers';
import type { TitleKey } from '../types';

/**
 * Botón «Ver tráiler» con reproductor oficial embebido (YouTube sin cookies / Vimeo) en una ventana superpuesta.
 * Al cerrar (✕, tocar fuera, Escape o el botón Atrás de Android) se vuelve exactamente al mismo lugar.
 */
export function TrailerButton({ k, originalLanguage, country, compact, title, year }: { k: TitleKey; originalLanguage?: string; country?: string; compact?: boolean; title?: string; year?: number }) {
  const [state, setState] = useState<{ busy?: boolean; list?: TrailerChoice[]; error?: string }>({});
  const [open, setOpen] = useState<number>(-1);
  const load = async () => {
    setState({ busy: true });
    try {
      const list = await findTrailers(k, originalLanguage, country);
      setState({ list });
      if (list.length) setOpen(0);
    } catch (e) { setState({ error: friendlyError(e) }); }
  };
  const list = state.list;
  const external = title && list && needsExternalSearch(list);
  return (
    <>
      <button type="button" data-testid="trailer-button" onClick={() => (list?.length ? setOpen(0) : load())} disabled={state.busy}
        className={`${compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-sm'} rounded-lg bg-ink-800 font-semibold text-slate-200 ring-1 ring-white/10 disabled:opacity-60`}>
        {state.busy ? 'Buscando tráiler…' : '▶ Ver tráiler'}
      </button>
      {list && !list.length && <span className="text-[11px] text-slate-400" data-testid="trailer-none" role="status">TMDB no informa un tráiler para este título.</span>}
      {external && <YouTubeSearchLink title={title!} year={year} compact={compact} />}
      {state.error && <span className="text-[11px] text-rose-300" role="status">No se pudo buscar el tráiler: {state.error}</span>}
      {open >= 0 && list?.[open] && <TrailerModal choice={list[open]} versions={list} onPick={setOpen} onClose={() => setOpen(-1)} search={title ? { title, year } : undefined} />}
    </>
  );
}

/** Abre una búsqueda real de YouTube (pestaña nueva); no reproduce ningún vídeo no verificado. */
export function YouTubeSearchLink({ title, year, compact }: { title: string; year?: number; compact?: boolean }) {
  return (
    <a href={youtubeSearchUrl(title, year)} target="_blank" rel="noopener noreferrer" data-testid="trailer-youtube-search"
      className={`${compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-sm'} rounded-lg bg-ink-800 text-slate-300 underline ring-1 ring-white/10`}>Buscar tráiler subtitulado en YouTube</a>
  );
}

export function TrailerModal({ choice, onClose, versions = [choice], onPick, search }: { choice: TrailerChoice; onClose: () => void; versions?: TrailerChoice[]; onPick?: (i: number) => void; search?: { title: string; year?: number } }) {
  useEffect(() => {
    // Una entrada de historial propia: «Atrás» cierra el reproductor en lugar de salir de la pantalla
    const y = window.scrollY;
    history.pushState({ ...(history.state ?? {}), cmTrailer: true }, '');
    let closedByBack = false;
    const onPop = () => { closedByBack = true; onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (!closedByBack && history.state?.cmTrailer) history.back();
      requestAnimationFrame(() => window.scrollTo(0, y));
    };
  }, []);
  const v = choice.video;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3" role="dialog" aria-modal="true" aria-label="Tráiler" data-testid="trailer-modal" onClick={onClose}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-start gap-2">
          <div className="min-w-0 flex-1 text-xs text-slate-300">
            <p className="truncate font-semibold text-slate-100">{v.name || 'Tráiler'}</p>
            <p data-testid="trailer-audio">{choice.audio} · {v.site}</p>
          </div>
          <button type="button" onClick={onClose} data-testid="trailer-close" aria-label="Cerrar tráiler" className="rounded-full bg-white/10 px-3 py-1.5 text-sm font-bold">✕</button>
        </div>
        <div className="relative w-full overflow-hidden rounded-xl bg-black" style={{ paddingTop: '56.25%' }}>
          {/* key: al cambiar de versión se crea un iframe nuevo; cambiar el src sumaría una entrada al historial y «Atrás» no cerraría el reproductor */}
          <iframe key={v.key} src={choice.embedUrl} title={v.name || 'Tráiler'} className="absolute inset-0 h-full w-full" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen data-testid="trailer-frame" />
        </div>
        <a href={choice.watchUrl} target="_blank" rel="noopener noreferrer" className="mt-2 block text-center text-[11px] text-slate-400 underline">Abrir en {v.site}</a>
        {versions.length > 1 && (
          <div className="mt-2" data-testid="trailer-versions">
            <p className="mb-1 text-[11px] text-slate-400">Otras versiones ({versions.length}):</p>
            <ul className="max-h-40 space-y-1 overflow-y-auto">
              {versions.map((c, i) => (
                <li key={c.video.key}>
                  <button type="button" data-testid="trailer-version" aria-current={c === choice} onClick={() => onPick?.(i)}
                    className={`w-full rounded-lg px-2 py-1.5 text-left text-[11px] ring-1 ring-white/10 ${c === choice ? 'bg-accent/20 text-accent' : 'bg-white/5 text-slate-200'}`}>
                    <span className="block truncate font-medium">{c.video.name || 'Vídeo'}</span>
                    <span className="block truncate text-slate-400">{c.audio}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {search && needsExternalSearch(versions) && <div className="mt-2 text-center"><YouTubeSearchLink title={search.title} year={search.year} compact /></div>}
      </div>
    </div>
  );
}
