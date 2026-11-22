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

export function Card({ children, className = '', 'data-testid': testId }: { children: ReactNode; className?: string; 'data-testid'?: string }) {
  return <div data-testid={testId} className={`rounded-2xl bg-ink-900 p-4 ring-1 ring-white/5 ${className}`}>{children}</div>;
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

/**
 * Estado de la lectura de tus datos locales. Distingue «cargando», «tardando» y «error» de «vacío»
 * para que una lectura demorada nunca se vea como si se hubieran perdido las valoraciones.
 */
export function DataStatus({ status, slow, stale, error, onRetry }: { status: 'loading' | 'ready' | 'error'; slow?: boolean; stale?: boolean; error?: string; onRetry: () => void }) {
  if (status === 'loading' && !slow) return <Spinner label="Leyendo tus datos guardados…" />;
  if (status === 'loading' || status === 'error') {
    return (
      <div role="alert" data-testid="data-status" className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-100">
        {status === 'error' ? 'No se pudo leer la base local en este momento.' : 'La base local está tardando en responder.'} Tus valoraciones siguen guardadas en el dispositivo.
        <button type="button" onClick={onRetry} data-testid="data-retry" className="ml-1 font-semibold underline">Reintentar</button>
        {error && <span className="mt-1 block text-[11px] text-amber-200/70">Detalle: {error}</span>}
      </div>
    );
  }
  if (stale) return <p role="status" data-testid="data-stale" className="rounded-lg bg-amber-500/10 p-2 text-[11px] text-amber-200">Mostrando los últimos datos confirmados mientras se reconecta la base local. <button type="button" className="underline" onClick={onRetry}>Reintentar</button></p>;
  return null;
}

/**
 * v3.0 — Dos notas comparables en la misma escala 1-10:
 *  · «Público»: promedio de votos de TMDB (fuente identificada). Nunca se inventa: sin votos suficientes, «s/d».
 *  · «Para vos»: estimación personalizada de cuánto lo disfrutarías (1-10). No es tu nota, ni la confianza del
 *    modelo, ni una probabilidad. Con poca evidencia se marca «provisional» o «info insuficiente».
 * Si ya lo puntuaste, se muestra «Tu nota» y la estimación queda aparte.
 */
export function publicScore(meta?: { voteAverage?: number; voteCount?: number }): number | undefined {
  return meta?.voteAverage && (meta.voteCount ?? 0) >= 20 ? Math.round(meta.voteAverage * 10) / 10 : undefined;
}
export type PersonalState = { kind: 'ok' | 'provisional' | 'insufficient'; value?: number };
export function personalState(item?: { score: number; confidence: number; provisional?: boolean; lowEvidence?: boolean }): PersonalState {
  if (!item) return { kind: 'insufficient' };
  if (item.confidence < 0.12) return { kind: 'insufficient', value: item.score };
  if (item.provisional || item.lowEvidence) return { kind: 'provisional', value: item.score };
  return { kind: 'ok', value: item.score };
}

export function ScorePair({ item, meta, userScore, compact }: {
  item?: { score: number; confidence: number; provisional?: boolean; lowEvidence?: boolean }; meta?: { voteAverage?: number; voteCount?: number }; userScore?: number; compact?: boolean;
}) {
  const pub = publicScore(meta);
  const ps = personalState(item);
  const box = 'flex min-w-[3.6rem] flex-col items-center rounded-xl px-1.5 py-1';
  return (
    <div className="flex shrink-0 gap-1" data-testid="score-pair">
      {userScore !== undefined ? (
        <div className={`${box} bg-emerald-500/15 text-emerald-300`} data-testid="score-user" title="Tu nota (la que diste)">
          <span className="text-lg font-bold leading-none">{num(userScore, userScore % 1 ? 1 : 0)}</span>
          <span className="text-[9px] uppercase tracking-wide">tu nota</span>
        </div>
      ) : (
        <div className={`${box} bg-accent-soft text-accent`} data-testid="score-personal" data-state={ps.kind}
          title="Para vos: estimación personalizada de cuánto lo disfrutarías (1-10). No es una probabilidad.">
          <span className="text-lg font-bold leading-none">{ps.kind === 'insufficient' ? '—' : num(ps.value!)}</span>
          <span className="text-[9px] uppercase leading-tight tracking-wide">{ps.kind === 'insufficient' ? 'info insuf.' : 'para vos'}</span>
          {ps.kind === 'provisional' && !compact && <span className="text-[8px] leading-none text-accent/80">provisional</span>}
        </div>
      )}
      <div className={`${box} bg-sky-500/10 text-sky-200`} data-testid="score-public" title="Público: promedio de votos de TMDB (0-10)">
        <span className="text-lg font-bold leading-none">{pub !== undefined ? num(pub) : 's/d'}</span>
        <span className="text-[9px] uppercase tracking-wide">TMDB</span>
      </div>
    </div>
  );
}

const CH_LABELS: Record<string, string> = {
  theme: 'Temáticas', comments: '«Otros»', aspects: 'Aspectos', actors: 'Actores', crew: 'Dirección y guion',
  similar: 'Parecido a tu historial', genre: 'Géneros', format: 'Formato y época', rejection: 'Descartes', quality: 'Público (auxiliar)',
};

/** Diagnóstico: cuánto aportó cada canal a la estimación «Para vos» (en puntos sobre tu media). */
export function ChannelBars({ channels, base, score }: { channels?: { id: string; contribution: number; weight: number }[]; base?: number; score: number }) {
  if (!channels?.length) return <p className="text-[11px] text-slate-500">Sin detalle por canal para esta estimación (se calculó con una versión anterior del motor).</p>;
  const rows = [...channels].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const max = Math.max(0.5, ...rows.map((r) => Math.abs(r.contribution)));
  return (
    <div className="space-y-1" data-testid="channel-bars">
      <p className="text-[11px] text-slate-400">Cómo se llegó a {num(score)}: tu media{base !== undefined ? ` (${num(base)})` : ''} más el aporte de cada canal.</p>
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 text-[11px]" data-testid={`channel-${r.id}`}>
          <span className="w-28 shrink-0 truncate text-slate-300">{CH_LABELS[r.id] ?? r.id}</span>
          <div className="relative h-2 flex-1 rounded bg-ink-800">
            <div className={`absolute top-0 h-2 rounded ${r.contribution >= 0 ? 'left-1/2 bg-emerald-400/80' : 'right-1/2 bg-red-400/80'}`} style={{ width: `${(Math.abs(r.contribution) / max) * 50}%` }} />
            <div className="absolute left-1/2 top-0 h-2 w-px bg-white/30" />
          </div>
          <span className={`w-10 shrink-0 text-right tabular-nums ${r.contribution >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{r.contribution >= 0 ? '+' : '−'}{num(Math.abs(r.contribution), 2)}</span>
        </div>
      ))}
      <p className="text-[10px] text-slate-500">Diagnóstico del modelo con tus datos: muestra cómo se combinan las señales, no mide la precisión real de la predicción.</p>
    </div>
  );
}
