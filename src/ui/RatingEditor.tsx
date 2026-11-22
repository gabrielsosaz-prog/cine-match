import { useEffect, useMemo, useRef, useState } from 'react';
import { ABANDON_REASONS, COMMENT_MAX, DIMENSIONS, LIST_LABELS, NOT_INTERESTED_LABEL } from '../constants';
import type { RatingPatch } from '../db/repo';
import { getExtractor } from '../engine/comments';
import { rateAndLearn, removeAndLearn } from '../services/ratings';
import type { DimensionScores, ListStatus, Rating, RecommendationRun, TitleKey, TitleMeta } from '../types';
import { DimensionEditor, ScoreRow } from './components';

const LISTS: ListStatus[] = ['want', 'watching', 'abandoned'];

interface Draft { watched: boolean; list?: ListStatus; notInterested: boolean; overall?: number; dims: DimensionScores; comment: string; reason: string; at: number }

const draftKey = (profileId: string, k: TitleKey) => `cine-match:draft:${profileId}|${k}`;
export function readDraft(profileId: string, k: TitleKey): Draft | undefined {
  try { const raw = localStorage.getItem(draftKey(profileId, k)); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
}
const writeDraft = (profileId: string, k: TitleKey, d: Draft) => { try { localStorage.setItem(draftKey(profileId, k), JSON.stringify(d)); } catch { /* sin almacenamiento */ } };
export const clearDraft = (profileId: string, k: TitleKey) => { try { localStorage.removeItem(draftKey(profileId, k)); } catch { /* sin almacenamiento */ } };

const fromRating = (r?: Rating): Draft => ({
  watched: r?.watched ?? false, list: r?.list, notInterested: Boolean(r?.notInterested), overall: r?.overall,
  dims: r?.dimensions ?? {}, comment: r?.comment ?? '', reason: r?.abandonReason ?? '', at: r?.updatedAt ?? 0,
});
const same = (a: Draft, b: Draft) => JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });

/**
 * Editor completo de un título: vista, seguimiento, «No me interesa», nota general, aspectos con estrellas y «Otros».
 * Todo es independiente y opcional. Los cambios sin guardar se conservan como borrador en el dispositivo
 * (si se cierra por accidente, se recuperan al volver a abrir).
 */
export default function RatingEditor({ profileId, k, existing, isTv, title, openAspects, highlightMissing, onSaved, onCancel }: {
  profileId: string; k: TitleKey; existing?: Rating; isTv: boolean; title?: TitleMeta; openAspects?: boolean; highlightMissing?: boolean;
  onSaved?: (r: { rating?: Rating; run?: RecommendationRun }) => void; onCancel?: () => void;
}) {
  const initial = useMemo(() => fromRating(existing), [existing?.updatedAt, k]);
  const [d, setD] = useState<Draft>(initial);
  const [restored, setRestored] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  useEffect(() => {
    const draft = readDraft(profileId, k);
    if (draft && draft.at >= (existing?.updatedAt ?? 0) && !same(draft, initial)) { setD(draft); setRestored(true); }
    else { setD(initial); setRestored(false); if (draft) clearDraft(profileId, k); }
    loaded.current = true;
  }, [initial]);
  const dirty = !same(d, initial);
  const set = (patch: Partial<Draft>) => setD((prev) => {
    const next = { ...prev, ...patch, at: Date.now() };
    if (loaded.current) writeDraft(profileId, k, next);
    return next;
  });

  const interpretation = useMemo(() => {
    if (!d.comment.trim()) return [];
    return getExtractor().extract(d.comment, { title, overall: d.overall }).filter((p) => p.kind !== 'aspect' || p.strength === 1);
  }, [d.comment, d.overall, title]);

  const save = async () => {
    setBusy(true); setMsg(undefined);
    const patch: RatingPatch = {
      watched: d.watched, list: d.list ?? null, notInterested: d.notInterested, overall: d.overall ?? null,
      dimensions: d.dims, comment: d.comment, abandonReason: d.reason || null,
    };
    const res = await rateAndLearn(profileId, k, patch);
    clearDraft(profileId, k);
    setBusy(false); setRestored(false);
    setMsg(res.rating ? (res.run ? 'Guardado. Modelo recalculado.' : 'Guardado.') : 'Sin datos para guardar: se quitó el registro.');
    onSaved?.(res);
  };
  const discard = () => { clearDraft(profileId, k); setD(initial); setRestored(false); };
  const dimLabel = (id: string) => DIMENSIONS.find((x) => x.id === id)?.label.toLowerCase() ?? id;

  return (
    <div className="space-y-3" data-testid="rating-editor">
      {restored && (
        <p role="status" data-testid="draft-restored" className="rounded-lg bg-sky-500/10 p-2 text-xs text-sky-200">
          Recuperamos cambios que no habías guardado. <button type="button" className="underline" onClick={discard}>Descartarlos</button>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" role="switch" aria-checked={d.watched} onClick={() => set({ watched: !d.watched })} data-testid="editor-watched"
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${d.watched ? 'bg-emerald-500 text-ink-950' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>
          {d.watched ? '✓ Vista' : '○ No vista'}
        </button>
        <button type="button" role="switch" aria-checked={d.notInterested} onClick={() => set({ notInterested: !d.notInterested })} data-testid="editor-not-interested"
          className={`rounded-full px-3 py-1.5 text-sm font-semibold ${d.notInterested ? 'bg-red-500/80 text-white' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>
          {d.notInterested ? `✕ ${NOT_INTERESTED_LABEL}` : NOT_INTERESTED_LABEL}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label="Seguimiento">
        {LISTS.map((l) => (
          <button key={l} type="button" aria-pressed={d.list === l} onClick={() => set({ list: d.list === l ? undefined : l })} data-testid={`list-${l}`}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${d.list === l ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>{LIST_LABELS[l]}</button>
        ))}
      </div>
      {d.list === 'abandoned' && (
        <label className="block text-sm text-slate-300">¿Por qué la abandonaste?
          <select value={d.reason} onChange={(e) => set({ reason: e.target.value })} className="mt-1 w-full rounded-lg bg-ink-800 p-2 ring-1 ring-white/10" data-testid="abandon-reason">
            <option value="">Elegí un motivo (opcional)</option>
            {ABANDON_REASONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
      )}
      <ScoreRow label="Valoración general (1-10)" value={d.overall} onChange={(v) => set({ overall: v })} testId="overall" />
      <p className="-mt-2 text-[11px] text-slate-500">La nota general es independiente de las estrellas. Todo lo demás es opcional.{isTv ? ' En series es una valoración global.' : ''}</p>
      <DimensionEditor value={d.dims} onChange={(dims) => set({ dims })} defaultOpen={openAspects} highlightMissing={highlightMissing} />
      <label className="block text-sm text-slate-300">
        Otros: ¿Qué te gustó o no te gustó?
        <textarea value={d.comment} maxLength={COMMENT_MAX} rows={3} onChange={(e) => set({ comment: e.target.value })} data-testid="comment"
          placeholder="Ej.: Me gustó la idea de que en realidad vivimos dentro de una simulación."
          className="mt-1 w-full rounded-lg bg-ink-800 p-2 text-sm ring-1 ring-white/10 placeholder:text-slate-500" />
      </label>
      {interpretation.length > 0 && (
        <p className="-mt-2 text-[11px] text-slate-400" data-testid="comment-interpretation">
          Se toma para tus recomendaciones: {interpretation.map((p, i) => (
            <span key={i} className={p.polarity > 0 ? 'text-emerald-300' : 'text-red-300'}>{i ? ' · ' : ''}{p.polarity > 0 ? '+' : '−'} {p.kind === 'aspect' ? dimLabel(p.id) : p.label}</span>
          ))}
        </p>
      )}
      <p className="-mt-2 text-[10px] text-slate-500">El texto se guarda y se analiza sólo en este dispositivo, con reglas locales (no con IA externa).</p>
      <div className="sticky bottom-0 -mx-1 flex gap-2 bg-ink-900 px-1 py-2">
        <button onClick={save} disabled={busy} data-testid="save-rating" className="flex-1 rounded-xl bg-accent py-2.5 font-semibold text-ink-950 disabled:opacity-50">{busy ? 'Guardando…' : existing ? 'Guardar cambios' : 'Guardar'}</button>
        {onCancel && <button onClick={onCancel} data-testid="close-editor" className="rounded-xl bg-ink-800 px-3 text-sm ring-1 ring-white/10">{dirty ? 'Cerrar (queda el borrador)' : 'Cerrar'}</button>}
        {existing && !onCancel && <button onClick={async () => { clearDraft(profileId, k); await removeAndLearn(profileId, k); setMsg('Registro eliminado.'); }} className="rounded-xl bg-ink-800 px-3 text-sm text-red-300 ring-1 ring-white/10">Borrar</button>}
      </div>
      {msg && <p role="status" data-testid="save-status" className="text-sm text-emerald-300">{msg}</p>}
    </div>
  );
}
