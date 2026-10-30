import { MIN_CONTRIBUTION_SATS, type ServiceOffer } from '@agentswap/core'
import type { ReactNode } from 'react'
import type { Health } from './api'
import type { DashboardData } from './mock'
import {
  dashboardStats,
  formatSats,
  formatTime,
  fundedSats,
  fundingProgress,
  groupStatus,
  maxBuyers,
  participantStatus,
  serviceTitle,
  shortGroupId,
  shortKey,
  timeAgo,
  type FeedItem,
  type GroupView,
  type Tone,
} from './model'

// The FlashCrowd pages: no boxes, sections divided by hairlines, dense rows like an issue tracker.

/** A coloured dot. Something still under way (tone progress, or `pulse`) breathes slowly. */
function Dot({ tone, pulse = tone === 'progress' }: { tone: Tone; pulse?: boolean }) {
  return <span className={`dot tone-${tone}${pulse ? ' pulse' : ''}`} aria-hidden="true" />
}

// Keyed by label where they are used, so a change of status mounts a new element and plays its entrance once.

export function StatusChip({ label, tone, pulse }: { label: string; tone: Tone; pulse?: boolean }) {
  return (
    <span className="chip">
      <Dot tone={tone} pulse={pulse} />
      {label}
    </span>
  )
}

/** A dot and a label, without the chip's border, for dense rows. */
function StatusLabel({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className="status-label">
      <Dot tone={tone} />
      {label}
    </span>
  )
}

export function SimulationNotice({ reason, onRetry }: { reason?: string; onRetry?: () => void }) {
  return (
    <div className="notice" role="note">
      <p>
        <strong>Simulation.</strong> This is sample data, not from the server. Nothing here is on chain, so no
        transaction links are shown.
      </p>
      {reason && <p className="notice-reason">Reason: {reason}</p>}
      {onRetry && (
        <button className="secondary" onClick={onRetry}>
          Retry the server
        </button>
      )}
    </div>
  )
}

/** A section: a monospace label, a count, an optional link, then its rows. */
export function Section(props: {
  label: string
  count?: number
  more?: { href: string; text: string }
  children: ReactNode
}) {
  return (
    <section className="section">
      <header className="section-head">
        <h2 className="label">
          {props.label}
          {props.count !== undefined && <span className="count">{props.count}</span>}
        </h2>
        {props.more && <a href={props.more.href}>{props.more.text}</a>}
      </header>
      {props.children}
    </section>
  )
}

const titleOf = (services: ServiceOffer[], serviceId: string) => {
  const s = services.find((x) => x.id === serviceId)
  return s ? serviceTitle(s.title, s.simulation) : serviceId
}

/** The overview: what FlashCrowd is, the numbers, then the latest groups, services and events. */
export function Dashboard({
  data,
  health,
  simulationReason,
  onRetry,
  onSelectGroup = () => {},
  now = Date.now(),
}: {
  data: DashboardData
  health?: Health
  /** Why the page fell back to simulation data, e.g. the server is unreachable. */
  simulationReason?: string
  onRetry?: () => void
  onSelectGroup?: (id: string) => void
  now?: number
}) {
  const stats = dashboardStats(data.groups)
  return (
    <div className="overview">
      <div className="hero">
        <p className="label hero-eyebrow">
          <Dot tone="success" pulse />
          Group buying for AI agents on BSV
        </p>
        <h2>
          Agents buy data <em>together.</em>
        </h2>
        <p className="hero-lede">
          The seller is paid only by <strong>revealing the key on chain</strong>. Until then, each
          agent&apos;s share stays locked in its own output.
        </p>
        <ol className="hero-steps">
          <li>
            <span>01</span>Agents pool their shares
          </li>
          <li>
            <span>02</span>The seller reveals the key
          </li>
          <li>
            <span>03</span>Agents decrypt the data
          </li>
        </ol>
      </div>

      {data.simulation && <SimulationNotice reason={simulationReason} onRetry={onRetry} />}

      <dl className="stats">
        <Stat label="sats funded" value={stats.fundedSats.toLocaleString('en')} />
        <Stat label="groups" value={stats.groups} />
        <Stat label="claimed" value={stats.claimed} />
        <Stat label="refunded" value={stats.refunded} />
        <Stat label="agents" value={stats.agents} />
        {health && <Stat label={`block · ${health.network}`} value={health.height.toLocaleString('en')} />}
      </dl>

      <Section label="Groups" count={data.groups.length} more={{ href: '#/groups', text: 'All groups' }}>
        <GroupList
          groups={data.groups.slice(0, 6)}
          services={data.services}
          onSelect={onSelectGroup}
          now={now}
        />
      </Section>

      <div className="split">
        <Section
          label="Services"
          count={data.services.length}
          more={{ href: '#/services', text: 'All services' }}
        >
          <ServiceList services={data.services} />
        </Section>
        <Section label="Activity" more={{ href: '#/activity', text: 'All activity' }}>
          <ActivityList items={data.feed} limit={6} now={now} />
        </Section>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      {/* Keyed by value: a new number fades in. */}
      <dd key={value}>{value}</dd>
      <dt>{label}</dt>
    </div>
  )
}

export function GroupList({
  groups,
  services,
  onSelect,
  now = Date.now(),
}: {
  groups: GroupView[]
  services: ServiceOffer[]
  onSelect: (id: string) => void
  now?: number
}) {
  if (groups.length === 0) {
    return (
      <p className="empty">No purchase groups yet. A group appears when agents post intents for a service.</p>
    )
  }
  return (
    <ul className="rows">
      {groups.map((g) => {
        const status = groupStatus(g.status)
        const buyers = g.participants.length
        return (
          <li key={g.id}>
            <button className="row group-row" onClick={() => onSelect(g.id)}>
              <StatusLabel key={status.label} label={status.label} tone={status.tone} />
              <code className="row-id" title={g.id}>
                {shortGroupId(g.id)}
              </code>
              <span className="row-title">{titleOf(services, g.serviceId)}</span>
              <span className="row-progress" aria-hidden="true">
                <span style={{ width: `${fundingProgress(g) * 100}%` }} />
              </span>
              <span className="row-amount">
                {fundedSats(g).toLocaleString('en')} / {formatSats(g.priceSats)}
              </span>
              <span className="row-meta">
                {buyers} {buyers === 1 ? 'buyer' : 'buyers'}
              </span>
              <span className="row-meta row-time">{timeAgo(g.createdAt, now)}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function ServiceList({ services }: { services: ServiceOffer[] }) {
  if (services.length === 0) return <p className="empty">No services yet.</p>
  return (
    <ul className="rows">
      {services.map((s) => (
        <li key={s.id} className="row service-row">
          <div className="service-main">
            <span className="row-title">{serviceTitle(s.title, s.simulation)}</span>
            <span className="row-meta service-meta">
              {s.simulation && <StatusChip label="simulation" tone="warning" />}
              <span>
                <code>{s.resourceId}</code> · seller <code>{shortKey(s.sellerIdentityKey)}</code>
              </span>
            </span>
          </div>
          <div className="service-figures">
            <span className="row-amount">{formatSats(s.priceSats)}</span>
            <span className="row-meta">
              up to {maxBuyers(s.priceSats)} buyers · min {formatSats(MIN_CONTRIBUTION_SATS)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ActivityList({
  items,
  limit,
  now = Date.now(),
}: {
  items: FeedItem[]
  limit?: number
  now?: number
}) {
  const newestFirst = [...items].sort((a, b) => b.id - a.id).slice(0, limit)
  if (newestFirst.length === 0) return <p className="empty">No events yet.</p>
  return (
    <ol className="timeline">
      {newestFirst.map((e) => (
        <li key={e.id}>
          <span className={`dot feed-${e.type}`} aria-hidden="true" />
          <div className="timeline-body">
            <span className="timeline-message">{e.message}</span>
            <span className="row-meta">
              {e.type} ·{' '}
              <time dateTime={e.at} title={formatTime(e.at)}>
                {timeAgo(e.at, now)}
              </time>
              {e.wocUrl && (
                <>
                  {' · '}
                  <a href={e.wocUrl} target="_blank" rel="noreferrer">
                    WhatsOnChain
                  </a>
                </>
              )}
            </span>
          </div>
        </li>
      ))}
    </ol>
  )
}

const TRANSACTION_LABEL = { funding: 'Funding', claim: 'Claim', refund: 'Refund' }

/** Everything about one group, shown in the side panel: the numbers, the buyers, the transactions, the events. */
export function GroupDetail({
  group,
  title,
  simulation,
  events,
  now = Date.now(),
}: {
  group: GroupView
  title: string
  simulation: boolean
  events: FeedItem[]
  now?: number
}) {
  const status = groupStatus(group.status)
  const progress = fundingProgress(group)
  return (
    <div className="detail">
      <div className="detail-head">
        <code className="row-id" title={group.id}>
          {shortGroupId(group.id)}
        </code>
        <StatusChip key={status.label} label={status.label} tone={status.tone} />
      </div>
      <h3 className="detail-title">{title}</h3>

      <dl className="facts">
        <div>
          <dt>Price</dt>
          <dd>{formatSats(group.priceSats)}</dd>
        </div>
        <div>
          <dt>Funded</dt>
          <dd>{formatSats(fundedSats(group))}</dd>
        </div>
        <div>
          <dt>Buyers</dt>
          <dd>{group.participants.length}</dd>
        </div>
        {group.terms && (
          <div>
            <dt>Refund from block</dt>
            <dd>{group.terms.refundHeight.toLocaleString('en')}</dd>
          </div>
        )}
      </dl>

      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
      </div>

      <h4 className="label">Buyers</h4>
      <table className="participants">
        <tbody>
          {group.participants.map((p) => (
            <tr key={p.identityKey}>
              <td>
                <code title={p.identityKey}>{shortKey(p.identityKey)}</code>
              </td>
              <td>{p.shareSats > 0 ? formatSats(p.shareSats) : 'not set'}</td>
              <td className="muted">{participantStatus(p.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 className="label">Transactions</h4>
      {group.transactions.length > 0 ? (
        <ul className="transactions">
          {group.transactions.map((t) => (
            <li key={t.txid}>
              <span>{TRANSACTION_LABEL[t.kind]}</span>
              <code className="muted">{t.identityKey ? shortKey(t.identityKey) : 'seller'}</code>
              <a href={t.wocUrl} target="_blank" rel="noreferrer" title={t.txid}>
                <code>{t.txid.slice(0, 12)}…</code>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">{simulation ? 'None in simulation' : 'None yet'}</p>
      )}

      <h4 className="label">Activity</h4>
      <ActivityList items={events} now={now} />
    </div>
  )
}
