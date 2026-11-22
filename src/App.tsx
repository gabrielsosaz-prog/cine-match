import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './hooks/useApp';
import Home from './pages/Home';
import Search from './pages/Search';
import TitlePage from './pages/TitlePage';
import Ratings from './pages/Ratings';
import Taste from './pages/Taste';
import Settings from './pages/Settings';
import Onboarding from './pages/Onboarding';
import Setup from './pages/Setup';
import Pending from './pages/Pending';
import Similar from './pages/Similar';
import Person from './pages/Person';
import { ScrollToTopOnPush } from './hooks/useScrollRestore';
import ErrorBoundary from './ui/ErrorBoundary';
import Notices from './ui/Notices';

const NAV = [
  { to: '/', label: 'Inicio', icon: '★' },
  { to: '/buscar', label: 'Buscar', icon: '⌕' },
  { to: '/similares', label: 'Similares', icon: '≈' },
  { to: '/valoraciones', label: 'Valoraciones', icon: '✎' },
  { to: '/gustos', label: 'Mis gustos', icon: '♥' },
  { to: '/ajustes', label: 'Ajustes', icon: '⚙' },
];

export default function App() {
  const { config, settings } = useApp();
  const loc = useLocation();
  const hasSource = Boolean(config.tmdbToken || config.proxyUrl);
  const free = ['/ajustes', '/configurar'].some((p) => loc.pathname.startsWith(p));
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
          <Route path="/ajustes" element={<Settings />} />
          <Route path="/bienvenida" element={<Onboarding />} />
          <Route path="/configurar" element={<Setup />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </main>
      <Notices />
      {showNav && (
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-ink-950/95 backdrop-blur" aria-label="Navegación principal">
          <div className="mx-auto flex max-w-xl">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `flex min-w-0 flex-1 flex-col items-center py-2 text-[10px] min-[380px]:text-[11px] ${isActive ? 'text-accent' : 'text-slate-400'}`}>
                <span className="text-lg leading-none" aria-hidden>{n.icon}</span><span className="max-w-full truncate">{n.label}</span>
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
