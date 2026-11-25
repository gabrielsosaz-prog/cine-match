import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { ensureBootstrap, updateConfig } from '../db/repo';
import { BUILTIN_PROXY, checkServer } from '../providers/tmdb';
import type { AppConfig, ProfileSettings } from '../types';
import { checkIntegrity, recordLedgerSoon, requestPersistence, type IntegrityReport } from '../services/storageSafety';
import { localBackupInfo } from '../services/backups';
import { pushNotice } from '../services/notices';
import Recovery from '../pages/Recovery';

interface AppCtx { config: AppConfig; profileId: string; settings: ProfileSettings }
const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [report, setReport] = useState<IntegrityReport>();
  const [err, setErr] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setReady(false); setErr(undefined);
    (async () => {
      // v3.6: primero se REVISA (sólo lectura). Un error de lectura o una pérdida detectada nunca llegan a
      // ensureBootstrap, que crearía un perfil vacío y mostraría la bienvenida como si fueras un usuario nuevo.
      const rep = await checkIntegrity(localBackupInfo);
      if (!alive) return;
      setReport(rep);
      if (rep.state === 'read-error' || rep.state === 'suspected-loss') return;
      const cfg = await ensureBootstrap();
      recordLedgerSoon(cfg.activeProfileId);
      requestPersistence().catch(() => undefined);
      if (rep.otherProfileHasRatings) {
        const o = rep.otherProfileHasRatings;
        pushNotice({ kind: 'db', text: `Este perfil no tiene valoraciones. «${o.name}» tiene ${o.count}.`, action: { label: `Usar «${o.name}»`, run: () => { updateConfig({ activeProfileId: o.id }); } } });
      }
      // Si el servidor tiene TMDB_READ_ACCESS_TOKEN, se usa su proxy sin pedir nada al usuario
      if (!cfg.tmdbToken && !cfg.proxyUrl) {
        const s = await checkServer();
        if (s.ok) await updateConfig({ proxyUrl: BUILTIN_PROXY });
      }
      if (alive) setReady(true);
    })().catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [attempt]);
  const config = useLiveQuery(() => (ready ? db.config.get('app') : undefined), [ready]);
  const settings = useLiveQuery(() => (config ? db.settings.get(config.activeProfileId) : undefined), [config?.activeProfileId]);
  const retry = () => setAttempt((a) => a + 1);
  if (report && (report.state === 'read-error' || report.state === 'suspected-loss')) return <Recovery initial={report} onDone={retry} />;
  if (err) return (
    <div className="space-y-3 p-6 text-red-300" data-testid="app-open-error">
      <p>No se pudo abrir la base local: {err}</p>
      <p className="text-sm text-slate-300">Tus datos no se tocaron. Cerrá otras pestañas de Cine Match y reintentá.</p>
      <button onClick={retry} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-ink-950">Reintentar</button>
    </div>
  );
  if (!config || !settings) return <div className="grid h-screen place-items-center text-ink-600">Cargando…</div>;
  return <Ctx.Provider value={{ config, profileId: config.activeProfileId, settings }}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp fuera de AppProvider');
  return c;
}
