// BSV-21 tokens on top of the kit's TokenKit (src/kit/client/token.ts): deploy, balances, sync and transfers.
import { wocTxUrl } from './config'
import { tokenKit, type CoreContext } from './context'
import { selectUtxos } from './kit/client/coinselect'
import type { TokenBalance } from './kit/client/token'
import type { Outpoint, TokenId } from './types'

export type { TokenBalance } from './kit/client/token'

export interface TxResult {
  txid: string
  /** The transaction on WhatsOnChain. */
  wocUrl: string
}

export interface SyncResult {
  /** Outputs the overlay credits to this wallet, now taken into the basket. */
  inserted: Outpoint[]
  /** Basket outputs the overlay has seen spent, now dropped. */
  relinquished: Outpoint[]
  /** Transactions re-submitted to the overlay from chain. */
  healed: string[]
  /** Basket outputs the overlay refuses: never spent. */
  unvalidated: Outpoint[]
}

/** Deploys a BSV-21 token; its one `deploy+mint` output holds the whole supply. */
export async function deployToken(
  ctx: CoreContext,
  args: { sym: string; supply: bigint; dec: number; icon?: string },
): Promise<TxResult & { tokenId: TokenId }> {
  const { txid, tokenId } = await tokenKit(ctx).deploy({
    sym: args.sym,
    amt: args.supply,
    dec: args.dec,
    icon: args.icon,
  })
  return { txid, tokenId, wocUrl: wocTxUrl(txid, ctx.network) }
}

/** Per token: what the overlay credits to this wallet and what its `bsv21` basket holds. */
export async function getBalances(ctx: CoreContext): Promise<TokenBalance[]> {
  return await tokenKit(ctx).balances()
}

/** Brings the basket in line with the overlay: the only way received tokens reach the basket. */
export async function syncTokens(ctx: CoreContext): Promise<SyncResult> {
  return await tokenKit(ctx).sync()
}

/**
 * Sends `amount` of `tokenId` to an identity key. Like the kit's `send`, it spends only UTXOs the overlay vouches
 * for, and it skips the outpoints in `exclude` (the UTXOs behind the maker's open offers), so a transfer never
 * cancels an offer.
 */
export async function sendTokens(
  ctx: CoreContext,
  tokenId: TokenId,
  amount: bigint,
  to: string,
  { exclude = [] }: { exclude?: readonly Outpoint[] } = {},
): Promise<TxResult> {
  if (amount <= 0n) throw new Error('amount must be positive')
  const kit = tokenKit(ctx)
  const skip = new Set(exclude)
  const { entries, beef } = await kit.spendable(tokenId)
  const { selected, total } = selectUtxos(
    entries.filter((e) => !skip.has(e.outpoint)),
    amount,
  )
  const { txid } = await kit.spendInputs(
    selected,
    beef,
    tokenId,
    [{ to, amount }, ...(total > amount ? [{ to: 'self' as const, amount: total - amount }] : [])],
    `Send ${amount} tokens`,
  )
  return { txid, wocUrl: wocTxUrl(txid, ctx.network) }
}
