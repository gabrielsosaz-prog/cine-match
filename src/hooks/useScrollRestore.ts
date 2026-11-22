import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Restauración de posición al volver (v3.1).
 *
 * Al salir de una pantalla se guarda (sessionStorage, por pestaña): la tarjeta visible de referencia
 * (atributo data-key) y su desplazamiento, la posición absoluta y cuántos resultados había cargados.
 * Al volver con «Atrás» (navegación POP, incluido el botón Atrás de Android) se restaura la cantidad cargada y
 * se vuelve a la misma tarjeta, reintentando mientras cargan imágenes o datos (sin saltos: se corrige sólo hasta
 * que el usuario toca la pantalla). Si se entra a la sección desde el menú o se inicia una búsqueda nueva
 * (navegación PUSH), se empieza arriba.
 */
interface Saved { y: number; anchor?: string; offset?: number; page: number; at: number }
const KEY = (k: string) => `cine-match:pos:${k}`;
const read = (k: string): Saved | undefined => { try { const v = sessionStorage.getItem(KEY(k)); return v ? JSON.parse(v) : undefined; } catch { return undefined; } };
const write = (k: string, v: Saved) => { try { sessionStorage.setItem(KEY(k), JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
export const clearPosition = (k: string) => { try { sessionStorage.removeItem(KEY(k)); } catch { /* */ } };

function firstVisible(): { anchor?: string; offset?: number } {
  const els = document.querySelectorAll<HTMLElement>('[data-key]');
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.bottom > 56) return { anchor: el.dataset.key, offset: r.top };
  }
  return {};
}

export function useScrollRestore(screen: string, ready: boolean): { page: number; setPage: (n: number) => void; restoring: boolean } {
  const nav = useNavigationType();
  const loc = useLocation();
  const k = `${screen}${loc.search}`;
  const saved = useRef<Saved | undefined>(nav === 'POP' ? read(k) : undefined);
  const [page, setPageState] = useState(saved.current?.page ?? 1);
  const pageRef = useRef(page);
  const setPage = (n: number) => { pageRef.current = n; setPageState(n); write(k, { y: window.scrollY, ...firstVisible(), page: n, at: Date.now() }); };
  const [restoring, setRestoring] = useState(Boolean(saved.current));

  // Guardar al salir (y periódicamente al desplazarse, por si el navegador descarta la pestaña)
  useEffect(() => {
    if (nav !== 'POP') clearPosition(k);
    let t: ReturnType<typeof setTimeout> | undefined;
    // Sólo se guarda mientras esta pantalla es la actual: al cambiar de pantalla el navegador ajusta el desplazamiento
    // (página nueva más corta) y ese ajuste no debe pisar la posición guardada al tocar la tarjeta.
    const here = window.location.hash;
    const save = () => window.location.hash === here && write(k, { y: window.scrollY, ...firstVisible(), page: pageRef.current, at: Date.now() });
    const onScroll = () => { if (t) clearTimeout(t); t = setTimeout(save, 150); };
    window.addEventListener('scroll', onScroll, { passive: true });
    // Al tocar una tarjeta o enlace se guarda en el acto (antes de que cambie la pantalla)
    document.addEventListener('click', save, true);
    return () => { window.removeEventListener('scroll', onScroll); document.removeEventListener('click', save, true); if (t) clearTimeout(t); };
  }, [k]);

  // Restaurar cuando el contenido está listo
  useLayoutEffect(() => {
    const s = saved.current;
    if (!s || !ready) return;
    let cancelled = false;
    const stop = () => { cancelled = true; setRestoring(false); cleanup(); };
    const apply = () => {
      if (cancelled) return;
      const el = s.anchor ? document.querySelector<HTMLElement>(`[data-key="${CSS.escape(s.anchor)}"]`) : null;
      if (el) window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - (s.offset ?? 0));
      else window.scrollTo(0, s.y);
    };
    apply();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : undefined;
    ro?.observe(document.body);
    const iv = setInterval(apply, 120);
    const end = setTimeout(stop, 2500);
    const user = () => stop();
    window.addEventListener('touchstart', user, { passive: true });
    window.addEventListener('wheel', user, { passive: true });
    window.addEventListener('keydown', user);
    function cleanup() {
      ro?.disconnect(); clearInterval(iv); clearTimeout(end);
      window.removeEventListener('touchstart', user); window.removeEventListener('wheel', user); window.removeEventListener('keydown', user);
    }
    saved.current = undefined;
    return () => { cancelled = true; cleanup(); };
  }, [ready]);

  return { page, setPage, restoring };
}

/** Navegación nueva (menú, enlaces): la pantalla nueva empieza arriba. «Atrás» lo maneja cada lista. */
export function ScrollToTopOnPush() {
  const nav = useNavigationType();
  const loc = useLocation();
  useLayoutEffect(() => { if (nav !== 'POP') window.scrollTo(0, 0); }, [loc.pathname, loc.search]);
  return null;
}
