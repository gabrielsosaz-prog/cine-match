import type { MediaType, TitleKey } from '../types';

export interface SocialUser { id: string; email?: string; displayName?: string }
export interface Contact {
  id: string;
  alias: string;
  favorite: boolean;
  blocked: boolean;
  /** Yo autoricé «Para ver juntos» con esta persona */
  shareMatches: boolean;
  /** Yo autoricé que vea mi puntuación en las coincidencias */
  shareScores: boolean;
  /** Lo que la otra persona autorizó respecto de mí */
  theirShareMatches: boolean;
  theirShareScores: boolean;
  /** v4.3 · Yo autoricé compartir mis intereses en los títulos intercambiados con esta persona */
  shareInterests: boolean;
  /** v4.3 · Yo autoricé compartir mis valoraciones posteriores (sólo títulos intercambiados) */
  shareRatings: boolean;
  /** v4.3 · Quiero recibir avisos de coincidencias con esta persona */
  notifyMatches: boolean;
  theirShareInterests: boolean;
  theirShareRatings: boolean;
  linked: boolean;
  createdAt: number;
}
export interface Invite { id: string; createdAt: number; expiresAt: number; usedAt?: number; declinedAt?: number; revokedAt?: number }
export interface SentRec { id: string; recipient: string; key: TitleKey; createdAt: number; title?: string; year?: number; posterPath?: string; comment?: string }
/** v4.3 · Interés / valoración de un contacto en un título intercambiado (sólo lo autorizado mutuamente). */
export interface SharedRow { contact: string; key: TitleKey; answer?: 'no' | 'quiza' | 'si' | 'mucho'; answerAt?: number; rating?: number; ratingAt?: number }
export interface SocialEvent { id: number; actor: string; kind: 'shared' | 'match' | 'match_max'; key?: TitleKey; title?: string; createdAt: number }
export interface SocialPrefs { notifyRecs: boolean; notifyMatches: boolean; notifyMax: boolean }
export interface PutItem { key: TitleKey; f: 'answer' | 'rating'; v: string | null; at: number }
export interface PutResult { key: TitleKey; f: 'answer' | 'rating'; status: 'ok' | 'stale' | 'not_shared' | 'invalid'; events: number[] }
export interface InboxRec {
  id: string;
  sender: string;
  senderName: string;
  key: TitleKey;
  title: string;
  year?: number;
  posterPath?: string;
  comment?: string;
  createdAt: number;
  seenAt?: number;
  archivedAt?: number;
}
export interface SendInput { recipient: string; type: MediaType; tmdbId: number; title: string; year?: number; posterPath?: string | null; comment?: string; resend?: boolean }
export interface Match { key: TitleKey; myScore?: number; theirScore?: number; myAddedAt: number; theirAddedAt: number }
export interface WantSyncItem { key: TitleKey; score?: number; addedAt: number }

export type SocialErrorCode =
  | 'network' | 'not_authenticated' | 'not_configured' | 'duplicate' | 'not_a_contact' | 'rate_limited' | 'invalid_invite'
  | 'already_linked' | 'matches_not_authorized' | 'no_profile' | 'invalid_credentials' | 'email_taken' | 'weak_password' | 'unknown';

const MESSAGES: Record<SocialErrorCode, string> = {
  network: 'Sin conexión con el servicio social.',
  not_authenticated: 'Tenés que iniciar sesión.',
  not_configured: 'El servicio social no está disponible en esta instalación.',
  duplicate: 'Ya le enviaste este título.',
  not_a_contact: 'Esa persona ya no está entre tus contactos.',
  rate_limited: 'Demasiados envíos seguidos. Probá en unos minutos.',
  invalid_invite: 'La invitación no es válida o venció.',
  already_linked: 'Ya están vinculados.',
  matches_not_authorized: 'Falta la autorización de alguno de los dos.',
  no_profile: 'Primero elegí tu nombre en «Mi cuenta».',
  invalid_credentials: 'Correo o contraseña incorrectos.',
  email_taken: 'Ese correo ya tiene una cuenta. Iniciá sesión.',
  weak_password: 'La contraseña debe tener al menos 8 caracteres.',
  unknown: 'Ocurrió un error inesperado.',
};
export class SocialError extends Error {
  constructor(public code: SocialErrorCode, detail?: string) { super(MESSAGES[code] + (detail && code === 'unknown' ? ` (${detail})` : '')); }
}
export function toSocialError(e: unknown): SocialError {
  if (e instanceof SocialError) return e;
  const msg = String((e as { message?: string })?.message ?? e ?? '');
  for (const c of Object.keys(MESSAGES) as SocialErrorCode[]) if (c !== 'unknown' && c !== 'network' && msg.includes(c)) return new SocialError(c);
  if (/invalid login credentials/i.test(msg)) return new SocialError('invalid_credentials');
  if (/already registered|already exists/i.test(msg)) return new SocialError('email_taken');
  if (/password/i.test(msg) && /(at least|characters|weak)/i.test(msg)) return new SocialError('weak_password');
  if (/fetch|network|Load failed|timeout|ECONN|Failed to fetch|aborted/i.test(msg) || (typeof navigator !== 'undefined' && navigator.onLine === false)) return new SocialError('network');
  return new SocialError('unknown', msg.slice(0, 120));
}
