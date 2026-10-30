// What every core function takes: the caller's wallet and our BSV-21 overlay. The same code runs against BSV Desktop
// in the browser and against the agent's wallet-toolbox wallet.
import type { WalletInterface } from '@bsv/sdk'
import type { Network } from './config'
import { ARCADE_MAINNET, ARCADE_TESTNET } from './kit/client/arcadeChainTracker'
import { memoryOutbox, OverlayClient } from './kit/client/overlayApi'
import { TokenKit } from './kit/client/token'

export interface CoreContext {
  /** `new WalletClient('auto')` in the browser, a wallet-toolbox wallet in Node. */
  wallet: WalletInterface
  network: Network
  /** Our BSV-21 overlay (apps/overlay). */
  overlayUrl: string
  /** Node only: the app's domain. */
  originator?: string
}

const kits = new WeakMap<CoreContext, TokenKit>()

/**
 * The kit's TokenKit for `ctx`, built once per context object, so its overlay outbox (submissions still to retry,
 * kept in order) and the cached identity key carry over from one call to the next.
 */
export function tokenKit(ctx: CoreContext): TokenKit {
  let kit = kits.get(ctx)
  if (kit === undefined) {
    const overlay =
      ctx.network === 'testnet'
        ? new OverlayClient(ctx.overlayUrl, memoryOutbox(), 'test', ARCADE_TESTNET)
        : new OverlayClient(ctx.overlayUrl, memoryOutbox(), 'main', ARCADE_MAINNET)
    kit = new TokenKit(ctx.wallet, overlay, ctx.originator)
    kits.set(ctx, kit)
  }
  return kit
}
