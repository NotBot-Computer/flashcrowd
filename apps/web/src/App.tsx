import { useState } from 'react'
import { connectWallet, type Session } from './wallet'
import { WalletChecks } from './WalletChecks'

// Scaffold only: P3 builds the Swap, Sell and Agent pages during the event (apps/web/README.md, issue #4).
export function App() {
  const [session, setSession] = useState<Session>()
  const [error, setError] = useState<string>()
  const [connecting, setConnecting] = useState(false)

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
      <header>
        <h1>AgentSwap</h1>
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
        <p>Swap-and-pay rails for AI agents on BSV.</p>
        {session && <WalletChecks ctx={session} />}
      </main>
    </>
  )
}
