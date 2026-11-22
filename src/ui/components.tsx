import { Link } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import { DIMENSIONS, PLATFORMS } from '../constants';
import { IMG } from '../providers/tmdb';
import { availabilityState } from '../services/availability';
import type { AvailabilitySnapshot, DimensionId, DimensionScores, MediaType, PlatformId } from '../types';
import { relTime, num } from './format';

export function Poster({ path, title, size = 'w185', className = '' }: { path?: string | null; title: string; size?: string; className?: string }) {
  if (!path) return <div className={`grid place-items-center rounded-lg bg-ink-700 p-1 text-center text-[10px] leading-tight text-ink-600 ${className}`} aria-label={`Sin póster: ${title}`}>{title}</div>;
  return <img src={`${IMG}${size}${path}`} alt={`Póster de ${title}`} loading="lazy" className={`rounded-lg bg-ink-700 object-cover ${className}`} />;
}

export function TypeBadge({ type }: { type: MediaType }) {
  return <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">{type === 'movie' ? 'Película' : 'Serie'}</span>;
}

export function PlatformPill({ id, small }: { id: PlatformId; small?: boolean }) {
  const p = PLATFORMS.find((x) => x.id === id)!;
  return <span className={`inline-flex items-center rounded-full font-semibold text-white ${small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'}`} style={{ background: p.color }}>{p.label}</span>;
}

/** Disponibilidad con estado explícito: confirmada, sin datos, no verificada o desactualizada. */
export function AvailabilityLine({ snap, compact }: { snap?: AvailabilitySnapshot | null; compact?: boolean }) {
  const st = availabilityState(snap);
  if (st.kind === 'confirmed')
    return (
      <div className="flex flex-wrap items-center gap-1">
        {st.platforms.map((p) => <PlatformPill key={p} id={p} small={compact} />)}
        <span className={`text-[11px] ${st.stale ? 'text-amber-300' : 'text-slate-400'}`}>{st.stale ? '⚠ desactualizada, ' : ''}verif. {relTime(st.checkedAt)}</span>
      </div>
    );
  if (st.kind === 'not_on_platforms')
    return <div className="text-[11px] text-slate-400">No figura en Netflix, Prime, Disney+ ni Max{st.others.length && !compact ? ` (sí en ${st.others.slice(0, 3).join(', ')})` : ''} · verif. {relTime(st.checkedAt)}</div>;
  if (st.kind === 'no_data') return <div className="text-[11px] text-amber-300">Sin datos de disponibilidad para este país · {relTime(st.checkedAt)}</div>;
  return <div className="text-[11px] text-amber-300">⚠ Disponibilidad no confirmada{compact ? '' : `: ${st.reason}`}</div>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-ink-900 p-4 ring-1 ring-white/5 ${className}`}>{children}</div>;
}

export function Chip({ active, onClick, children, testId }: { active?: boolean; onClick?: () => void; children: ReactNode; testId?: string }) {
  return (
    <button type="button" data-testid={testId} onClick={onClick} aria-pressed={active}
      className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition ${active ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>
      {children}
    </button>
  );
}

/** Selector 1-10 táctil. Tocar el valor elegido lo borra (dimensión opcional). */
export function ScoreRow({ label, value, onChange, testId, compact }: { label: string; value?: number; onChange: (v: number | undefined) => void; testId?: string; compact?: boolean }) {
  return (
    <div className={compact ? 'mb-2' : 'mb-3'} data-testid={testId}>
      <div className="mb-1 flex justify-between text-sm"><span className="text-slate-300">{label}</span><span className="font-semibold text-accent">{value ?? '—'}</span></div>
      <div className="flex gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button key={n} type="button" aria-label={`${label}: ${n}`} onClick={() => onChange(value === n ? undefined : n)}
            className={`${compact ? 'h-7 text-xs' : 'h-9 text-sm'} flex-1 rounded-md font-semibold ${value !== undefined && n <= value ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-400'}`}>{n}</button>
        ))}
      </div>
    </div>
  );
}

/** Estrellas 1-5 para un aspecto. Tocar la estrella elegida o «Quitar» lo deja sin valorar. */
export function StarRow({ label, value, onChange, testId, highlight }: { label: string; value?: number; onChange: (v: number | undefined) => void; testId?: string; highlight?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg py-1 ${highlight ? 'bg-accent/10 px-1.5 ring-1 ring-accent/30' : ''}`} data-testid={testId}>
      <span className="min-w-0 flex-1 text-[13px] leading-tight text-slate-300">{label}</span>
      <div className="flex shrink-0" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${label}: ${n} ${n === 1 ? 'estrella' : 'estrellas'}`}
            onClick={() => onChange(value === n ? undefined : n)}
            className={`grid h-9 w-8 place-items-center text-xl leading-none ${value !== undefined && n <= value ? 'text-accent' : 'text-slate-600'}`}>★</button>
        ))}
      </div>
      <button type="button" onClick={() => onChange(undefined)} disabled={value === undefined} aria-label={`Quitar ${label}`} data-testid={testId ? `${testId}-clear` : undefined}
        className="w-7 shrink-0 text-center text-xs text-slate-400 disabled:invisible">✕</button>
    </div>
  );
}

export function DimensionEditor({ value, onChange, defaultOpen, highlightMissing }: { value: DimensionScores; onChange: (v: DimensionScores) => void; defaultOpen?: boolean; highlightMissing?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? Object.keys(value).length > 0);
  const done = DIMENSIONS.filter((d) => value[d.id] !== undefined).length;
  return (
    <div>
      <button type="button" className="mb-1 text-sm font-semibold text-accent" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="toggle-aspects">
        {open ? '▾' : '▸'} Aspectos con estrellas (opcional) · {done}/{DIMENSIONS.length}
      </button>
      {open && (
        <div className="space-y-0.5">
          {DIMENSIONS.map((d) => (
            <StarRow key={d.id} label={d.label} value={value[d.id]} testId={`dim-${d.id}`} highlight={highlightMissing && value[d.id] === undefined}
              onChange={(v) => { const n = { ...value }; if (v === undefined) delete n[d.id as DimensionId]; else n[d.id as DimensionId] = v; onChange(n); }} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Indicador compacto del porcentaje de aspectos completados (informativo, no mide calidad). */
export function CompletionRing({ percent, done, total }: { percent: number; done: number; total: number }) {
  const r = 9, c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1" title={`${done} de ${total} aspectos`} data-testid="completion" data-percent={percent}>
      <svg viewBox="0 0 24 24" className="h-5 w-5 -rotate-90" aria-hidden="true">
        <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="3" />
        <circle cx="12" cy="12" r={r} fill="none" stroke="#f5b83d" strokeWidth="3" strokeDasharray={`${(percent / 100) * c} ${c}`} strokeLinecap="round" />
      </svg>
      <span className="text-[11px] tabular-nums text-slate-300">{percent}%</span>
    </span>
  );
}

export function ScoreBadge({ score, label }: { score: number; label?: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl bg-accent-soft px-2 py-1 text-accent">
      <span className="text-lg font-bold leading-none">{num(score)}</span>
      <span className="text-[9px] uppercase tracking-wide">{label ?? 'estimada'}</span>
    </div>
  );
}

export function TitleLink({ k, children, className }: { k: string; children: ReactNode; className?: string }) {
  const [type, id] = k.split(':');
  return <Link to={`/t/${type}/${id}`} className={className}>{children}</Link>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm text-slate-400">{children}</div>;
}

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return <div className="flex items-center gap-2 p-4 text-sm text-slate-400" role="status"><span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />{label}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm text-red-200 ring-1 ring-red-500/30">{children}</div>;
}
