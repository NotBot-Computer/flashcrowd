import { useCallback, useEffect, useState } from 'react'
import {
  ActivityList,
  Dashboard,
  GroupDetail,
  GroupList,
  Section,
  ServiceList,
  SimulationNotice,
  StatusChip,
} from './Dashboard'
import { Drawer } from './Drawer'
import { FundAgent } from './FundAgent'
import { Logo } from './Logo'
import { groupEvents, serviceTitle } from './model'
import { NetworkBanner } from './NetworkBanner'
import { SourceBar } from './SourceBar'
import { useDashboard } from './useDashboard'
import { connectWallet, type Session } from './wallet'
import { WalletChecks } from './WalletChecks'

const PAGES = [
  { id: 'overview', href: '#/', label: 'Overview' },
  { id: 'groups', href: '#/groups', label: 'Groups' },
  { id: 'services', href: '#/services', label: 'Services' },
  { id: 'activity', href: '#/activity', label: 'Activity' },
  { id: 'checks', href: '#/checks', label: 'Wallet checks' },
] as const

type Page = (typeof PAGES)[number]['id']

const pageFromHash = (): Page => PAGES.find((p) => p.href === window.location.hash)?.id ?? 'overview'

export function App() {
  const [session, setSession] = useState<Session>()
  const [error, setError] = useState<string>()
  const [connecting, setConnecting] = useState(false)
  const [page, setPage] = useState<Page>(pageFromHash)
  const [selectedGroup, setSelectedGroup] = useState<string>()
  const [funding, setFunding] = useState(false)
  const { data, source, retry } = useDashboard()
  const health = source.kind === 'live' ? source.health : undefined
  const closeGroup = useCallback(() => setSelectedGroup(undefined), [])
  const closeFunding = useCallback(() => setFunding(false), [])

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // The network is read at Connect wallet. Switching it happens in BSV Desktop, so read it again whenever the user
  // comes back to this page.
  useEffect(() => {
    if (session === undefined) return
    const onFocus = () => {
      session.wallet
        .getNetwork({})
        .then(({ network }) => {
          if (network !== session.network) setSession({ ...session, network })
        })
        .catch(() => {
          // A locked or closed wallet: keep what we have; the next wallet call reports it.
        })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [session])

  async function onConnect() {
    setConnecting(true)
    setError(undefined)
    try {
      setSession(await connectWallet())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConnecting(false)
    }
  }

  const simulation = source.kind === 'simulation'
  const group = data?.groups.find((g) => g.id === selectedGroup)
  const groupTitle = (serviceId: string) => {
    const s = data?.services.find((x) => x.id === serviceId)
    return s ? serviceTitle(s.title, s.simulation) : serviceId
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1>
          <a href="#/" aria-label="FlashCrowd">
            <Logo />
          </a>
        </h1>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={p.href} aria-current={page === p.id ? 'page' : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="secondary" onClick={() => setFunding(true)}>
            Fund an agent
          </button>
          {session ? (
            <span className="wallet" title={session.identityKey}>
              <StatusChip
                label={session.network}
                tone={session.network === 'mainnet' ? 'success' : 'warning'}
              />
              <code>{session.identityKey.slice(0, 10)}…</code>
            </span>
          ) : (
            <button onClick={onConnect} disabled={connecting}>
              {connecting ? 'Waiting for the wallet…' : 'Connect wallet'}
            </button>
          )}
          <SourceBar source={source} />
        </div>
      </aside>

      <main className="content">
        <NetworkBanner wallet={session?.network} server={health?.network} />
        {error && <p role="alert">{error}</p>}

        {data && page === 'overview' && (
          <Dashboard
            data={data}
            health={health}
            simulationReason={simulation ? source.reason : undefined}
            onRetry={simulation ? retry : undefined}
            onSelectGroup={setSelectedGroup}
          />
        )}
        {data && page !== 'overview' && page !== 'checks' && simulation && (
          <SimulationNotice reason={source.reason} onRetry={retry} />
        )}
        {data && page === 'groups' && (
          <Section label="Groups" count={data.groups.length}>
            <GroupList groups={data.groups} services={data.services} onSelect={setSelectedGroup} />
          </Section>
        )}
        {data && page === 'services' && (
          <Section label="Services" count={data.services.length}>
            <ServiceList services={data.services} />
          </Section>
        )}
        {data && page === 'activity' && (
          <Section label="Activity" count={data.feed.length}>
            <ActivityList items={data.feed} />
          </Section>
        )}
        {page === 'checks' &&
          (session ? (
            <WalletChecks ctx={session} />
          ) : (
            <p className="empty">Connect your wallet to run the checks.</p>
          ))}
      </main>

      {group && data && (
        <Drawer title="Purchase group" onClose={closeGroup}>
          <GroupDetail
            group={group}
            title={groupTitle(group.serviceId)}
            simulation={data.simulation}
            events={groupEvents(data.feed, group.id)}
          />
        </Drawer>
      )}
      {funding && (
        <Drawer title="Fund an agent" onClose={closeFunding}>
          <FundAgent session={session} serverNetwork={health?.network} />
        </Drawer>
      )}
    </div>
  )
}
