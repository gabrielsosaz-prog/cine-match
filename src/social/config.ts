/**
 * v4.2 Social · configuración pública del servicio social (Supabase).
 *
 * Estos valores son PÚBLICOS por diseño: la URL del proyecto y la clave publicable («anon») sólo permiten lo que las
 * políticas por fila (RLS) y las funciones del servidor autorizan a cada usuario autenticado. Las claves de
 * administración (service_role) y la clave privada VAPID viven sólo en Supabase, nunca en este repositorio.
 * Vacíos = la app funciona igual, sin funciones sociales.
 */
export const SOCIAL_CONFIG = {
  url: 'https://wocofvwwafasimgnvrwd.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvY29mdnd3YWZhc2ltZ252cndkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU4MTM0MjcsImV4cCI6MjExMTM4OTQyN30.fIKhKeiqL4kn2tKrNSrLB82UIbItyUxLtGEltQZvYKo',
  /** Clave pública VAPID (base64url) para notificaciones push */
  vapidPublicKey: 'BNGmENYGhWAQJld02KRFBR--X84CTmUREGrBpdzfftphjqBfvg_aSvlrUBmAiZEgFBzCbediwznaV50gDlXKQ14',
};

/** Pruebas: un servidor social simulado (tests/fixtures/fakeSocialServer.mjs) reemplaza a Supabase. */
export function socialEndpoint(): { kind: 'supabase'; url: string; key: string } | { kind: 'fake'; url: string } | undefined {
  try {
    const fake = localStorage.getItem('cine-match:social-fake');
    if (fake) return { kind: 'fake', url: fake };
  } catch { /* sin almacenamiento */ }
  if (SOCIAL_CONFIG.url && SOCIAL_CONFIG.anonKey) return { kind: 'supabase', url: SOCIAL_CONFIG.url, key: SOCIAL_CONFIG.anonKey };
  return undefined;
}
