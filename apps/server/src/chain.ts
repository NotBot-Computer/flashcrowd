// What the coordinator reads from the network. Tests pass the mock chain instead.
import { ARCADE_URL, type Network } from '@agentswap/core'
import type { ChainTracker } from '@bsv/sdk'

export interface ChainView {
  currentHeight(): Promise<number>
  /** The raw transaction if the network knows it. */
  getRawTx(txid: string): Promise<number[] | undefined>
  /** For verifyFunding's SPV check; core defaults to Arcade when undefined. */
  tracker?: ChainTracker
}

export function arcadeChain(
  network: Network,
  getRawTx: (txid: string) => Promise<{ rawTx?: number[] }>,
): ChainView {
  return {
    async currentHeight() {
      const res = await fetch(`${ARCADE_URL[network]}/chaintracks/v2/height`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`Arcade height request failed (${res.status})`)
      const { height } = (await res.json()) as { height: unknown }
      if (!Number.isSafeInteger(height)) throw new Error('Arcade returned no height')
      return height as number
    },
    getRawTx: async (txid) => (await getRawTx(txid)).rawTx,
  }
}
