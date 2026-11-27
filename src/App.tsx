import { lazy, Suspense, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
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
import { ScrollToTopOnPush } from './hooks/useScrollRestore';
import ErrorBoundary from './ui/ErrorBoundary';
import Notices from './ui/Notices';

const svg = (d: ReactNode) => <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
/** v4.1: siete accesos. «Valoraciones» se llama «Notas» sólo en la barra (la pantalla conserva su nombre). */
const NAV: { to: string; label: string; icon: ReactNode }[] = [
  { to: '/', label: 'Inicio', icon: svg(<path d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.1 5.9L12 16.5l-5.3 2.9 1.1-5.9-4.4-4.1 6-.7z" />) },
  { to: '/buscar', label: 'Buscar', icon: svg(<><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /></>) },
  { to: '/similares', label: 'Similares', icon: svg(<><circle cx="9" cy="12" r="5.5" /><circle cx="15" cy="12" r="5.5" /></>) },
  { to: '/pendientes', label: 'Quiero ver', icon: svg(<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z" />) },
  { to: '/valoraciones', label: 'Notas', icon: svg(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>) },
  { to: '/gustos', label: 'Mis gustos', icon: svg(<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" />) },
  { to: '/ajustes', label: 'Ajustes', icon: svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>) },
];

export default function App() {
  const { config, settings } = useApp();
  const loc = useLocation();
  const hasSource = Boolean(config.tmdbToken || config.proxyUrl);
  const free = ['/ajustes', '/configurar', '/recuperar'].some((p) => loc.pathname.startsWith(p));
  if (!hasSource && !free) return <Navigate to="/configurar" replace />;
  if (hasSource && !settings.onboarded && !free && loc.pathname !== '/bienvenida') return <Navigate to="/bienvenida" replace />;
  const showNav = !['/bienvenida', '/configurar'].includes(loc.pathname);
  return (
    <div className="mx-auto min-h-screen max-w-xl">
      <ScrollToTopOnPush />
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
                {n.icon}<span className="max-w-full">{n.label}</span>
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
