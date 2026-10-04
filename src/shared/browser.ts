export interface TabState {
  id: number
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserState {
  tabs: TabState[]
  active: number | null
}

/** What you typed in the address bar -> a URL. Hosts and localhost ports become http(s); anything else is a search. */
export function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return 'about:blank'
  if (/^https?:\/\//i.test(s)) return s
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s) && !/\s/.test(s)) return `https://${s}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`
}

/** The in-app browser only ever navigates to the web (and a blank page). */
export function isAllowedNavigation(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}(?:\/[^\s)<>"'`]*)?/gi

/** Local dev-server links an agent mentioned in its text. */
export function findLocalUrls(text: string): string[] {
  return [...new Set((text.match(LOCAL_URL) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))]
}

/** Height of our own chrome (title bar + tab strip + address bar); web content sits below it. */
export const BROWSER_CHROME_HEIGHT = 96
