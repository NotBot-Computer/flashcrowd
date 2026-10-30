import { useState } from 'react'
import type { Network } from '@agentswap/core'
import {
  fundAgent,
  fundingProblem,
  MIN_FUNDING_SATS,
  paymentFileJson,
  paymentFileName,
  savedPayments,
  savePayment,
  type PaymentFile,
} from './funding'
import { formatSats, shortKey } from './model'
import type { Session } from './wallet'

type State =
  | { step: 'form' }
  | { step: 'sending' }
  | { step: 'sent'; file: PaymentFile; savedInBrowser: boolean }
  | { step: 'failed'; error: string }

function download(file: PaymentFile) {
  const url = URL.createObjectURL(new Blob([paymentFileJson(file)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = paymentFileName(file)
  a.click()
  URL.revokeObjectURL(url)
}

/** "Fund the agent": the user's wallet pays an agent's identity key with BRC-29. */
export function FundAgent({ session, serverNetwork }: { session?: Session; serverNetwork?: Network }) {
  const [agentKey, setAgentKey] = useState('')
  const [amount, setAmount] = useState(String(MIN_FUNDING_SATS * 5))
  const [state, setState] = useState<State>({ step: 'form' })
  const [history, setHistory] = useState(() => savedPayments())

  if (session === undefined) {
    return (
      <section className="panel fund">
        <h2>Fund an agent</h2>
        <p className="muted">Connect your wallet to pay an agent's identity key from BSV Desktop.</p>
      </section>
    )
  }

  const sats = Number(amount)
  const wrongNetwork = serverNetwork !== undefined && serverNetwork !== session.network
  const problem = agentKey === '' ? undefined : fundingProblem(agentKey, sats, session.identityKey)
  const canSend = agentKey !== '' && problem === undefined && !wrongNetwork && state.step !== 'sending'

  async function onSend() {
    setState({ step: 'sending' })
    try {
      const file = await fundAgent(session!, agentKey, sats)
      // Saved before anything else can fail: without the file the agent cannot see the payment.
      const savedInBrowser = savePayment(file)
      download(file)
      setHistory(savedPayments())
      setState({ step: 'sent', file, savedInBrowser })
      setAgentKey('')
    } catch (e) {
      setState({ step: 'failed', error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <section className="panel fund">
      <h2>Fund an agent</h2>
      <p className="muted">
        Pays the agent's identity key from your wallet with BRC-29. The page then saves a payment file: the agent
        takes the payment in with it.
      </p>

      <div className="fund-form">
        <label>
          <span>Agent identity key</span>
          <input
            value={agentKey}
            onChange={(e) => setAgentKey(e.target.value)}
            placeholder="02… or 03…, 66 characters"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="fund-amount">
          <span>Amount (sats)</span>
          <input
            type="number"
            min={MIN_FUNDING_SATS}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button onClick={onSend} disabled={!canSend}>
          {state.step === 'sending' ? 'Waiting for the wallet…' : 'Send'}
        </button>
      </div>
      {problem && <p className="field-error">{problem}</p>}
      {wrongNetwork && <p className="field-error">Sending is off until your wallet is on {serverNetwork}.</p>}
      {session.network === 'mainnet' && !wrongNetwork && (
        <p className="muted">This is mainnet: the payment is real BSV and cannot be undone.</p>
      )}

      {state.step === 'failed' && <p role="alert">The payment did not go through: {state.error}</p>}

      {state.step === 'sent' && (
        <div className="fund-result">
          <p>
            <strong>Sent {formatSats(state.file.satoshis)}</strong> to {shortKey(state.file.recipientIdentityKey)}
            {' · '}
            <a href={state.file.wocUrl} target="_blank" rel="noreferrer">
              WhatsOnChain
            </a>
          </p>
          <p>
            The payment file <code>{paymentFileName(state.file)}</code> has downloaded. Give it to the agent's
            operator: the agent cannot see the payment without it.
            {state.savedInBrowser ? ' A copy is kept in this browser.' : ' This browser could not keep a copy.'}
          </p>
          <div className="actions">
            <button className="secondary" onClick={() => download(state.file)}>
              Download again
            </button>
            <button
              className="secondary"
              onClick={() => navigator.clipboard?.writeText(paymentFileJson(state.file))}
            >
              Copy as JSON
            </button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <details className="fund-history">
          <summary>Payment files in this browser ({history.length})</summary>
          <ul>
            {history.map((p) => (
              <li key={p.txid}>
                <span>
                  {formatSats(p.satoshis)} to <code>{shortKey(p.recipientIdentityKey)}</code> · {p.network}
                </span>
                <button className="secondary" onClick={() => download(p)}>
                  Download
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
