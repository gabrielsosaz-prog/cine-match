const rtf = new Intl.RelativeTimeFormat('es-AR', { numeric: 'auto' });
export function relTime(ts?: number): string {
  if (!ts) return 'nunca';
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'recién';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}
export const dateTime = (ts: number) => new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
export const num = (n: number | undefined, d = 1) => (n === undefined || Number.isNaN(n) ? '—' : n.toFixed(d).replace('.', ','));
