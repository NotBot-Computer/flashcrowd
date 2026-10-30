import { MIN_CONTRIBUTION_SATS, type ServiceOffer } from '@agentswap/core'
import type { DashboardData } from './mock'
import {
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

/** The FlashCrowd dashboard: services, purchase groups and the live feed. Reading needs no wallet. */
export function Dashboard({
  data,
  simulationReason,
  onRetry,
}: {
  data: DashboardData
  /** Why the page fell back to simulation data, e.g. the server is unreachable. */
  simulationReason?: string
  onRetry?: () => void
}) {
  const service = (id: string) => data.services.find((s) => s.id === id)
  return (
    <div className="dashboard">
      {data.simulation && (
        <div className="notice" role="note">
          <p>
            <strong>Simulation.</strong> This is sample data, not from the server. Nothing here is on chain, so no
            transaction links are shown.
          </p>
          {simulationReason && <p className="notice-reason">Reason: {simulationReason}</p>}
          {onRetry && (
            <button className="secondary" onClick={onRetry}>
              Retry the server
            </button>
          )}
        </div>
      )}
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <section className="panel">
            <h2 className="label">Services</h2>
            {data.services.length === 0 ? (
              <p className="muted">No services yet.</p>
            ) : (
              <ul className="services">
                {data.services.map((s) => (
                  <ServiceRow key={s.id} service={s} />
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2 className="label section-label">
              Purchase groups <span className="count">{data.groups.length}</span>
            </h2>
            {data.groups.length === 0 ? (
              <p className="panel muted empty">
                No purchase groups yet. A group appears when agents post intents for a service.
              </p>
            ) : (
              <div className="groups">
                {data.groups.map((g) => {
                  const s = service(g.serviceId)
                  return (
                    <GroupCard
                      key={g.id}
                      group={g}
                      title={s ? serviceTitle(s.title, s.simulation) : g.serviceId}
                      simulation={data.simulation}
                    />
                  )
                })}
              </div>
            )}
          </section>
        </div>
        <FeedPanel items={data.feed} />
      </div>
    </div>
  )
}

export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className="chip">
      <span className={`dot tone-${tone}`} aria-hidden="true" />
      {label}
    </span>
  )
}

function ServiceRow({ service }: { service: ServiceOffer }) {
  return (
    <li className="service">
      <div className="service-main">
        <div className="service-title">
          <strong>{serviceTitle(service.title, service.simulation)}</strong>
          {service.simulation && <StatusChip label="simulation" tone="warning" />}
        </div>
        <span className="muted">
          <code>{service.resourceId}</code> · seller <code>{shortKey(service.sellerIdentityKey)}</code>
        </span>
      </div>
      <div className="service-figures">
        <strong>{formatSats(service.priceSats)}</strong>
        <span className="muted">
          up to {maxBuyers(service.priceSats)} buyers · min share {formatSats(MIN_CONTRIBUTION_SATS)}
        </span>
      </div>
    </li>
  )
}

const TRANSACTION_LABEL = { funding: 'Funding', claim: 'Claim', refund: 'Refund' }

export function GroupCard({ group, title, simulation }: { group: GroupView; title: string; simulation: boolean }) {
  const status = groupStatus(group.status)
  const progress = fundingProgress(group)
  const buyers = group.participants.length
  return (
    <article className="panel group">
      <div className="group-top">
        <code className="group-id" title={group.id}>
          {shortGroupId(group.id)}
        </code>
        <StatusChip label={status.label} tone={status.tone} />
      </div>
      <strong className="group-title">{title}</strong>

      <div>
        <div className="progress-label">
          <span>Funded</span>
          <span>
            {formatSats(fundedSats(group))} of {formatSats(group.priceSats)} · {buyers}{' '}
            {buyers === 1 ? 'buyer' : 'buyers'}
          </span>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>

      <table className="participants">
        <thead>
          <tr>
            <th>Buyer</th>
            <th>Share</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {group.participants.map((p) => (
            <tr key={p.identityKey}>
              <td>
                <code title={p.identityKey}>{shortKey(p.identityKey)}</code>
              </td>
              <td>{p.shareSats > 0 ? formatSats(p.shareSats) : 'not set'}</td>
              <td>{participantStatus(p.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="transactions">
        <span className="label">Transactions</span>
        {group.transactions.length > 0 ? (
          <ul>
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
          <span className="muted">{simulation ? 'None in simulation' : 'None yet'}</span>
        )}
      </div>
    </article>
  )
}

export function FeedPanel({ items, now = Date.now() }: { items: FeedItem[]; now?: number }) {
  const newestFirst = [...items].sort((a, b) => b.id - a.id)
  return (
    <aside className="panel feed">
      <h2 className="label">Live feed</h2>
      {newestFirst.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <ol>
          {newestFirst.map((e) => (
            <li key={e.id}>
              <span className={`dot feed-${e.type}`} aria-hidden="true" />
              <div className="feed-body">
                <span className="feed-message">{e.message}</span>
                <span className="feed-meta">
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
      )}
    </aside>
  )
}
