// What the agent needs from the FlashCrowd coordinator: the API of apps/server (its README, "API" and "An agent's
// calls"). One method per endpoint. The server learns the caller from BRC-103 auth, so no method takes the agent's
// identity key, and the coordinator never holds the agent's funds.
import type {
  ClaimProof,
  FundingContribution,
  GroupStatus,
  NewIntent,
  PurchaseGroup,
  PurchaseIntent,
  RefundProof,
  ServiceOffer,
} from '@agentswap/core'

/** `GET /api/groups/:id`: the group with a link for every transaction the server knows was sent. */
export interface Group extends PurchaseGroup {
  transactions?: {
    kind: 'funding' | 'claim' | 'refund'
    txid: string
    wocUrl: string
    identityKey?: string
  }[]
}

export interface Settlement {
  groupId: string
  status: GroupStatus
  refundHeight?: number
  /** The server's word that refunds are final now (one block after refundHeight). */
  refundAvailable: boolean
  claim?: ClaimProof
  /** Hex AtomicBEEF of the claim, so the agent reads K from the transaction itself. */
  claimTx?: string
  refunds: RefundProof[]
}

/** The server said no: `status` is the HTTP status, `message` its `{ error }`. */
export class CoordinatorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'CoordinatorError'
  }
}

export interface Coordinator {
  /** GET /api/services */
  services(): Promise<ServiceOffer[]>
  /** POST /api/intents (auth): `group` once the intent matched. */
  createIntent(intent: NewIntent): Promise<{ intent: PurchaseIntent; group?: Group }>
  /** GET /api/groups?intentId=: without ciphertext and BEEFs. */
  groupsForIntent(intentId: string): Promise<PurchaseGroup[]>
  /** GET /api/groups/:id */
  group(id: string): Promise<Group>
  /** POST /api/groups/:id/authorize (auth) */
  authorize(groupId: string): Promise<PurchaseGroup>
  /** POST /api/groups/:id/contributions (auth): without BEEF; 409 until the group is committed. */
  submitContribution(groupId: string, contribution: FundingContribution): Promise<{ refundSignature: string }>
  /** POST /api/groups/:id/funding (auth): the broadcast contribution with its BEEF. */
  submitFunding(groupId: string, contribution: FundingContribution): Promise<PurchaseGroup>
  /** GET /api/groups/:id/settlement */
  settlement(groupId: string): Promise<Settlement>
  /** POST /api/groups/:id/refunds (auth): 409 while the network does not know the refund yet. */
  reportRefund(groupId: string, txid: string): Promise<PurchaseGroup>
  /** POST /api/events (auth): one line for the live feed. */
  report(event: { message: string; txid?: string }): Promise<void>
}
