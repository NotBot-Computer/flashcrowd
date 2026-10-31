import { useState, type ReactNode } from 'react'
import { MIN_CONTRIBUTION_SATS, type HtlcContext } from '@agentswap/core'
import {
  abortPreparedFunding,
  checkHashSignature,
  checkTermsSignature,
  prepareHtlcFunding,
  sendPreparedFunding,
  type CheckResult,
  type PreparedFunding,
} from './checks'
import { StatusChip } from './Dashboard'

type Status =
  { state: 'idle' } | { state: 'running' } | { state: 'done'; result: CheckResult; wocUrl?: string }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The BSV Desktop feasibility checks from docs/FLASHCROWD_PLAN.md, one row per wallet call FlashCrowd needs. */
export function WalletChecks({ ctx }: { ctx: HtlcContext }) {
  const [hash, setHash] = useState<Status>({ state: 'idle' })
  const [terms, setTerms] = useState<Status>({ state: 'idle' })
  const [prepare, setPrepare] = useState<Status>({ state: 'idle' })
  const [send, setSend] = useState<Status>({ state: 'idle' })
  const [prepared, setPrepared] = useState<PreparedFunding>()

  async function run(set: (s: Status) => void, check: () => Promise<CheckResult & { wocUrl?: string }>) {
    set({ state: 'running' })
    try {
      const result = await check()
      set({ state: 'done', result, wocUrl: result.wocUrl })
    } catch (e) {
      set({ state: 'done', result: { ok: false, detail: message(e) } })
    }
  }

  const onPrepare = () =>
    run(setPrepare, async () => {
      const funding = await prepareHtlcFunding(ctx)
      setPrepared(funding)
      setSend({ state: 'idle' })
      return { ok: true, detail: `signed, not broadcast: ${funding.txid.slice(0, 16)}…` }
    })

  const onSend = () =>
    run(setSend, async () => {
      const result = await sendPreparedFunding(ctx, prepared!.txid)
      if (result.ok) setPrepared(undefined)
      return result
    })

  async function onAbort() {
    try {
      await abortPreparedFunding(ctx, prepared!.txid)
      setPrepared(undefined)
      setPrepare({ state: 'idle' })
    } catch (e) {
      setPrepare({ state: 'done', result: { ok: false, detail: `abort failed: ${message(e)}` } })
    }
  }

  return (
    <section className="page">
      <h2 className="page-title">Wallet checks</h2>
      <p className="muted">
        Each check makes the same wallet call FlashCrowd makes. Approve the requests in BSV Desktop.
      </p>
      <ol className="checks">
        <CheckRow
          title="Sign a raw hash"
          call="createSignature({ hashToDirectlySign }) · flashcrowd htlc"
          note="Seller's refund and claim signatures. No coins needed."
          status={hash}
          action={<button onClick={() => run(setHash, () => checkHashSignature(ctx))}>Run</button>}
        />
        <CheckRow
          title="Sign group terms"
          call="createSignature({ data }) · flashcrowd terms"
          note="Seller signs the group terms. No coins needed."
          status={terms}
          action={<button onClick={() => run(setTerms, () => checkTermsSignature(ctx))}>Run</button>}
        />
        <CheckRow
          title="Prepare an HTLC funding"
          call="createAction · custom locking script · noSend"
          note={`Locks ${MIN_CONTRIBUTION_SATS.toLocaleString('en')} sats in an HTLC to your own key. Needs coins in the wallet.`}
          status={prepare}
          action={
            <button onClick={onPrepare} disabled={prepared !== undefined}>
              Run
            </button>
          }
        />
        <CheckRow
          title="Broadcast the prepared funding"
          call="createAction({ sendWith })"
          note="Sends the transaction from the previous check."
          status={send}
          action={
            <span className="actions">
              <button onClick={onSend} disabled={prepared === undefined}>
                Run
              </button>
              <button className="secondary" onClick={onAbort} disabled={prepared === undefined}>
                Abort
              </button>
            </span>
          }
        />
      </ol>
    </section>
  )
}

function CheckRow(props: { title: string; call: string; note: string; status: Status; action: ReactNode }) {
  const { status } = props
  return (
    <li className="check">
      <div>
        <strong>{props.title}</strong>
        <code>{props.call}</code>
        <span className="muted">{props.note}</span>
        {status.state === 'done' && (
          <span className={status.result.ok ? 'result-ok' : 'result-fail'}>
            {status.result.detail}
            {status.wocUrl && (
              <>
                {' · '}
                <a href={status.wocUrl} target="_blank" rel="noreferrer">
                  WhatsOnChain
                </a>
              </>
            )}
          </span>
        )}
      </div>
      <div className="check-side">
        <StatusBadge status={status} />
        {status.state === 'running' ? <button disabled>Waiting…</button> : props.action}
      </div>
    </li>
  )
}

function StatusBadge({ status }: { status: Status }) {
  if (status.state === 'idle') return <StatusChip label="Not run" tone="neutral" />
  if (status.state === 'running') return <StatusChip label="Running" tone="progress" />
  return status.result.ok ? (
    <StatusChip label="Pass" tone="success" />
  ) : (
    <StatusChip label="Fail" tone="danger" />
  )
}
