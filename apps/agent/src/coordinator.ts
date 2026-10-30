// What the agent needs from the FlashCrowd coordinator (apps/server, P2). Each method is one endpoint of the API in
// docs/FLASHCROWD_PLAN.md; this file is the agent's side of that contract, to agree with P2. The server learns the
// caller from BRC-103 auth, so no method takes the agent's identity key, and the coordinator never holds its funds.
import type {
  ClaimProof,
  FundingContribution,
  GroupStatus,
  NewIntent,
  PurchaseGroup,
  PurchaseIntent,
  ServiceOffer,
} from '@agentswap/core'

export interface Settlement {
  status: GroupStatus
  /** Once claimed. */
  claim?: ClaimProof
  /** Hex AtomicBEEF (or raw hex) of the claim, so the agent reads K from the transaction itself. */
  claimTx?: string
}

export interface Coordinator {
  /** GET /api/services */
  services(): Promise<ServiceOffer[]>
  /** POST /api/intents (auth). The server sets agentIdentityKey from auth and tries to match. */
  createIntent(intent: NewIntent): Promise<PurchaseIntent>
  /** GET /api/intents/:id: the intent and, once matched, its group. */
  intent(id: string): Promise<{ intent: PurchaseIntent; groupId?: string }>
  /** GET /api/groups/:id */
  group(id: string): Promise<PurchaseGroup>
  /** POST /api/groups/:id/authorize (auth) */
  authorize(groupId: string): Promise<void>
  /** POST /api/groups/:id/contributions (auth): the contribution without BEEF; the seller's refund signature back. */
  submitContribution(groupId: string, contribution: FundingContribution): Promise<{ refundSignature: string }>
  /** POST /api/groups/:id/funding (auth): the broadcast contribution with its BEEF. */
  submitFunding(groupId: string, contribution: FundingContribution): Promise<void>
  /** GET /api/groups/:id/settlement */
  settlement(groupId: string): Promise<Settlement>
  /** POST /api/events (auth): one line for the live feed. */
  report(event: { message: string; txid?: string }): Promise<void>
}
