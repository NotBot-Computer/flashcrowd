// The agent's hard spending limits, checked in code before its wallet signs a funding. Nothing an LLM says can
// change the outcome: it only sees the decision.
import type { HtlcTerms, PurchaseIntent, SpendPolicy } from './types'

export class SpendPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpendPolicyError'
  }
}

export interface SpendRequest {
  terms: HtlcTerms
  /** The agent's identity key. */
  identityKey: string
  /** The agent's own intent the group was matched from. */
  intent: PurchaseIntent
  currentHeight: number
  /** What the agent has committed so far. */
  spentSats: number
}

export type SpendDecision = { ok: true; shareSats: number } | { ok: false; reason: string }

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

export function checkSpend(policy: SpendPolicy, request: SpendRequest): SpendDecision {
  const { terms, identityKey, intent, currentHeight, spentSats } = request
  const no = (reason: string): SpendDecision => ({ ok: false, reason })
  if (![policy.maxPerPurchaseSats, policy.maxTotalSats, policy.maxLockBlocks, spentSats].every(isCount)) {
    return no('the policy or the running total is not a whole number of sats')
  }
  if (!policy.allowedServiceIds.includes(terms.serviceId))
    return no(`service ${terms.serviceId} is not allowed`)
  if (intent.agentIdentityKey !== identityKey) return no('the intent belongs to another agent')
  if (intent.network !== terms.network) return no('the terms are on another network')
  if (
    policy.requireMatchingResource &&
    (intent.serviceId !== terms.serviceId || intent.resourceId !== terms.resourceId)
  ) {
    return no('the terms are for another resource than the intent')
  }
  const share = terms.shares.find((s) => s.identityKey === identityKey)?.shareSats
  if (share === undefined) return no('the agent has no share in these terms')
  if (!Number.isSafeInteger(share) || share <= 0) return no('the share is not a whole number of sats')
  if (share > intent.maxContributionSats)
    return no(`share ${share} is above the intent's ${intent.maxContributionSats}`)
  if (share > policy.maxPerPurchaseSats) return no(`share ${share} is above the per-purchase cap`)
  if (spentSats + share > policy.maxTotalSats) return no(`share ${share} would exceed the total cap`)
  const lockBlocks = terms.refundHeight - currentHeight
  if (lockBlocks <= 0) return no('the refund height has already passed')
  if (lockBlocks > policy.maxLockBlocks) return no(`the money would be locked for ${lockBlocks} blocks`)
  return { ok: true, shareSats: share }
}

/** The share the agent may fund, or a SpendPolicyError. Call it before every funding signature. */
export function assertSpend(policy: SpendPolicy, request: SpendRequest): number {
  const decision = checkSpend(policy, request)
  if (!decision.ok) throw new SpendPolicyError(decision.reason)
  return decision.shareSats
}
