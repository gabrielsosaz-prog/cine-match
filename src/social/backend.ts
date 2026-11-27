import type { Contact, InboxRec, Invite, Match, PutItem, PutResult, SendInput, SentRec, SharedRow, SocialEvent, SocialPrefs, SocialUser, WantSyncItem } from './types';

/** Operaciones del servicio social. Toda autorización se valida en el servidor (RLS + funciones). */
export interface SocialBackend {
  kind: 'supabase' | 'fake';
  currentUser(): Promise<SocialUser | null>;
  onAuthChange(fn: (u: SocialUser | null) => void): () => void;
  signUp(email: string, password: string, displayName: string): Promise<SocialUser>;
  signIn(email: string, password: string): Promise<SocialUser>;
  signOut(): Promise<void>;
  changePassword(password: string): Promise<void>;
  deleteAccount(): Promise<void>;
  getDisplayName(): Promise<string | undefined>;
  setDisplayName(name: string): Promise<void>;

  listContacts(): Promise<Contact[]>;
  updateContact(id: string, patch: Partial<Pick<Contact, 'alias' | 'favorite' | 'shareMatches' | 'shareScores' | 'shareInterests' | 'shareRatings' | 'notifyMatches'>>): Promise<void>;
  removeContact(id: string): Promise<void>;
  blockContact(id: string): Promise<void>;
  unblockContact(id: string): Promise<void>;

  createInvite(): Promise<{ code: string; expiresAt: number }>;
  listInvites(): Promise<Invite[]>;
  revokeInvite(id: string): Promise<void>;
  peekInvite(code: string): Promise<{ inviterName: string; expiresAt: number }>;
  acceptInvite(code: string, alias?: string): Promise<{ contact: string; alias: string }>;
  declineInvite(code: string): Promise<void>;

  send(input: SendInput): Promise<{ id: string; createdAt: number }>;
  retract(id: string): Promise<boolean>;
  listSent(): Promise<SentRec[]>;
  listInbox(): Promise<InboxRec[]>;
  getInboxRec(id: string): Promise<InboxRec | undefined>;
  markSeen(ids: string[]): Promise<void>;
  setArchived(id: string, archived: boolean): Promise<void>;
  /** Avisa de recomendaciones nuevas o retiradas (tiempo real o sondeo). Devuelve la función para cancelar. */
  subscribeInbox(onInsert: (id: string) => void, onDelete: (id: string) => void): () => void;

  syncWant(items: WantSyncItem[]): Promise<{ added: number; removed: number }>;
  clearWant(): Promise<void>;
  getMatches(contact: string): Promise<Match[]>;

  // v4.3 · intereses compartidos
  getPrefs(): Promise<SocialPrefs>;
  setPrefs(p: Partial<SocialPrefs>): Promise<void>;
  /** Lote de cambios propios (idempotente; el servidor decide qué se puede guardar). */
  putShared(items: PutItem[]): Promise<PutResult[]>;
  /** Foto completa de lo que mis contactos me autorizan a ver. */
  getShared(): Promise<SharedRow[]>;
  /** Eventos para mí (cambios compartidos y coincidencias) en tiempo real o por sondeo. */
  subscribeEvents(onEvent: (e: SocialEvent) => void): () => void;
  notifyEvents(ids: number[]): Promise<void>;

  savePush(sub: PushSubscriptionJSON): Promise<void>;
  deletePush(endpoint: string): Promise<void>;
  notify(recId: string): Promise<void>;
}
