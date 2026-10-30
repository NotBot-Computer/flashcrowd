// The agent's spending limits, checked in code.
import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { assertSpend, checkSpend, SpendPolicyError, type SpendRequest } from '../src/spendPolicy'
import type { HtlcTerms, SpendPolicy } from '../src/types'

const me = PrivateKey.fromRandom().toPublicKey().toString()
const other = PrivateKey.fromRandom().toPublicKey().toString()

const policy: SpendPolicy = {
  maxPerPurchaseSats: 5_000,
  maxTotalSats: 10_000,
  allowedServiceIds: ['premium-data'],
  requireMatchingResource: true,
  maxLockBlocks: 144,
}

const terms = {
  groupId: 'group-1',
  network: 'testnet',
  serviceId: 'premium-data',
  resourceId: 'bsvusd-2026-10',
  priceSats: 7_000,
  shares: [
    { identityKey: me, shareSats: 3_000 },
    { identityKey: other, shareSats: 4_000 },
  ],
  refundHeight: 1_100,
} as HtlcTerms

const request = (overrides: Partial<SpendRequest> = {}): SpendRequest => ({
  terms,
  identityKey: me,
  intent: {
    id: 'intent-1',
    network: 'testnet',
    agentIdentityKey: me,
    serviceId: 'premium-data',
    resourceId: 'bsvusd-2026-10',
    maxContributionSats: 3_000,
    expiresAt: 0,
    status: 'matched',
    createdAt: '',
  },
  currentHeight: 1_000,
  spentSats: 0,
  ...overrides,
})

describe('checkSpend', () => {
  it('allows a share within every limit', () => {
    expect(checkSpend(policy, request())).toEqual({ ok: true, shareSats: 3_000 })
    expect(assertSpend(policy, request())).toBe(3_000)
  })

  it('refuses a service that is not allowed', () => {
    expect(checkSpend(policy, request({ terms: { ...terms, serviceId: 'other' } })).ok).toBe(false)
  })

  it('refuses terms for another resource than the intent', () => {
    const d = checkSpend(policy, request({ terms: { ...terms, resourceId: 'other' } }))
    expect(d).toMatchObject({ ok: false, reason: expect.stringMatching(/another resource/) })
    expect(
      checkSpend(
        { ...policy, requireMatchingResource: false },
        request({ terms: { ...terms, resourceId: 'other' } }),
      ).ok,
    ).toBe(true)
  })

  it("refuses a share above the intent's maximum, the per-purchase cap or the total cap", () => {
    const bigger = { ...terms, shares: [{ identityKey: me, shareSats: 6_000 }, terms.shares[1]] }
    expect(checkSpend({ ...policy, maxPerPurchaseSats: 10_000 }, request({ terms: bigger }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/intent/),
    })
    const intent = { ...request().intent, maxContributionSats: 6_000 }
    expect(checkSpend(policy, request({ terms: bigger, intent }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/per-purchase/),
    })
    expect(checkSpend(policy, request({ spentSats: 7_001 }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/total/),
    })
    expect(checkSpend(policy, request({ spentSats: 7_000 })).ok).toBe(true)
  })

  it('refuses a lock longer than allowed, or a refund height in the past', () => {
    expect(checkSpend(policy, request({ currentHeight: 955 })).ok).toBe(false)
    expect(checkSpend(policy, request({ currentHeight: 956 })).ok).toBe(true)
    expect(checkSpend(policy, request({ currentHeight: 1_100 })).ok).toBe(false)
  })

  it('refuses when the agent has no share, the intent is not its own, or amounts are not integers', () => {
    expect(
      checkSpend(policy, request({ identityKey: PrivateKey.fromRandom().toPublicKey().toString() })).ok,
    ).toBe(false)
    expect(checkSpend(policy, request({ identityKey: other })).ok).toBe(false)
    expect(checkSpend(policy, request({ spentSats: 0.5 })).ok).toBe(false)
    expect(checkSpend({ ...policy, maxTotalSats: Number.NaN }, request()).ok).toBe(false)
  })

  it('assertSpend throws SpendPolicyError', () => {
    expect(() => assertSpend(policy, request({ spentSats: 9_000 }))).toThrow(SpendPolicyError)
  })
})
