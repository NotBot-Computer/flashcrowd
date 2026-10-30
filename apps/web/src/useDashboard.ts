import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addFeedItem,
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
  | { kind: 'live'; health?: Health; feed: FeedStatus }
  /** The server could not be read: the page shows simulation data and why. */
  | { kind: 'simulation'; reason: string }

/** Feed events come in bursts (a group matching, three locks); one reload covers a burst. */
const RELOAD_DELAY_MS = 600
/** Reload anyway this often, in case a tunnel holds back the feed's events: a group's steps then still show. */
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

  const reload = useCallback(async () => {
    try {
      setData(await loadDashboard())
    } catch {
      // Keep what is on screen; the next event or retry tries again.
    }
  }, [])

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
        setSource({ kind: 'live', health, feed: 'connecting' })
        unsubscribe = subscribeFeed(
          (item) => {
            setFeed((items) => addFeedItem(items, item))
            clearTimeout(reloadTimer.current)
            reloadTimer.current = setTimeout(reload, RELOAD_DELAY_MS)
          },
          (status) => setSource((s) => (s.kind === 'live' ? { ...s, feed: status } : s)),
        )
        poll = setInterval(reload, POLL_MS)
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
  }, [attempt, reload])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { data: data && { ...data, feed }, source, retry }
}
