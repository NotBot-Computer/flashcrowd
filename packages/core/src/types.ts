// Shared contract between core (P1), server (P2), web (P3) and agent (P4).
// Drafted before the event: change it in a pull request and tell the team, since every part depends on it.

import type { Network } from './config'

/** BSV-21 token id: `<deploy txid>_<vout>`. */
export type TokenId = string

/** BRC-100 outpoint: `<txid>.<vout>`. */
export type Outpoint = string

export type OfferStatus = 'open' | 'filled' | 'cancelled'

/** A maker's signed, fillable offer: `tokenAmount` of `tokenId` for `priceSats`. */
export interface Offer {
  /** The token UTXO being sold; doubles as the offer id. */
  id: Outpoint
  network: Network
  tokenId: TokenId
  /** Whole amount in the token's base units, as a decimal string (no float rounding). */
  tokenAmount: string
  /** Satoshis the maker receives in output 0. */
  priceSats: number
  makerIdentityKey: string
  /** Hex locking script of output 0, which pays the maker. */
  payToLockingScript: string
  /** Hex unlocking script for input 0: the maker's SIGHASH_SINGLE | ANYONECANPAY signature and public key. */
  unlockingScript: string
  /** Hex BEEF of the transaction that created the token UTXO, for the taker's SPV check. */
  sourceBeef: string
  status: OfferStatus
  /** ISO 8601 */
  createdAt: string
  fillTxid?: string
}

/** What a maker submits; the server sets status and createdAt. */
export type NewOffer = Omit<Offer, 'status' | 'createdAt' | 'fillTxid'>

/** The cheapest open offers that together cover `tokenAmount`. */
export interface Quote {
  tokenId: TokenId
  tokenAmount: string
  offers: Offer[]
  totalSats: number
}

/** One entry of the live feed (server-sent events). */
export interface FeedEvent {
  type: 'offer' | 'fill' | 'cancel' | 'payment' | 'agent' | 'intent' | 'group' | 'lock' | 'claim' | 'refund'
  message: string
  txid?: string
  /** ISO 8601 */
  at: string
}

// FlashCrowd (docs/FLASHCROWD_TASK.md). Satoshi amounts are safe integers, never floats.

/** A reusable digital resource a seller offers to a whole purchase group. */
export interface ServiceOffer {
  /** The serviceId. */
  id: string
  network: Network
  sellerIdentityKey: string
  title: string
  resourceId: string
  priceSats: number
  /** The seller lets the group share the result. */
  license: 'shared-within-group'
  /** Demo data: the UI labels it "simulation". */
  simulation: boolean
}

export type IntentStatus = 'open' | 'matched' | 'committed' | 'expired'

/** An agent wants `resourceId` of `serviceId` and pays at most `maxContributionSats` towards it. */
export interface PurchaseIntent {
  id: string
  network: Network
  /** Set by the server from BRC-103 auth, never from the request body. */
  agentIdentityKey: string
  serviceId: string
  resourceId: string
  maxContributionSats: number
  /** Unix ms */
  expiresAt: number
  status: IntentStatus
  /** ISO 8601 */
  createdAt: string
}

/** What an agent submits; the server sets the rest. */
export type NewIntent = Pick<
  PurchaseIntent,
  'network' | 'serviceId' | 'resourceId' | 'maxContributionSats' | 'expiresAt'
>

export type GroupStatus =
  | 'open'
  | 'matched'
  | 'committed'
  | 'funding'
  | 'locked'
  | 'claimed'
  | 'expired'
  | 'funding_failed'
  | 'refund_available'
  | 'refunded'
  | 'settlement_failed'

export type ParticipantStatus = 'joined' | 'authorized' | 'funded' | 'refunded'

export interface GroupParticipant {
  identityKey: string
  intentId: string
  /** From the intent: the most this agent pays. */
  maxContributionSats: number
  /** 0 until the group is matched; fixed from then on. */
  shareSats: number
  status: ParticipantStatus
  contribution?: FundingContribution
}

/** What the seller signs and every buyer verifies before paying. */
export interface HtlcTerms {
  groupId: string
  network: Network
  serviceId: string
  resourceId: string
  sellerIdentityKey: string
  /** The seller's HTLC key: protocol [1, 'flashcrowd htlc'], keyID groupId, counterparty 'anyone'. */
  sellerKey: string
  priceSats: number
  /** Sorted by identityKey; the shares add up to priceSats. */
  shares: { identityKey: string; shareSats: number }[]
  /** Hex sha256 of the secret K. */
  hash: string
  /** Hex sha256 of the ciphertext, published before anyone pays. */
  ciphertextHash: string
  /** Block height: the nLockTime of every refund. */
  refundHeight: number
  /** Hex DER signature of the seller's identity, [1, 'flashcrowd terms'], over the other fields. */
  signature: string
}

export type UnsignedTerms = Omit<HtlcTerms, 'signature'>

/** One buyer's HTLC output. Only these fields go to the seller before the refund signature is back. */
export interface FundingContribution {
  identityKey: string
  txid: string
  vout: number
  satoshis: number
  /** Hex */
  lockingScript: string
  /** Hex, checksig format: the seller's refund pre-signature, sighash 0xC2. */
  refundSignature?: string
  /** Hex AtomicBEEF of the funding; only after broadcast. */
  beef?: string
  status: 'prepared' | 'refund_signed' | 'broadcast' | 'verified'
}

export interface ClaimProof {
  txid: string
  wocUrl: string
  /** Hex K, as revealed on chain. */
  secret: string
  outpoints: Outpoint[]
}

export interface RefundProof {
  identityKey: string
  txid: string
  wocUrl: string
  outpoint: Outpoint
}

export interface PurchaseGroup {
  id: string
  network: Network
  serviceId: string
  resourceId: string
  priceSats: number
  participants: GroupParticipant[]
  terms?: HtlcTerms
  /** Hex */
  ciphertext?: string
  status: GroupStatus
  claim?: ClaimProof
  refunds: RefundProof[]
  /** ISO 8601 */
  createdAt: string
  /** Unix ms: the group expires unless committed by then. */
  expiresAt: number
}

/** Hard limits the agent's code checks before it signs anything (spendPolicy.ts). */
export interface SpendPolicy {
  maxPerPurchaseSats: number
  maxTotalSats: number
  allowedServiceIds: string[]
  /** The terms must name the resource the agent's intent asked for. */
  requireMatchingResource: boolean
  /** How long the money may stay locked: refundHeight minus the current height. */
  maxLockBlocks: number
}
