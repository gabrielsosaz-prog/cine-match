import { useSyncExternalStore } from 'react';
import { dismissNotice, getNotices, subscribeNotices } from '../services/notices';

/** Avisos flotantes no bloqueantes, por encima de la barra de navegación. */
export default function Notices() {
  const list = useSyncExternalStore(subscribeNotices, getNotices, getNotices);
  if (!list.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 mx-auto flex max-w-xl flex-col gap-2 px-4" aria-live="polite">
      {list.map((n) => (
        <div key={n.id} role={n.kind === 'error' ? 'alert' : 'status'} data-testid={`notice-${n.kind}`}
          className={`pointer-events-auto flex items-start gap-2 rounded-xl p-3 text-sm shadow-lg ring-1 ${n.kind === 'error' ? 'bg-red-950/95 text-red-100 ring-red-400/30' : 'bg-ink-800/95 text-slate-100 ring-white/10'}`}>
          <span className="flex-1">{n.text}</span>
          {n.action && <button type="button" data-testid={`notice-${n.kind}-action`} className="shrink-0 font-semibold text-accent underline" onClick={() => { n.action!.run(); dismissNotice(n.id); }}>{n.action.label}</button>}
          <button type="button" aria-label="Cerrar aviso" className="shrink-0 text-slate-400" onClick={() => dismissNotice(n.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
