import { useEffect, useState } from 'react';
import { friendlyError } from '../providers/errors';
import { findTrailer, type TrailerChoice } from '../services/trailers';
import type { TitleKey } from '../types';

/**
 * Botón «Ver tráiler» con reproductor oficial embebido (YouTube sin cookies / Vimeo) en una ventana superpuesta.
 * Al cerrar (✕, tocar fuera, Escape o el botón Atrás de Android) se vuelve exactamente al mismo lugar.
 */
export function TrailerButton({ k, originalLanguage, country, compact }: { k: TitleKey; originalLanguage?: string; country?: string; compact?: boolean }) {
  const [state, setState] = useState<{ busy?: boolean; choice?: TrailerChoice; none?: boolean; error?: string }>({});
  const [open, setOpen] = useState(false);
  const load = async () => {
    setState({ busy: true });
    try {
      const choice = await findTrailer(k, originalLanguage, country);
      setState(choice ? { choice } : { none: true });
      if (choice) setOpen(true);
    } catch (e) { setState({ error: friendlyError(e) }); }
  };
  return (
    <>
      <button type="button" data-testid="trailer-button" onClick={() => (state.choice ? setOpen(true) : load())} disabled={state.busy}
        className={`${compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-sm'} rounded-lg bg-ink-800 font-semibold text-slate-200 ring-1 ring-white/10 disabled:opacity-60`}>
        {state.busy ? 'Buscando tráiler…' : '▶ Ver tráiler'}
      </button>
      {state.none && <span className="text-[11px] text-slate-400" data-testid="trailer-none" role="status">TMDB no informa un tráiler oficial para este título.</span>}
      {state.error && <span className="text-[11px] text-rose-300" role="status">No se pudo buscar el tráiler: {state.error}</span>}
      {open && state.choice && <TrailerModal choice={state.choice} onClose={() => setOpen(false)} />}
    </>
  );
}

export function TrailerModal({ choice, onClose }: { choice: TrailerChoice; onClose: () => void }) {
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
            <p data-testid="trailer-audio">{choice.audio} · {v.site} (oficial según TMDB)</p>
          </div>
          <button type="button" onClick={onClose} data-testid="trailer-close" aria-label="Cerrar tráiler" className="rounded-full bg-white/10 px-3 py-1.5 text-sm font-bold">✕</button>
        </div>
        <div className="relative w-full overflow-hidden rounded-xl bg-black" style={{ paddingTop: '56.25%' }}>
          <iframe src={choice.embedUrl} title={v.name || 'Tráiler'} className="absolute inset-0 h-full w-full" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen data-testid="trailer-frame" />
        </div>
        <a href={choice.watchUrl} target="_blank" rel="noopener noreferrer" className="mt-2 block text-center text-[11px] text-slate-400 underline">Abrir en {v.site}</a>
      </div>
    </div>
  );
}
