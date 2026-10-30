// Refunds what a run left locked (the process stopped, or the coordinator went away), from the ledger alone: the
// terms and the contribution with the seller's refund signature are saved when the agent funds.
import { refundContribution, type HtlcContext } from '@agentswap/core'
import { readLedger, recordInLedger } from './ledger'

export interface Recovery {
  groupId: string
  fundingTxid: string
  status: 'refunded' | 'waiting' | 'failed'
  refundTxid?: string
  message: string
}

/**
 * For every share in the ledger still marked funded: refunds it once the chain is above its refundHeight, and
 * records the refund. `report` tells the coordinator, if there is one; its failure does not matter.
 */
export async function recoverRefunds(
  ctx: HtlcContext,
  ledgerFile: string,
  report?: (groupId: string, txid: string) => Promise<unknown>,
): Promise<Recovery[]> {
  const open = readLedger(ledgerFile).filter((e) => e.status === 'funded')
  const { height } = await ctx.wallet.getHeight({}, ctx.originator)
  const results: Recovery[] = []
  for (const e of open) {
    const base = { groupId: e.groupId, fundingTxid: e.fundingTxid }
    if (e.terms === undefined || e.contribution === undefined) {
      results.push({ ...base, status: 'failed', message: 'the ledger has no refund data for this share' })
      continue
    }
    if (height <= e.terms.refundHeight) {
      results.push({
        ...base,
        status: 'waiting',
        message: `refundable above block ${e.terms.refundHeight}; the chain is at ${height}`,
      })
      continue
    }
    try {
      const refund = await refundContribution(ctx, e.terms, e.contribution)
      recordInLedger(ledgerFile, { fundingTxid: e.fundingTxid, status: 'refunded', settledTxid: refund.txid })
      await report?.(e.groupId, refund.txid).catch(() => undefined)
      results.push({ ...base, status: 'refunded', refundTxid: refund.txid, message: refund.wocUrl })
    } catch (err) {
      // A share the seller claimed cannot be refunded; its key is on chain, and the server's settlement has it.
      results.push({ ...base, status: 'failed', message: (err as Error).message })
    }
  }
  return results
}
