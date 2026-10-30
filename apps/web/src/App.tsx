import { useEffect, useState } from 'react'
import { Dashboard } from './Dashboard'
import { SourceBar } from './SourceBar'
import { useDashboard } from './useDashboard'
import { connectWallet, type Session } from './wallet'
import { WalletChecks } from './WalletChecks'

type Page = 'dashboard' | 'checks'

const pageFromHash = (): Page => (window.location.hash === '#/checks' ? 'checks' : 'dashboard')

export function App() {
  const [session, setSession] = useState<Session>()
  const [error, setError] = useState<string>()
  const [connecting, setConnecting] = useState(false)
  const [page, setPage] = useState<Page>(pageFromHash)
  const { data, source, retry } = useDashboard()

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

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

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <h1>AgentSwap</h1>
          <nav>
            <a href="#/" aria-current={page === 'dashboard' ? 'page' : undefined}>
              Dashboard
            </a>
            <a href="#/checks" aria-current={page === 'checks' ? 'page' : undefined}>
              Wallet checks
            </a>
          </nav>
        </div>
        {session ? (
          <span className={`badge badge-${session.network}`} title={session.identityKey}>
            {session.network} · {session.identityKey.slice(0, 10)}…
          </span>
        ) : (
          <button onClick={onConnect} disabled={connecting}>
            {connecting ? 'Waiting for the wallet…' : 'Connect wallet'}
          </button>
        )}
      </header>
      <main>
        {error && <p role="alert">{error}</p>}
        {page === 'dashboard' && (
          <>
            <SourceBar source={source} />
            {data && (
              <Dashboard
                data={data}
                simulationReason={source.kind === 'simulation' ? source.reason : undefined}
                onRetry={source.kind === 'simulation' ? retry : undefined}
              />
            )}
          </>
        )}
        {page === 'checks' &&
          (session ? (
            <WalletChecks ctx={session} />
          ) : (
            <p className="muted">Connect your wallet to run the checks.</p>
          ))}
      </main>
    </>
  )
}
