import { useEffect, useState } from 'react';
import { ABANDON_REASONS, LIST_LABELS } from '../constants';
import type { RatingPatch } from '../db/repo';
import { rateAndLearn, removeAndLearn } from '../services/ratings';
import type { DimensionScores, ListStatus, Rating, RecommendationRun, TitleKey } from '../types';
import { DimensionEditor, ScoreRow } from './components';

const LISTS: ListStatus[] = ['want', 'watching', 'abandoned', 'not_interested'];

/**
 * Editor completo de un título: marca de visto, lista de seguimiento, nota general y aspectos.
 * Cada parte es independiente: se puede puntuar sin marcar vista y marcar vista sin puntuar.
 */
export default function RatingEditor({ profileId, k, existing, isTv, openAspects, onSaved, onCancel }: {
  profileId: string; k: TitleKey; existing?: Rating; isTv: boolean; openAspects?: boolean;
  onSaved?: (r: { rating?: Rating; run?: RecommendationRun }) => void; onCancel?: () => void;
}) {
  const [watched, setWatched] = useState(existing?.watched ?? false);
  const [list, setList] = useState<ListStatus | undefined>(existing?.list);
  const [overall, setOverall] = useState<number | undefined>(existing?.overall);
  const [dims, setDims] = useState<DimensionScores>(existing?.dimensions ?? {});
  const [reason, setReason] = useState(existing?.abandonReason ?? '');
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setWatched(existing?.watched ?? false); setList(existing?.list); setOverall(existing?.overall);
    setDims(existing?.dimensions ?? {}); setReason(existing?.abandonReason ?? '');
  }, [existing?.updatedAt, k]);

  const save = async () => {
    setBusy(true); setMsg(undefined);
    const patch: RatingPatch = { watched, list: list ?? null, overall: overall ?? null, dimensions: dims, abandonReason: reason || null };
    const res = await rateAndLearn(profileId, k, patch);
    setBusy(false);
    setMsg(res.rating ? (res.run ? 'Guardado. Ranking actualizado.' : 'Guardado.') : 'Sin datos para guardar: se quitó el registro.');
    onSaved?.(res);
  };

  return (
    <div className="space-y-3" data-testid="rating-editor">
      <div className="flex items-center gap-2">
        <button type="button" role="switch" aria-checked={watched} onClick={() => setWatched(!watched)} data-testid="editor-watched"
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${watched ? 'bg-emerald-500 text-ink-950' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>
          {watched ? '✓ Vista' : '○ No vista'}
        </button>
        <span className="text-[11px] text-slate-500">Independiente de la nota</span>
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label="Seguimiento">
        {LISTS.map((l) => (
          <button key={l} type="button" aria-pressed={list === l} onClick={() => setList(list === l ? undefined : l)} data-testid={`list-${l}`}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${list === l ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>{LIST_LABELS[l]}</button>
        ))}
      </div>
      {list === 'abandoned' && (
        <label className="block text-sm text-slate-300">¿Por qué la abandonaste?
          <select value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full rounded-lg bg-ink-800 p-2 ring-1 ring-white/10" data-testid="abandon-reason">
            <option value="">Elegí un motivo (opcional)</option>
            {ABANDON_REASONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
      )}
      <ScoreRow label="Valoración general" value={overall} onChange={setOverall} testId="overall" />
      <p className="-mt-2 text-[11px] text-slate-500">La general no se calcula con los aspectos. Puntuá sólo los aspectos que quieras.{isTv ? ' En series es una valoración global.' : ''}</p>
      <DimensionEditor value={dims} onChange={setDims} defaultOpen={openAspects} />
      <div className="sticky bottom-0 -mx-1 flex gap-2 bg-ink-900 px-1 py-2">
        <button onClick={save} disabled={busy} data-testid="save-rating" className="flex-1 rounded-xl bg-accent py-2.5 font-semibold text-ink-950 disabled:opacity-50">{busy ? 'Guardando y recalculando…' : existing ? 'Guardar cambios' : 'Guardar'}</button>
        {onCancel && <button onClick={onCancel} className="rounded-xl bg-ink-800 px-3 text-sm ring-1 ring-white/10">Cerrar</button>}
        {existing && !onCancel && <button onClick={async () => { await removeAndLearn(profileId, k); setMsg('Registro eliminado.'); }} className="rounded-xl bg-ink-800 px-3 text-sm text-red-300 ring-1 ring-white/10">Borrar</button>}
      </div>
      {msg && <p role="status" data-testid="save-status" className="text-sm text-emerald-300">{msg}</p>}
    </div>
  );
}
