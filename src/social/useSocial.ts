import { useSyncExternalStore } from 'react';
import { getSocial, subscribeSocial, type SocialState } from './store';

/** Estado social (sesión, contactos, bandeja). No dispara cargas: el estado se inicializa en segundo plano. */
export function useSocial(): SocialState {
  return useSyncExternalStore(subscribeSocial, getSocial, getSocial);
}
