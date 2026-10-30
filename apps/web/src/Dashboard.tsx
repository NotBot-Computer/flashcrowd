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
  shortKey,
  type FeedItem,
  type GroupView,
} from './model'

/** The FlashCrowd dashboard: services, purchase groups and the live feed. Reading needs no wallet. */
export function Dashboard({ data }: { data: DashboardData }) {
  const titleOf = (serviceId: string) => data.services.find((s) => s.id === serviceId)?.title ?? serviceId
  return (
    <div className="dashboard">
      {data.simulation && (
        <p className="notice" role="note">
          <strong>Simulation.</strong> This is sample data, not from the server. Nothing here is on chain, so no
          transaction links are shown.
        </p>
      )}
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <section className="panel">
            <h2>Services</h2>
            <ul className="services">
              {data.services.map((s) => (
                <ServiceRow key={s.id} service={s} />
              ))}
            </ul>
          </section>
          <section>
            <h2 className="section-title">Purchase groups</h2>
            <div className="groups">
              {data.groups.map((g) => (
                <GroupCard key={g.id} group={g} title={titleOf(g.serviceId)} simulation={data.simulation} />
              ))}
            </div>
          </section>
        </div>
        <FeedPanel items={data.feed} />
      </div>
    </div>
  )
}

function ServiceRow({ service }: { service: ServiceOffer }) {
  return (
    <li className="service">
      <div>
        <strong>{service.title}</strong>
        {service.simulation && <span className="badge badge-simulation">simulation</span>}
        <span className="muted">
          <code>{service.resourceId}</code> · seller {shortKey(service.sellerIdentityKey)}
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

export function GroupCard({ group, title, simulation }: { group: GroupView; title: string; simulation: boolean }) {
  const status = groupStatus(group.status)
  const progress = fundingProgress(group)
  return (
    <article className="panel group">
      <header className="group-head">
        <div>
          <strong>{title}</strong>
          <span className="muted">
            {group.id} · {group.participants.length} {group.participants.length === 1 ? 'buyer' : 'buyers'}
          </span>
        </div>
        <span className={`badge tone-${status.tone}`}>{status.label}</span>
      </header>

      <div className="progress-label">
        <span>Funded</span>
        <span>
          {formatSats(fundedSats(group))} of {formatSats(group.priceSats)}
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
        <span className="transactions-title">Transactions</span>
        {group.transactions.length > 0 ? (
          <ul>
            {group.transactions.map((t) => (
              <li key={t.txid}>
                <span>{t.kind}</span>
                {t.identityKey && <code>{shortKey(t.identityKey)}</code>}
                <a href={t.wocUrl} target="_blank" rel="noreferrer">
                  {t.txid.slice(0, 12)}…
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

export function FeedPanel({ items }: { items: FeedItem[] }) {
  const newestFirst = [...items].sort((a, b) => b.id - a.id)
  return (
    <aside className="panel feed">
      <h2>Live feed</h2>
      {newestFirst.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <ol>
          {newestFirst.map((e) => (
            <li key={e.id}>
              <div className="feed-meta">
                <span className={`feed-type feed-${e.type}`}>{e.type}</span>
                <time dateTime={e.at}>{formatTime(e.at)}</time>
              </div>
              <span>{e.message}</span>
              {e.wocUrl && (
                <a href={e.wocUrl} target="_blank" rel="noreferrer">
                  WhatsOnChain
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}
