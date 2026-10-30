// Funding an agent from the web app: a person pays the agent's identity key with BRC-29 from BSV Desktop, and the
// page downloads a "payment file". The agent checks that the file is meant for it and takes the payment in.
import { wocTxUrl, type Network } from '@agentswap/core'
import { Transaction, type ChainTracker, type WalletInterface } from '@bsv/sdk'
// Not exported from core's index yet (asked of P1); imported by path until then.
import { acceptBrc29Payment, type Brc29Payment } from '../../../packages/core/src/kit/client/payments'

export const FUNDING_KIND = 'flashcrowd agent funding'

/** What apps/web's funding page downloads: a core Brc29Payment plus who and where it is for. */
export interface AgentFundingFile extends Brc29Payment {
  kind: typeof FUNDING_KIND
  version: 1
  network: Network
  recipientIdentityKey: string
  wocUrl?: string
  createdAt?: string
}

export interface Received {
  satoshis: number
  txid: string
  wocUrl: string
}

const HEX32 = /^[0-9a-f]{64}$/
const PUBKEY = /^0[23][0-9a-f]{64}$/

/** Shape of a funding file as read from disk; throws with the first thing wrong. */
export function parseFundingFile(json: unknown): AgentFundingFile {
  const f = json as Partial<AgentFundingFile> | null
  const fail = (reason: string): never => {
    throw new Error(`not a FlashCrowd funding file: ${reason}`)
  }
  if (f === null || typeof f !== 'object') fail('not a JSON object')
  if (f!.kind !== FUNDING_KIND) fail(`kind is ${JSON.stringify(f!.kind)}, not "${FUNDING_KIND}"`)
  if (f!.version !== 1) fail(`version ${JSON.stringify(f!.version)} is not supported`)
  if (f!.network !== 'testnet' && f!.network !== 'mainnet') fail('unknown network')
  if (!PUBKEY.test(String(f!.recipientIdentityKey)) || !PUBKEY.test(String(f!.senderIdentityKey))) {
    fail('bad identity key')
  }
  if (!Array.isArray(f!.tx) || !f!.tx.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) fail('bad tx')
  if (!HEX32.test(String(f!.txid))) fail('bad txid')
  if (!Number.isSafeInteger(f!.outputIndex) || f!.outputIndex! < 0) fail('bad outputIndex')
  if (!Number.isSafeInteger(f!.satoshis) || f!.satoshis! <= 0) fail('satoshis must be a positive integer')
  if (typeof f!.derivationPrefix !== 'string' || typeof f!.derivationSuffix !== 'string')
    fail('bad derivation')
  return f as AgentFundingFile
}

/**
 * Checks that the file is for this agent and this network, then takes the payment into the wallet with
 * acceptBrc29Payment: SPV against `chainTracker`, the output locked to the agent's BRC-29 key, the amount.
 */
export async function receiveFunding(
  wallet: WalletInterface,
  network: Network,
  json: unknown,
  chainTracker: ChainTracker,
): Promise<Received> {
  const file = parseFundingFile(json)
  if (file.network !== network) {
    throw new Error(`the payment is on ${file.network}, this agent runs on ${network}`)
  }
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  if (file.recipientIdentityKey !== publicKey) {
    throw new Error(`the payment is for ${file.recipientIdentityKey}, not this agent (${publicKey})`)
  }
  let txid: string
  try {
    txid = Transaction.fromAtomicBEEF(file.tx).id('hex')
  } catch {
    throw new Error('not a FlashCrowd funding file: tx is not an AtomicBEEF')
  }
  if (txid !== file.txid) throw new Error('not a FlashCrowd funding file: tx and txid differ')
  const { tx, txid: id, outputIndex, satoshis, derivationPrefix, derivationSuffix, senderIdentityKey } = file
  await acceptBrc29Payment(
    wallet,
    { tx, txid: id, outputIndex, satoshis, derivationPrefix, derivationSuffix, senderIdentityKey },
    chainTracker,
    'FlashCrowd agent funding',
  )
  return { satoshis, txid, wocUrl: wocTxUrl(txid, network) }
}
