import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from './hooks/useApp';
import Home from './pages/Home';
import Search from './pages/Search';
import TitlePage from './pages/TitlePage';
import Ratings from './pages/Ratings';
import Taste from './pages/Taste';
import TasteProfilePage from './pages/TasteProfile';
import EngineStats from './pages/EngineStats';
import Settings from './pages/Settings';
import Onboarding from './pages/Onboarding';
import Setup from './pages/Setup';
import Pending from './pages/Pending';
import Similar from './pages/Similar';
import Person from './pages/Person';
import Recovery from './pages/Recovery';
const Compare = lazy(() => import('./pages/Compare'));
// v4.2: pantallas sociales en módulos aparte (no pesan en la carga de Inicio)
const Inbox = lazy(() => import('./pages/Inbox'));
const AccountPage = lazy(() => import('./pages/SocialSettings').then((m) => ({ default: m.AccountPage })));
const ContactsPage = lazy(() => import('./pages/SocialSettings').then((m) => ({ default: m.ContactsPage })));
const PrivacyPage = lazy(() => import('./pages/SocialSettings').then((m) => ({ default: m.PrivacyPage })));
const NotificationsPage = lazy(() => import('./pages/SocialSettings').then((m) => ({ default: m.NotificationsPage })));
const InvitePage = lazy(() => import('./pages/SocialSettings').then((m) => ({ default: m.InvitePage })));
import { useSocial } from './social/useSocial';
import { initSocial, newCount, onLocalAnswer, setLocalSource, setOpenMatchHandler, setOpenRecHandler, setWantProvider, syncLocalRatings, wantDirty } from './social/store';
import { listInterests, onInterestRecorded } from './services/taste';
import { isSharedAnswer, type SharedAnswer } from './social/interests';
import type { TitleKey } from './types';
import { predictFor } from './services/recommendations';
import { listRatings } from './db/repo';
import { useRatings } from './hooks/useRatings';
import { ScrollToTopOnPush } from './hooks/useScrollRestore';
import ErrorBoundary from './ui/ErrorBoundary';
import Notices from './ui/Notices';

const svg = (d: ReactNode) => <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
/**
 * v4.2: siete accesos. «Me recomendaron» se abrevia «Recibidas» en la barra (no entra en 360 px) y «Mis gustos» pasa a
 * Ajustes. «Valoraciones» se llama «Notas» sólo en la barra (la pantalla conserva su nombre).
 */
const NAV: { to: string; label: string; icon: ReactNode }[] = [
  { to: '/', label: 'Inicio', icon: svg(<path d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.1 5.9L12 16.5l-5.3 2.9 1.1-5.9-4.4-4.1 6-.7z" />) },
  { to: '/buscar', label: 'Buscar', icon: svg(<><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /></>) },
  { to: '/similares', label: 'Similares', icon: svg(<><circle cx="9" cy="12" r="5.5" /><circle cx="15" cy="12" r="5.5" /></>) },
  { to: '/pendientes', label: 'Quiero ver', icon: svg(<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z" />) },
  // v4.3: «Compartidas» (Recibidas · Enviadas · Para ver juntos); ícono de dos personas
  { to: '/compartidas', label: 'Compartidas', icon: svg(<><circle cx="9" cy="8" r="3.2" /><path d="M3 19.5c.6-3.3 3-5.3 6-5.3s5.4 2 6 5.3" /><circle cx="16.5" cy="9" r="2.6" /><path d="M16.2 14.2c2.6.1 4.3 1.9 4.8 4.6" /></>) },
  { to: '/valoraciones', label: 'Notas', icon: svg(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>) },
  { to: '/ajustes', label: 'Ajustes', icon: svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>) },
];

export default function App() {
  const { config, settings } = useApp();
  const loc = useLocation();
  const hasSource = Boolean(config.tmdbToken || config.proxyUrl);
  const free = ['/ajustes', '/configurar', '/recuperar', '/invitacion'].some((p) => loc.pathname.startsWith(p));
  if (!hasSource && !free) return <Navigate to="/configurar" replace />;
  if (hasSource && !settings.onboarded && !free && loc.pathname !== '/bienvenida') return <Navigate to="/bienvenida" replace />;
  const showNav = !['/bienvenida', '/configurar'].includes(loc.pathname);
  return (
    <div className="mx-auto min-h-screen max-w-xl">
      <ScrollToTopOnPush />
      <SocialBridge />
      <main className={`px-4 pt-4 ${showNav ? 'pb-24' : 'pb-8'}`}>
        <ErrorBoundary resetKey={loc.pathname}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/buscar" element={<Search />} />
          <Route path="/t/:type/:id" element={<TitlePage />} />
          <Route path="/valoraciones" element={<Ratings />} />
          <Route path="/pendientes" element={<Pending />} />
          <Route path="/similares" element={<Similar />} />
          <Route path="/persona/:id" element={<Person />} />
          <Route path="/gustos" element={<Taste />} />
          <Route path="/mi-perfil" element={<TasteProfilePage />} />
          <Route path="/estadisticas" element={<EngineStats />} />
          <Route path="/ajustes" element={<Settings />} />
          <Route path="/compartidas" element={<Lazy><Inbox /></Lazy>} />
          <Route path="/recibidas" element={<LegacyInbox />} />
          <Route path="/ajustes/cuenta" element={<Lazy><AccountPage /></Lazy>} />
          <Route path="/ajustes/contactos" element={<Lazy><ContactsPage /></Lazy>} />
          <Route path="/ajustes/privacidad" element={<Lazy><PrivacyPage /></Lazy>} />
          <Route path="/ajustes/notificaciones" element={<Lazy><NotificationsPage /></Lazy>} />
          <Route path="/invitacion" element={<Lazy><InvitePage /></Lazy>} />
          <Route path="/comparar" element={<Suspense fallback={<p className="text-sm text-slate-400">Cargando…</p>}><Compare /></Suspense>} />
          <Route path="/bienvenida" element={<Onboarding />} />
          <Route path="/configurar" element={<Setup />} />
          <Route path="/recuperar" element={<Recovery />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </main>
      <Notices />
      {showNav && (
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-ink-950/95 backdrop-blur" aria-label="Navegación principal">
          <div className="mx-auto flex max-w-xl">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} data-testid={`nav-${n.to.slice(1) || 'inicio'}`}
                className={({ isActive }) => `flex min-h-[54px] min-w-0 flex-1 flex-col items-center justify-start gap-0.5 px-0.5 pb-1 pt-2 text-center text-[10px] font-medium leading-[1.1] ${isActive ? 'text-accent' : 'text-slate-400'}`}>
                <span className="relative">{n.icon}{n.to === '/compartidas' && <InboxBadge />}</span><span className="max-w-full">{n.label}</span>
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}

/** v4.2 usaba «/recibidas» (también en notificaciones ya enviadas): se redirige conservando los parámetros. */
function LegacyInbox() {
  const loc = useLocation();
  return <Navigate to={`/compartidas${loc.search}`} replace />;
}
const Lazy = ({ children }: { children: ReactNode }) => <Suspense fallback={<p className="text-sm text-slate-400">Cargando…</p>}>{children}</Suspense>;

/** Contador discreto de recomendaciones nuevas sobre el ícono de «Recibidas». */
function InboxBadge() {
  const s = useSocial();
  const n = s.phase === 'ready' ? newCount() : 0;
  if (!n) return null;
  return <span data-testid="inbox-badge" aria-label={`${n} nuevas`} className="absolute -right-2.5 -top-1.5 min-w-[17px] rounded-full bg-sky-400 px-1 text-center text-[10px] font-bold leading-[17px] text-ink-950">{n > 99 ? '99+' : n}</span>;
}

/**
 * v4.2 · Conecta lo social con la app SIN bloquearla: se inicia después de pintar Inicio, abre las recomendaciones
 * desde los avisos y mantiene sincronizada la lista de «Para ver juntos» (sólo si se autorizó).
 */
function SocialBridge() {
  const { profileId } = useApp();
  const nav = useNavigate();
  const rs = useRatings(profileId);
  useEffect(() => {
    setOpenRecHandler((id) => nav(`/compartidas?r=${id}`));
    setOpenMatchHandler((k, c) => nav(`/compartidas?tab=juntos&k=${encodeURIComponent(k)}&c=${encodeURIComponent(c)}`));
    return onInterestRecorded((r) => onLocalAnswer(r.profileId, r.key, r.answer));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => { void initSocial(); }, 400);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    setWantProvider(async (withScores) => {
      const want = (await listRatings(profileId)).filter((r) => r.list === 'want' || r.list === 'watching');
      const preds = withScores ? await predictFor(profileId, want.map((r) => r.key), { holdOut: true }).catch(() => new Map()) : new Map();
      return want.map((r) => { const p = preds.get(r.key); return { key: r.key, addedAt: r.updatedAt, score: p && p.confidence >= 0.12 ? Math.round(p.score * 100) / 100 : undefined }; });
    });
    wantDirty(1500);
    // v4.3: lo local es la fuente de verdad (última respuesta de interés sin «Ya la vi»; nota general posterior)
    setLocalSource({
      profileId,
      answers: async () => {
        const m = new Map<TitleKey, SharedAnswer>();
        const at = new Map<TitleKey, number>();
        for (const r of await listInterests(profileId)) if (isSharedAnswer(r.answer) && r.at >= (at.get(r.key) ?? -1)) { m.set(r.key, r.answer); at.set(r.key, r.at); }
        return m;
      },
      ratings: async () => new Map((await listRatings(profileId)).filter((r) => r.overall !== undefined).map((r) => [r.key, r.overall!])),
    });
  }, [profileId]);
  const s = useSocial();
  const rsig = rs.ratings.filter((r) => r.overall !== undefined).map((r) => `${r.key}=${r.overall}`).sort().join(',');
  useEffect(() => {
    if (rs.status !== 'ready' || s.phase !== 'ready') return;
    syncLocalRatings(profileId, new Map(rs.ratings.filter((r) => r.overall !== undefined).map((r) => [r.key, r.overall!])));
  }, [rsig, s.phase, s.contacts, s.sent.length, s.inbox.length]);
  const sig = rs.ratings.filter((r) => r.list === 'want' || r.list === 'watching').map((r) => r.key).sort().join(',');
  useEffect(() => { if (rs.status === 'ready') wantDirty(); }, [sig]);
  return null;
}
