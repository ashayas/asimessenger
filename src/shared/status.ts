export type Presence = 'online' | 'busy' | 'away' | 'offline'

export const PRESENCE_LABEL: Record<Presence, string> = {
  online: 'Online',
  busy: 'Busy',
  away: 'Away',
  offline: 'Offline'
}
