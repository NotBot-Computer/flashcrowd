import { StatusChip } from './Dashboard'
import type { Source } from './useDashboard'

const FEED_LABEL = {
  connecting: 'Feed connecting…',
  open: 'Feed connected',
  reconnecting: 'Feed reconnecting…',
}

/** Where the dashboard's data comes from right now. Simulation is explained by the dashboard's own notice. */
export function SourceBar({ source }: { source: Source }) {
  if (source.kind === 'loading') return <p className="source-bar muted">Loading from the server…</p>
  if (source.kind === 'simulation') return null
  // With the history route the feed arrives every 5 s, whatever the event stream does.
  const feedOk = source.feed === 'open' || source.feedPolled === true
  const feedLabel = source.feed !== 'open' && source.feedPolled ? 'Feed every 5 s' : FEED_LABEL[source.feed]
  return (
    <p className="source-bar">
      <StatusChip label="Live" tone="success" pulse />
      {source.health && (
        <span className="muted">
          {source.health.network} · block {source.health.height.toLocaleString('en')}
        </span>
      )}
      <span className={feedOk ? 'muted' : 'source-warning'}>{feedLabel}</span>
    </p>
  )
}
