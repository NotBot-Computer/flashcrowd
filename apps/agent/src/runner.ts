// Runs several agents at once and reports, for the terminal and the demo, what each one did.
import { MIN_CONTRIBUTION_SATS, wocTxUrl, type HtlcContext, type Network } from '@agentswap/core'
import { Utils } from '@bsv/sdk'
import type { AgentSettings } from './config'
import type { Coordinator } from './coordinator'
import { depositAddress } from './funding'
import { runPurchase, type AgentConfig, type PurchaseOutcome } from './flow'
import { readKeyFile, type AgentWallet } from './wallet'

/** Room for the funding transaction's fee on top of the share. */
export const FEE_MARGIN_SATS = 200

export interface AgentRun {
  ctx: HtlcContext
  coordinator: Coordinator
  config: AgentConfig
  spentSats: number
  /** Tests drive the chain from here; the default waits. */
  sleep?: (ms: number) => Promise<void>
}

export type RunOutcome = PurchaseOutcome | { status: 'error'; reason: string }

/** Runs every agent's purchase at the same time; one agent's failure does not stop the others. */
export async function runAgents(
  runs: AgentRun[],
  log: (line: string) => void = console.log,
): Promise<RunOutcome[]> {
  const settled = await Promise.allSettled(
    runs.map(
      async (run) =>
        await runPurchase(
          {
            ctx: run.ctx,
            coordinator: run.coordinator,
            spentSats: run.spentSats,
            sleep: run.sleep,
            log: (step, message) => log(`[${step}] ${message}`),
          },
          run.config,
        ),
    ),
  )
  return settled.map((s) =>
    s.status === 'fulfilled'
      ? s.value
      : { status: 'error', reason: (s.reason as Error)?.message ?? String(s.reason) },
  )
}

/** One line per agent, with WhatsOnChain links for its transactions. */
export function summarize(name: string, outcome: RunOutcome, network: Network): string {
  switch (outcome.status) {
    case 'decrypted':
      return (
        `${name}: paid ${outcome.shareSats} sats, decrypted ${outcome.data.length} bytes ` +
        `(${Utils.toUTF8(outcome.data).slice(0, 60)}…)\n  funding ${wocTxUrl(outcome.fundingTxid, network)}\n` +
        `  claim   ${wocTxUrl(outcome.claimTxid, network)}`
      )
    case 'refunded':
      return (
        `${name}: refunded its ${outcome.shareSats} sats\n  funding ${wocTxUrl(outcome.fundingTxid, network)}\n` +
        `  refund  ${wocTxUrl(outcome.refundTxid, network)}`
      )
    case 'refused':
      return `${name}: refused, nothing signed (${outcome.reason})`
    case 'unmatched':
      return `${name}: no purchase, nothing paid (${outcome.reason})`
    case 'error':
      return `${name}: stopped with an error: ${outcome.reason}`
  }
}

export interface Readiness {
  name: string
  identityKey: string
  depositAddress: string
  balance: number
  /** The agent's offer plus room for fees. */
  needed: number
  ready: boolean
}

/** --check: each agent's identity, deposit address and whether its balance covers its offer. */
export async function checkAgents(
  agents: AgentSettings[],
  network: Network,
  open: (agent: AgentSettings) => Promise<AgentWallet>,
): Promise<Readiness[]> {
  const report: Readiness[] = []
  for (const agent of agents) {
    const rootKey = readKeyFile(agent.keyFile)
    const wallet = await open(agent)
    try {
      const balance = await wallet.wallet.balance()
      const needed = Math.max(agent.maxContributionSats, MIN_CONTRIBUTION_SATS) + FEE_MARGIN_SATS
      report.push({
        name: agent.name,
        identityKey: wallet.identityKey,
        depositAddress: depositAddress(rootKey, network),
        balance,
        needed,
        ready: balance >= needed,
      })
    } finally {
      await wallet.close()
    }
  }
  return report
}
