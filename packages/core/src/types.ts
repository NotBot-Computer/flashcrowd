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
  type: 'offer' | 'fill' | 'cancel' | 'payment' | 'agent'
  message: string
  txid?: string
  /** ISO 8601 */
  at: string
}

/** Hard limits the agent's code checks before it signs anything. */
export interface SpendPolicy {
  maxSatsPerTx: number
  maxSatsPerTask: number
  /** Hosts the agent may pay. */
  allowedHosts: string[]
}
