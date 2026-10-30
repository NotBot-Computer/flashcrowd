import { Utils } from '@bsv/sdk'
import { wocTxUrl, type HtlcContext, type Network } from '@agentswap/core'
// Not exported from @agentswap/core's index yet; replace with the package import once P1 exports it.
import { createBrc29Payment, type Brc29Payment } from '../../../packages/core/src/kit/client/payments'

// "Fund the agent" (docs/FLASHCROWD_PLAN.md, P3 step 6): the user's wallet pays the agent's identity key with BRC-29.
// The output is locked to a one-time key derived from the agent's identity key, so the agent only finds it with the
// derivation data. The page hands that over as a payment file, which the agent takes in with core's
// acceptBrc29Payment. Without the file the agent cannot see the payment, so the page saves it at once.

/** Smallest payment the form accepts: an agent's share must be at least MIN_CONTRIBUTION_SATS, plus fees. */
export const MIN_FUNDING_SATS = 1_000
/** Largest: a typo must not empty the wallet on mainnet. */
export const MAX_FUNDING_SATS = 100_000

const IDENTITY_KEY = /^0[23][0-9a-f]{64}$/

/**
 * What the agent needs to take the payment in. The Brc29Payment fields are as core's acceptBrc29Payment expects
 * them, so `acceptBrc29Payment(wallet, file)` works on the parsed file as it is.
 */
export interface PaymentFile extends Brc29Payment {
  kind: 'flashcrowd agent funding'
  version: 1
  network: Network
  recipientIdentityKey: string
  wocUrl: string
  /** ISO 8601 */
  createdAt: string
}

/** Why the form cannot send yet, or undefined when it can. */
export function fundingProblem(agentKey: string, sats: number, ownIdentityKey?: string): string | undefined {
  const key = agentKey.trim().toLowerCase()
  if (!IDENTITY_KEY.test(key)) return 'The agent identity key is 66 hex characters starting with 02 or 03.'
  if (ownIdentityKey !== undefined && key === ownIdentityKey) return 'That is your own identity key.'
  if (!Number.isSafeInteger(sats)) return 'The amount is a whole number of sats.'
  if (sats < MIN_FUNDING_SATS) return `Send at least ${MIN_FUNDING_SATS.toLocaleString('en')} sats.`
  if (sats > MAX_FUNDING_SATS) return `Send at most ${MAX_FUNDING_SATS.toLocaleString('en')} sats at a time.`
  return undefined
}

/** Pays `sats` to the agent's identity key with BRC-29; the wallet signs and broadcasts. */
export async function fundAgent(ctx: HtlcContext, agentKey: string, sats: number): Promise<PaymentFile> {
  const recipientIdentityKey = agentKey.trim().toLowerCase()
  const { publicKey: ownIdentityKey } = await ctx.wallet.getPublicKey({ identityKey: true }, ctx.originator)
  const problem = fundingProblem(recipientIdentityKey, sats, ownIdentityKey)
  if (problem !== undefined) throw new Error(problem)
  const payment = await createBrc29Payment(
    ctx.wallet,
    recipientIdentityKey,
    sats,
    'Fund a FlashCrowd agent',
    ctx.originator,
  )
  return {
    kind: 'flashcrowd agent funding',
    version: 1,
    network: ctx.network,
    recipientIdentityKey,
    ...payment,
    wocUrl: wocTxUrl(payment.txid, ctx.network),
    createdAt: new Date().toISOString(),
  }
}

export const paymentFileName = (file: PaymentFile) => `flashcrowd-payment-${file.txid.slice(0, 12)}.json`

export const paymentFileJson = (file: PaymentFile) => JSON.stringify(file, null, 2)

/** Hex of the AtomicBEEF, for anyone checking the file by hand. */
export const paymentTxHex = (file: PaymentFile) => Utils.toHex(file.tx)

const STORAGE_KEY = 'flashcrowd.payments'

/** This browser's copy of every payment file, newest first. Storage can be missing or blocked: then it is empty. */
export function savedPayments(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): PaymentFile[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as PaymentFile[]) : []
  } catch {
    return []
  }
}

/** Keeps a copy in this browser, in case the download is lost. Returns false when storage is unavailable. */
export function savePayment(
  file: PaymentFile,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage,
): boolean {
  try {
    const others = savedPayments(storage).filter((p) => p.txid !== file.txid)
    storage!.setItem(STORAGE_KEY, JSON.stringify([file, ...others]))
    return true
  } catch {
    return false
  }
}
