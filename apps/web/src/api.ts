import type { Network, PurchaseGroup, ServiceOffer } from '@agentswap/core'
import type { DashboardData } from './mock'
import type { FeedItem, GroupView } from './model'

// Every request the page makes to apps/server. Reading is open, so none of these needs a wallet. `/api` is served from
// the page's own origin (vite.config.ts proxies it), so there is no CORS and no server URL in the page.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface Health {
  ok: boolean
  network: Network
  height: number
}

type Fetch = typeof fetch

async function getJson<T>(path: string, fetchImpl: Fetch, check: (body: unknown) => boolean): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(path, { headers: { Accept: 'application/json' } })
  } catch (e) {
    throw new ApiError(`the server is unreachable (${e instanceof Error ? e.message : String(e)})`)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new ApiError(`${path} did not return JSON (HTTP ${res.status})`, res.status)
  }
  if (!res.ok) {
    const reason = (body as { error?: unknown })?.error
    throw new ApiError(`${path}: ${typeof reason === 'string' ? reason : `HTTP ${res.status}`}`, res.status)
  }
  if (!check(body)) throw new ApiError(`${path} returned an unexpected shape`, res.status)
  return body as T
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isList = (v: unknown) => Array.isArray(v) && v.every(isObject)

export const fetchHealth = (fetchImpl: Fetch = fetch) =>
  getJson<Health>('/health', fetchImpl, (b) => isObject(b) && typeof b.network === 'string')

export const fetchServices = (fetchImpl: Fetch = fetch) =>
  getJson<ServiceOffer[]>('/api/services', fetchImpl, isList)

export const fetchGroups = (fetchImpl: Fetch = fetch) => getJson<PurchaseGroup[]>('/api/groups', fetchImpl, isList)

/** One group with a WhatsOnChain link for every transaction the server knows was sent. */
export const fetchGroup = (id: string, fetchImpl: Fetch = fetch) =>
  getJson<GroupView>(
    `/api/groups/${encodeURIComponent(id)}`,
    fetchImpl,
    (b) => isObject(b) && Array.isArray(b.transactions),
  )

/** Services and every group with its transactions; newest group first. */
export async function loadDashboard(fetchImpl: Fetch = fetch): Promise<DashboardData> {
  const [services, list] = await Promise.all([fetchServices(fetchImpl), fetchGroups(fetchImpl)])
  const groups = await Promise.all(list.map((g) => fetchGroup(g.id, fetchImpl)))
  groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { services, groups, feed: [], simulation: false }
}

export type FeedStatus = 'connecting' | 'open' | 'reconnecting'

type EventSourceLike = Pick<EventSource, 'close'> & {
  onopen: ((ev: Event) => unknown) | null
  onerror: ((ev: Event) => unknown) | null
  onmessage: ((ev: MessageEvent) => unknown) | null
}

/**
 * Follows GET /api/feed. EventSource reconnects by itself and sends Last-Event-ID, so the server replays what was
 * missed. Returns a function that closes the stream.
 */
export function subscribeFeed(
  onEvent: (item: FeedItem) => void,
  onStatus: (status: FeedStatus) => void,
  open: (url: string) => EventSourceLike = (url) => new EventSource(url),
): () => void {
  const source = open('/api/feed')
  onStatus('connecting')
  source.onopen = () => onStatus('open')
  source.onerror = () => onStatus('reconnecting')
  source.onmessage = (e) => {
    try {
      const item = JSON.parse(e.data) as FeedItem
      if (typeof item.id === 'number' && typeof item.message === 'string') onEvent(item)
    } catch {
      // A malformed event is skipped; the stream goes on.
    }
  }
  return () => source.close()
}

const FEED_LIMIT = 200

/** Adds an event once (EventSource replays on reconnect), keeping the newest FEED_LIMIT. */
export function addFeedItem(items: FeedItem[], item: FeedItem): FeedItem[] {
  if (items.some((i) => i.id === item.id)) return items
  return [...items, item].sort((a, b) => a.id - b.id).slice(-FEED_LIMIT)
}
