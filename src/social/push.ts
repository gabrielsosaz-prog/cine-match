/**
 * v4.2 · Notificaciones push (Web Push estándar con claves VAPID). Funcionan con la PWA instalada en Android (Chrome).
 * El permiso se pide sólo cuando la persona toca «Activar» después de leer para qué sirve.
 * Si el navegador no las admite, la app sigue mostrando el contador interno.
 */
import { SOCIAL_CONFIG } from './config';
import { getBackend } from './store';

export type PushStatus = 'unsupported' | 'denied' | 'on' | 'off';

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && Boolean(SOCIAL_CONFIG.vapidPublicKey);
}
async function registration() {
  const r = await Promise.race([navigator.serviceWorker.ready, new Promise<undefined>((res) => setTimeout(() => res(undefined), 4000))]);
  return r;
}
export async function pushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  if (!reg) return 'unsupported';
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}
function b64urlToBytes(s: string) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export async function enablePush(): Promise<PushStatus> {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  if (!reg) return 'unsupported';
  let sub = await reg.pushManager.getSubscription();
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(SOCIAL_CONFIG.vapidPublicKey) });
  await (await getBackend()).savePush(sub.toJSON());
  return 'on';
}
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await (await getBackend()).deletePush(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
