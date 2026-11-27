import { useEffect, useState } from 'react';
import { db } from '../db/db';
import {
  createLocalBackup, getLocalBackup, listLocalBackups, localBackupInfo, saveExternalBackup, type LocalBackupMeta,
} from '../services/backups';
import { mergeImport, planImport, type ImportPlan } from '../services/dataPortability';
import {
  acceptCurrentState, activitySummary, checkIntegrity, getPersistenceStatus, listIndexedDbNames, readLedger, requestPersistence,
  type ActivitySummary, type IntegrityReport, type PersistenceStatus,
} from '../services/storageSafety';
import { Card } from '../ui/components';

const fmt = (t?: number) => (t ? new Date(t).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const mb = (n?: number) => (n === undefined ? '—' : `${(n / 1048576).toFixed(1)} MB`);

type Pending = { source: string; json: unknown; plan: ImportPlan };

/**
 * Recuperación de datos (v3.6). Se muestra sola si la app detecta una posible pérdida y también en #/recuperar.
 * Todo lo de esta pantalla es de sólo lectura salvo los botones que dicen explícitamente qué cambian; restaurar e
 * importar usan la fusión segura (nunca pisan valoraciones más nuevas) y antes guardan una copia local.
 * No usa el contexto de la app: funciona aunque la inicialización no haya terminado.
 */
export default function Recovery({ initial, onDone }: { initial?: IntegrityReport; onDone?: () => void }) {
  const [rep, setRep] = useState<IntegrityReport | undefined>(initial);
  const [backups, setBackups] = useState<LocalBackupMeta[]>();
  const [dbs, setDbs] = useState<string[]>();
  const [persist, setPersist] = useState<PersistenceStatus>(getPersistenceStatus());
  const [pending, setPending] = useState<Pending>();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<ActivitySummary>();
  const ledger = readLedger();

  const refresh = async () => {
    setRep(await checkIntegrity(localBackupInfo));
    setBackups(await listLocalBackups().catch(() => []));
    setDbs(await listIndexedDbNames());
    setPersist(await requestPersistence());
    setActivity(await activitySummary().catch(() => undefined));
  };
  useEffect(() => { refresh(); }, []);

  const preview = async (source: string, json: unknown) => {
    setMsg(undefined);
    try { setPending({ source, json, plan: await planImport(json) }); } catch (e) { setMsg((e as Error).message); }
  };
  const previewBackup = async (id: number) => { const b = await getLocalBackup(id); if (b) await preview(`copia local del ${fmt(b.at)}`, b.data); };
  const previewFile = async (f?: File) => { if (f) { try { await preview(`archivo ${f.name}`, JSON.parse(await f.text())); } catch { setMsg('El archivo no se pudo leer como JSON.'); } } };
  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await createLocalBackup('antes de restaurar').catch(() => undefined);
      const r = await mergeImport(pending.json);
      setMsg(`Listo: ${r.added} agregadas, ${r.updated} actualizadas, ${r.keptNewer} conservadas porque lo del dispositivo era igual o más nuevo.${r.interestsAdded ? ` ${r.interestsAdded} respuestas de interés.` : ''}${r.tasteUpdated ? ' Perfil de gustos importado.' : ''}`);
      setPending(undefined);
      await refresh();
    } catch (e) { setMsg(`No se pudo restaurar: ${(e as Error).message}. No se cambió nada.`); } finally { setBusy(false); }
  };
  const useProfile = async (id: string) => {
    const cfg = await db.config.get('app');
    await db.config.put({ ...(cfg ?? {}), id: 'app', activeProfileId: id });
    setMsg('Perfil activo cambiado.');
    await refresh();
  };
  const exportNow = async () => {
    const r = await saveExternalBackup();
    if (r.method !== 'cancelled') setMsg(`Copia de ${r.total} valoraciones ${r.method === 'share' ? 'compartida' : 'descargada'}.`);
  };
  const continueAnyway = async () => {
    if (!confirm('¿Seguir con lo que hay ahora en este dispositivo? No se borra nada y las copias locales se conservan; sólo se deja de mostrar este aviso.')) return;
    await acceptCurrentState();
    onDone?.();
  };

  const ids = [...new Set([...(rep?.profiles ?? []).map((p) => p.id), ...Object.keys(rep?.counts ?? {})])];
  const name = (id: string) => rep?.profiles.find((p) => p.id === id)?.name ?? `(perfil sin nombre: ${id})`;

  return (
    <div className={`mx-auto max-w-xl space-y-4 ${onDone ? 'px-4 py-4' : ''}`} data-testid="recovery">
      <h1 className="text-2xl font-bold">Recuperación de datos</h1>
      {rep?.state === 'read-error' && (
        <Card className="space-y-2 ring-1 ring-red-400/40" data-testid="recovery-read-error">
          <p className="font-semibold text-red-200">No se pudo leer la base local.</p>
          <p className="text-sm text-slate-300">Esto NO significa que tus valoraciones se hayan borrado. La app no escribió nada. Cerrá otras pestañas de Cine Match y reintentá; si sigue, reiniciá el navegador.</p>
          <p className="break-words text-xs text-slate-500">Detalle: {rep.error}</p>
          <button onClick={() => (onDone ? onDone() : refresh())} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-ink-950">Reintentar</button>
        </Card>
      )}
      {rep?.state === 'suspected-loss' && (
        <Card className="space-y-2 ring-1 ring-amber-400/40" data-testid="recovery-loss">
          <p className="font-semibold text-amber-200">Faltan valoraciones en este dispositivo.</p>
          <p className="text-sm text-slate-300">
            {rep.expectedTotal ? <>La última vez había <b>{rep.expectedTotal}</b> ({fmt(rep.ledgerAt)}); ahora hay <b>{rep.total}</b>. </> : <>Hay copias locales con valoraciones pero la base está vacía. </>}
            La app no empezó de cero ni importó nada. Elegí abajo cómo recuperar.
          </p>
        </Card>
      )}
      {msg && <p role="status" className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-200">{msg}</p>}

      {pending && (
        <Card className="space-y-2 ring-1 ring-accent/50" data-testid="recovery-plan">
          <h2 className="font-semibold">Vista previa: {pending.source}</h2>
          <ul className="text-sm text-slate-300">
            <li>Se agregarían <b data-testid="plan-added">{pending.plan.added}</b> valoraciones que faltan.</li>
            <li>Se actualizarían <b data-testid="plan-updated">{pending.plan.updated}</b> porque la copia es más nueva.</li>
            <li>Se conservarían sin cambios <b data-testid="plan-kept">{pending.plan.keptNewer}</b> porque lo del dispositivo es igual o más nuevo.</li>
            {(pending.plan.interestsAdded ?? 0) > 0 && <li>Respuestas de interés nuevas: <b data-testid="plan-interests">{pending.plan.interestsAdded}</b>.</li>}
            {(pending.plan.tasteUpdated ?? 0) > 0 && <li data-testid="plan-taste">Perfil de gustos: se agrega o se actualiza (el archivo es más nuevo).</li>}
            {pending.plan.newProfiles.length > 0 && <li>Perfiles nuevos: {pending.plan.newProfiles.join(', ')}.</li>}
            {pending.plan.invalid > 0 && <li>{pending.plan.invalid} registros inválidos se ignoran.</li>}
          </ul>
          <p className="text-[11px] text-slate-500">Antes de aplicar se guarda una copia local del estado actual. No se borra nada.</p>
          <div className="flex gap-2">
            <button disabled={busy} onClick={apply} data-testid="plan-apply" className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-ink-950 disabled:opacity-50">Recuperar sin pisar datos</button>
            <button onClick={() => setPending(undefined)} className="rounded-lg bg-ink-700 px-3 py-2 text-sm">Cancelar</button>
          </div>
        </Card>
      )}

      <Card className="space-y-2">
        <h2 className="font-semibold">En este dispositivo</h2>
        {!rep && <p className="text-sm text-slate-400">Revisando…</p>}
        {rep && rep.state !== 'read-error' && (
          <ul className="space-y-1 text-sm" data-testid="recovery-profiles">
            {ids.length === 0 && <li className="text-slate-400">No hay perfiles ni valoraciones en la base.</li>}
            {ids.map((id) => (
              <li key={id} className="flex items-center gap-2">
                <span className="flex-1">{name(id)}: <b>{rep.counts[id] ?? 0}</b> valoraciones{id === rep.activeProfileId ? ' · activo' : ''}</span>
                {id !== rep.activeProfileId && (rep.counts[id] ?? 0) > 0 && <button onClick={() => useProfile(id)} data-testid={`use-profile-${id}`} className="rounded-lg bg-ink-700 px-2 py-1 text-xs">Usar este perfil</button>}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-slate-500">Bases del sitio: {dbs ? dbs.join(', ') || 'ninguna' : 'el navegador no permite listarlas'} · Almacenamiento persistente: {persist.supported ? (persist.persisted ? 'sí' : 'no concedido') : 'no disponible'} · Uso: {mb(persist.usage)}</p>
        <p className="text-[11px] text-slate-500">Última copia fuera del dispositivo: {fmt(ledger?.lastExternalBackupAt)}{ledger?.lastExternalBackupTotal !== undefined ? ` (${ledger.lastExternalBackupTotal} valoraciones)` : ''}</p>
        <button onClick={exportNow} className="rounded-lg bg-ink-700 px-3 py-2 text-sm">Guardar una copia de lo que hay ahora</button>
      </Card>

      {activity && (
        <Card className="space-y-2" data-testid="recovery-activity">
          <h2 className="font-semibold">Historial registrado</h2>
          <p className="text-sm text-slate-300">
            Guardados: <b>{activity.byType.rating_saved ?? 0}</b> · borrados uno a uno: <b>{activity.byType.rating_deleted ?? 0}</b> · importaciones: <b>{activity.byType.import ?? 0}</b>
            {activity.lastSavedAt ? <> · último guardado: {fmt(activity.lastSavedAt)}</> : null}
          </p>
          {activity.runs.length > 0 && (
            <details className="text-xs text-slate-400"><summary>Valoraciones en cada cálculo de recomendaciones ({activity.runs.length})</summary>
              <ul data-testid="recovery-runs">{activity.runs.slice(-20).reverse().map((r, i) => <li key={i}>{fmt(r.at)} · {r.ratingsCount} valoraciones · {r.trigger}</li>)}</ul>
            </details>
          )}
          {activity.missingKeys.length > 0 && (
            <details className="text-xs text-slate-400"><summary data-testid="recovery-missing">{activity.missingKeys.length} títulos valorados según el historial que hoy no tienen valoración</summary>
              <ul>{activity.missingKeys.map((m) => <li key={m.key}><a className="text-accent underline" href={`#/t/${m.key.replace(':', '/')}`}>{m.title ?? m.key}</a> · {fmt(m.lastSavedAt)}</li>)}</ul>
            </details>
          )}
          <p className="text-[11px] text-slate-500">El historial no guarda las notas, sólo qué títulos y cuándo. Sirve para ver cuándo se perdieron y qué falta.</p>
        </Card>
      )}

      <Card className="space-y-2">
        <h2 className="font-semibold">Copias locales automáticas</h2>
        {backups && !backups.length && <p className="text-sm text-slate-400">No hay copias locales.</p>}
        <ul className="space-y-1 text-sm" data-testid="recovery-backups">
          {backups?.map((b) => (
            <li key={b.id} className="flex items-center gap-2">
              <span className="flex-1">{fmt(b.at)} · {b.total} valoraciones · {b.reason}</span>
              <button onClick={() => previewBackup(b.id!)} className="rounded-lg bg-ink-700 px-2 py-1 text-xs">Ver qué recupera</button>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2">
        <h2 className="font-semibold">Desde un archivo de respaldo</h2>
        <p className="text-sm text-slate-300">Elegí una exportación de Cine Match (por ejemplo, la del 23/11). Primero vas a ver qué cambiaría; nada se aplica sin confirmar y nunca se pisan valoraciones más nuevas.</p>
        <label className="inline-block cursor-pointer rounded-lg bg-ink-700 px-3 py-2 text-sm">Elegir archivo<input type="file" accept="application/json,.json" data-testid="recovery-file" className="hidden" onChange={(e) => previewFile(e.target.files?.[0])} /></label>
      </Card>

      {onDone && rep?.state === 'suspected-loss' && (
        <button onClick={continueAnyway} className="w-full rounded-xl bg-ink-800 py-3 text-sm text-slate-300" data-testid="recovery-continue">Seguir sin recuperar</button>
      )}
      {onDone && rep?.state !== 'suspected-loss' && rep?.state !== 'read-error' && (
        <button onClick={onDone} className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-ink-950" data-testid="recovery-done">Volver a la app</button>
      )}
    </div>
  );
}
