import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { ensureBootstrap, updateConfig } from '../db/repo';
import { BUILTIN_PROXY, checkServer } from '../providers/tmdb';
import type { AppConfig, ProfileSettings } from '../types';

interface AppCtx { config: AppConfig; profileId: string; settings: ProfileSettings }
const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    ensureBootstrap()
      .then(async (cfg) => {
        // Si el servidor tiene TMDB_READ_ACCESS_TOKEN, se usa su proxy sin pedir nada al usuario
        if (!cfg.tmdbToken && !cfg.proxyUrl) {
          const s = await checkServer();
          if (s.ok) await updateConfig({ proxyUrl: BUILTIN_PROXY });
        }
        setReady(true);
      })
      .catch((e) => setErr(String(e)));
  }, []);
  const config = useLiveQuery(() => (ready ? db.config.get('app') : undefined), [ready]);
  const settings = useLiveQuery(() => (config ? db.settings.get(config.activeProfileId) : undefined), [config?.activeProfileId]);
  if (err) return <div className="p-6 text-red-300">No se pudo abrir la base local: {err}</div>;
  if (!config || !settings) return <div className="grid h-screen place-items-center text-ink-600">Cargando…</div>;
  return <Ctx.Provider value={{ config, profileId: config.activeProfileId, settings }}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp fuera de AppProvider');
  return c;
}
