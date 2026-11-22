import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { updateConfig } from '../db/repo';
import { TmdbClient } from '../providers/tmdb';
import { friendlyError } from '../providers/errors';
import { Card, ErrorNote } from '../ui/components';
import { useApp } from '../hooks/useApp';

export async function testConnection(token?: string, proxyUrl?: string) {
  const c = new TmdbClient({ token, proxyUrl });
  await c.genres('movie', 'es-MX');
}

export default function Setup() {
  const { config } = useApp();
  const nav = useNavigate();
  const [token, setToken] = useState(config.tmdbToken ?? '');
  const [proxy, setProxy] = useState(config.proxyUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState(false);
  // Navegar recién cuando la configuración guardada ya está disponible en el contexto
  useEffect(() => { if (saved && (config.tmdbToken || config.proxyUrl)) nav('/'); }, [saved, config.tmdbToken, config.proxyUrl]);
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      await testConnection(token.trim() || undefined, proxy.trim() || undefined);
      await updateConfig({ tmdbToken: token.trim() || undefined, proxyUrl: proxy.trim() || undefined });
      setSaved(true);
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Cine Match <span className="text-accent">AI</span></h1>
      <p className="text-slate-300">Para buscar títulos reales y su disponibilidad necesitás una clave gratuita de TMDB (uso personal).</p>
      <Card className="space-y-3 text-sm text-slate-300">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Creá una cuenta en <a className="text-accent underline" href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer">themoviedb.org</a>.</li>
          <li>Entrá a <a className="text-accent underline" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">Configuración → API</a> y pedí una clave de uso personal.</li>
          <li>Copiá el <b>Token de acceso de lectura</b> (empieza con <code>eyJ</code>) y pegalo acá.</li>
        </ol>
        <p className="text-xs text-slate-400">La clave se guarda sólo en este dispositivo y no se incluye en el código de la app. Si tenés un proxy propio (ver documentación), podés usarlo en su lugar.</p>
      </Card>
      <label className="block text-sm">Token de TMDB
        <textarea data-testid="token-input" value={token} onChange={(e) => setToken(e.target.value)} rows={3} className="mt-1 w-full rounded-xl bg-ink-800 p-3 font-mono text-xs ring-1 ring-white/10" placeholder="eyJhbGciOiJIUzI1NiJ9…" />
      </label>
      <details className="text-sm text-slate-400"><summary>Usar proxy propio (avanzado)</summary>
        <input value={proxy} onChange={(e) => setProxy(e.target.value)} className="mt-2 w-full rounded-xl bg-ink-800 p-3 text-xs ring-1 ring-white/10" placeholder="https://mi-proxy.workers.dev/3" />
      </details>
      {err && <ErrorNote>{err}</ErrorNote>}
      <button data-testid="save-token" disabled={busy || (!token.trim() && !proxy.trim())} onClick={save} className="w-full rounded-xl bg-accent py-3 font-semibold text-ink-950 disabled:opacity-40">
        {busy ? 'Probando conexión…' : 'Guardar y continuar'}
      </button>
    </div>
  );
}
