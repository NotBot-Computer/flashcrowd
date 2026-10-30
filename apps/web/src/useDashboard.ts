import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addFeedItem,
  fetchFeedSince,
  fetchHealth,
  loadDashboard,
  subscribeFeed,
  type FeedStatus,
  type Health,
} from './api'
import { mockData, type DashboardData } from './mock'
import type { FeedItem } from './model'

export type Source =
  | { kind: 'loading' }
  /** feedPolled: the server answers GET /api/feed/history, so the feed arrives even without the event stream. */
  | { kind: 'live'; health?: Health; feed: FeedStatus; feedPolled?: boolean }
  /** The server could not be read: the page shows simulation data and why. */
  | { kind: 'simulation'; reason: string }

/** Feed events come in bursts (a group matching, three locks); one reload covers a burst. */
const RELOAD_DELAY_MS = 600
/**
 * Reload anyway this often. A cloudflared tunnel holds back the event stream, so the groups and the feed's history are
 * read again every 5 s: a group's steps and its events then still show.
 */
const POLL_MS = 5_000

/**
 * The dashboard's data: the server's when it answers, simulation data and the reason when it does not. Every feed
 * event reloads the groups, so funding bars and statuses move as the agents act.
 */
export function useDashboard() {
  const [data, setData] = useState<DashboardData>()
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [source, setSource] = useState<Source>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** The newest feed event seen, from the stream or the history: the next history read starts after it. */
  const lastEventId = useRef(0)

  const addEvents = useCallback((items: FeedItem[]) => {
    if (items.length === 0) return
    lastEventId.current = Math.max(lastEventId.current, ...items.map((i) => i.id))
    setFeed((current) => items.reduce(addFeedItem, current))
  }, [])

  const reload = useCallback(async () => {
    try {
      setData(await loadDashboard())
    } catch {
      // Keep what is on screen; the next event or retry tries again.
    }
  }, [])

  const readFeedHistory = useCallback(async () => {
    try {
      const items = await fetchFeedSince(lastEventId.current)
      if (items === undefined) return
      addEvents(items)
      setSource((s) => (s.kind === 'live' && !s.feedPolled ? { ...s, feedPolled: true } : s))
    } catch {
      // The stream or the next poll tries again.
    }
  }, [addEvents])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    setSource({ kind: 'loading' })

    Promise.all([loadDashboard(), fetchHealth().catch(() => undefined)])
      .then(([live, health]) => {
        if (cancelled) return
        setData(live)
        setFeed([])
        lastEventId.current = 0
        setSource({ kind: 'live', health, feed: 'connecting' })
        unsubscribe = subscribeFeed(
          (item) => {
            addEvents([item])
            clearTimeout(reloadTimer.current)
            reloadTimer.current = setTimeout(reload, RELOAD_DELAY_MS)
          },
          (status) => setSource((s) => (s.kind === 'live' ? { ...s, feed: status } : s)),
        )
        void readFeedHistory()
        poll = setInterval(() => {
          void reload()
          void readFeedHistory()
        }, POLL_MS)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const sample = mockData()
        setData(sample)
        setFeed(sample.feed)
        setSource({ kind: 'simulation', reason: e instanceof Error ? e.message : String(e) })
      })

    return () => {
      cancelled = true
      unsubscribe?.()
      clearInterval(poll)
      clearTimeout(reloadTimer.current)
    }
  }, [attempt, reload, readFeedHistory, addEvents])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { data: data && { ...data, feed }, source, retry }
}
