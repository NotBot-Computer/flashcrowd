// Purchase groups without a chain: matching, the price split and the group's state machine.
import { Hash, PrivateKey, Random, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  advanceGroup,
  IllegalTransitionError,
  InsufficientFundingError,
  matchIntents,
  openGroup,
  splitPrice,
} from '../src/collective'
import type {
  FundingContribution,
  HtlcTerms,
  PurchaseGroup,
  PurchaseIntent,
  ServiceOffer,
} from '../src/types'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const HOUR = 3_600_000
const key = (): string => PrivateKey.fromRandom().toPublicKey().toString()

const service: ServiceOffer = {
  id: 'premium-data',
  network: 'testnet',
  sellerIdentityKey: key(),
  title: 'BSV/USD daily closes (simulation)',
  resourceId: 'bsvusd-2026-10',
  priceSats: 12_000,
  license: 'shared-within-group',
  simulation: true,
}

let n = 0
function intent(max: number, overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  n++
  return {
    id: `intent-${n}`,
    network: 'testnet',
    agentIdentityKey: key(),
    serviceId: service.id,
    resourceId: service.resourceId,
    maxContributionSats: max,
    expiresAt: NOW + HOUR,
    status: 'open',
    createdAt: new Date(NOW - 1_000 * (100 - n)).toISOString(),
    ...overrides,
  }
}

const ciphertext = Utils.toHex(Random(64))

function termsFor(g: PurchaseGroup, overrides: Partial<HtlcTerms> = {}): HtlcTerms {
  return {
    groupId: g.id,
    network: g.network,
    serviceId: g.serviceId,
    resourceId: g.resourceId,
    sellerIdentityKey: service.sellerIdentityKey,
    sellerKey: key(),
    priceSats: g.priceSats,
    shares: g.participants
      .map((p) => ({ identityKey: p.identityKey, shareSats: p.shareSats }))
      .sort((a, b) => (a.identityKey < b.identityKey ? -1 : 1)),
    hash: Utils.toHex(Hash.sha256(Random(32))),
    ciphertextHash: Utils.toHex(Hash.sha256(Utils.toArray(ciphertext, 'hex'))),
    refundHeight: 1_000,
    signature: '00',
    ...overrides,
  }
}

const contributionOf = (g: PurchaseGroup, i: number, sats?: number): FundingContribution => ({
  identityKey: g.participants[i].identityKey,
  txid: Utils.toHex(Random(32)),
  vout: 0,
  satoshis: sats ?? g.participants[i].shareSats,
  lockingScript: '51',
  status: 'verified',
})

/** A group of three agents (3k, 4k, 5k) with signed terms, authorized by everyone. */
function committedGroup(): PurchaseGroup {
  let g = matchIntents(service, [intent(3_000), intent(4_000), intent(5_000)], NOW)!
  g = advanceGroup(g, { type: 'terms', terms: termsFor(g), ciphertext })
  for (const p of g.participants) g = advanceGroup(g, { type: 'authorize', identityKey: p.identityKey })
  return g
}

describe('splitPrice', () => {
  it('splits exactly when the maxima add up to the price', () => {
    expect(splitPrice(12_000, [3_000, 4_000, 5_000])).toEqual([3_000, 4_000, 5_000])
  })

  it('splits in proportion, in whole sats that add up to the price and stay under each maximum', () => {
    const maxima = [5_000, 5_000, 5_000]
    const shares = splitPrice(10_001, maxima)
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10_001)
    expect(shares.every((s, i) => Number.isInteger(s) && s <= maxima[i])).toBe(true)
    expect(shares).toEqual([3_334, 3_334, 3_333])
  })

  it('refuses when the maxima cannot cover the price', () => {
    expect(() => splitPrice(12_000, [3_000, 4_000])).toThrow(InsufficientFundingError)
  })

  it('refuses floats and shares below the minimum', () => {
    expect(() => splitPrice(12_000.5, [20_000])).toThrow(InsufficientFundingError)
    expect(() => splitPrice(12_000, [3_000.5, 10_000])).toThrow(InsufficientFundingError)
    expect(() => splitPrice(2_000, [100_000, 1_000])).toThrow(/below the minimum/)
  })
})

describe('matchIntents', () => {
  it('matches compatible intents whose maxima reach the price', () => {
    const intents = [intent(3_000), intent(4_000), intent(5_000)]
    const g = matchIntents(service, intents, NOW)!
    expect(g.status).toBe('matched')
    expect(g.participants.map((p) => p.shareSats)).toEqual([3_000, 4_000, 5_000])
    expect(g.participants.reduce((sum, p) => sum + p.shareSats, 0)).toBe(service.priceSats)
    expect(g.participants.map((p) => p.intentId)).toEqual(intents.map((i) => i.id))
  })

  it('leaves out other resources, other services, other networks and expired intents', () => {
    const intents = [
      intent(3_000),
      intent(4_000, { resourceId: 'another-dataset' }),
      intent(4_000, { serviceId: 'another-service' }),
      intent(4_000, { network: 'mainnet' }),
      intent(4_000, { expiresAt: NOW - 1 }),
      intent(5_000),
    ]
    expect(matchIntents(service, intents, NOW)).toBeNull()
  })

  it('returns null when the funding is insufficient', () => {
    expect(matchIntents(service, [intent(3_000), intent(4_000)], NOW)).toBeNull()
  })

  it('counts each agent once', () => {
    const a = intent(6_000)
    const twice = intent(6_000, { agentIdentityKey: a.agentIdentityKey })
    expect(matchIntents(service, [a, twice], NOW)).toBeNull()
    const g = matchIntents(service, [a, twice, intent(6_000)], NOW)!
    expect(new Set(g.participants.map((p) => p.identityKey)).size).toBe(2)
  })

  it('does not let the seller buy', () => {
    expect(() =>
      openGroup(service, intent(12_000, { agentIdentityKey: service.sellerIdentityKey }), NOW),
    ).toThrow(IllegalTransitionError)
  })
})

describe('advanceGroup', () => {
  it('runs open -> matched -> committed -> funding -> locked -> claimed', () => {
    const a = intent(3_000)
    let g = openGroup(service, a, NOW)
    expect(g.status).toBe('open')
    g = advanceGroup(g, { type: 'join', intent: intent(4_000), service, now: NOW })
    expect(g.status).toBe('open')
    g = advanceGroup(g, { type: 'join', intent: intent(5_000), service, now: NOW })
    expect(g.status).toBe('matched')

    const terms = termsFor(g)
    g = advanceGroup(g, { type: 'terms', terms, ciphertext })
    for (const p of g.participants) g = advanceGroup(g, { type: 'authorize', identityKey: p.identityKey })
    expect(g.status).toBe('committed')

    const contributions = g.participants.map((_, i) => contributionOf(g, i))
    g = advanceGroup(g, { type: 'funded', contribution: contributions[0] })
    expect(g.status).toBe('funding')
    g = advanceGroup(g, { type: 'funded', contribution: contributions[1] })
    g = advanceGroup(g, { type: 'funded', contribution: contributions[2] })
    expect(g.status).toBe('locked')

    const secret = Random(32)
    const locked = { ...g, terms: { ...terms, hash: Utils.toHex(Hash.sha256(secret)) } }
    const claim = {
      txid: Utils.toHex(Random(32)),
      wocUrl: 'https://test.whatsonchain.com/tx/x',
      secret: Utils.toHex(secret),
      outpoints: contributions.map((c) => `${c.txid}.${c.vout}`).reverse(),
    }
    const claimed = advanceGroup(locked, { type: 'claimed', claim })
    expect(claimed.status).toBe('claimed')

    // Preventing double settlement: a claimed group takes no second claim and no refund.
    expect(() => advanceGroup(claimed, { type: 'claimed', claim })).toThrow(IllegalTransitionError)
    expect(advanceGroup(claimed, { type: 'height', height: 10_000 }).status).toBe('claimed')
  })

  it('does not change the group it is given', () => {
    const g = matchIntents(service, [intent(3_000), intent(4_000), intent(5_000)], NOW)!
    const before = structuredClone(g)
    advanceGroup(g, { type: 'terms', terms: termsFor(g), ciphertext })
    expect(g).toEqual(before)
  })

  it('refuses a claim with the wrong secret or the wrong outpoints', () => {
    let g = committedGroup()
    const contributions = g.participants.map((_, i) => contributionOf(g, i))
    for (const c of contributions) g = advanceGroup(g, { type: 'funded', contribution: c })
    const claim = {
      txid: Utils.toHex(Random(32)),
      wocUrl: '',
      secret: Utils.toHex(Random(32)),
      outpoints: contributions.map((c) => `${c.txid}.${c.vout}`),
    }
    expect(() => advanceGroup(g, { type: 'claimed', claim })).toThrow(/secret/)
    expect(() =>
      advanceGroup(g, { type: 'claimed', claim: { ...claim, outpoints: claim.outpoints.slice(1) } }),
    ).toThrow(/exactly/)
  })

  it('refuses duplicate membership and joining after the match', () => {
    const a = intent(3_000)
    const g = openGroup(service, a, NOW)
    expect(() =>
      advanceGroup(g, {
        type: 'join',
        intent: intent(4_000, { agentIdentityKey: a.agentIdentityKey }),
        service,
        now: NOW,
      }),
    ).toThrow(/already a member/)
    const matched = matchIntents(service, [intent(6_000), intent(6_000)], NOW)!
    expect(() => advanceGroup(matched, { type: 'join', intent: intent(1_000), service, now: NOW })).toThrow(
      IllegalTransitionError,
    )
  })

  it('refuses tampered terms: other shares, another price, another ciphertext, or a second set', () => {
    const g = matchIntents(service, [intent(3_000), intent(4_000), intent(5_000)], NOW)!
    const terms = termsFor(g)
    const shifted = terms.shares.map((s, i) => ({
      ...s,
      shareSats: s.shareSats + (i === 0 ? 1 : i === 1 ? -1 : 0),
    }))
    expect(() =>
      advanceGroup(g, { type: 'terms', terms: { ...terms, shares: shifted }, ciphertext }),
    ).toThrow(/shares/)
    expect(() =>
      advanceGroup(g, { type: 'terms', terms: { ...terms, priceSats: 11_000 }, ciphertext }),
    ).toThrow(/another purchase/)
    expect(() => advanceGroup(g, { type: 'terms', terms, ciphertext: Utils.toHex(Random(64)) })).toThrow(
      /ciphertext/,
    )
    const withTerms = advanceGroup(g, { type: 'terms', terms, ciphertext })
    expect(() => advanceGroup(withTerms, { type: 'terms', terms, ciphertext })).toThrow(/already has terms/)
  })

  it('refuses a contribution that differs from the authorized share, or comes twice', () => {
    let g = committedGroup()
    expect(() => advanceGroup(g, { type: 'funded', contribution: contributionOf(g, 0, 2_999) })).toThrow(
      /agreed share/,
    )
    expect(() =>
      advanceGroup(g, { type: 'funded', contribution: { ...contributionOf(g, 0), status: 'broadcast' } }),
    ).toThrow(/verified/)
    g = advanceGroup(g, { type: 'funded', contribution: contributionOf(g, 0) })
    expect(() => advanceGroup(g, { type: 'funded', contribution: contributionOf(g, 0) })).toThrow(
      /already funded/,
    )
  })

  it('refuses authorizing before terms and funding before everyone authorized', () => {
    let g = matchIntents(service, [intent(3_000), intent(4_000), intent(5_000)], NOW)!
    expect(() => advanceGroup(g, { type: 'authorize', identityKey: g.participants[0].identityKey })).toThrow(
      /no terms/,
    )
    g = advanceGroup(g, { type: 'terms', terms: termsFor(g), ciphertext })
    g = advanceGroup(g, { type: 'authorize', identityKey: g.participants[0].identityKey })
    expect(() => advanceGroup(g, { type: 'funded', contribution: contributionOf(g, 0) })).toThrow(
      IllegalTransitionError,
    )
    expect(() => advanceGroup(g, { type: 'authorize', identityKey: key() })).toThrow(/not a member/)
  })

  it('refunds every funded buyer after the refund height, and only then', () => {
    let g = committedGroup()
    const contributions = g.participants.map((_, i) => contributionOf(g, i))
    g = advanceGroup(g, { type: 'funded', contribution: contributions[0] })
    g = advanceGroup(g, { type: 'funded', contribution: contributions[1] })
    // The third buyer never funds.
    g = advanceGroup(g, { type: 'fail', status: 'funding_failed', reason: 'buyer 3 did not fund' })
    expect(g.status).toBe('funding_failed')

    const refund = (i: number) => ({
      identityKey: g.participants[i].identityKey,
      txid: Utils.toHex(Random(32)),
      wocUrl: '',
      outpoint: `${contributions[i].txid}.${contributions[i].vout}`,
    })
    expect(() => advanceGroup(g, { type: 'refunded', refund: refund(0) })).toThrow(IllegalTransitionError)
    expect(advanceGroup(g, { type: 'height', height: 999 }).status).toBe('funding_failed')
    g = advanceGroup(g, { type: 'height', height: 1_000 })
    expect(g.status).toBe('refund_available')

    expect(() => advanceGroup(g, { type: 'refunded', refund: refund(2) })).toThrow(/nothing of this buyer/)
    expect(() =>
      advanceGroup(g, { type: 'refunded', refund: { ...refund(0), outpoint: refund(1).outpoint } }),
    ).toThrow(/not this buyer/)
    g = advanceGroup(g, { type: 'refunded', refund: refund(0) })
    expect(g.status).toBe('refund_available')
    expect(() => advanceGroup(g, { type: 'refunded', refund: refund(0) })).toThrow(/nothing of this buyer/)
    g = advanceGroup(g, { type: 'refunded', refund: refund(1) })
    expect(g.status).toBe('refunded')
    expect(g.refunds).toHaveLength(2)
  })

  it('expires a group nobody has paid into, and only after its expiry', () => {
    const g = matchIntents(service, [intent(6_000), intent(6_000)], NOW)!
    expect(() => advanceGroup(g, { type: 'expire', now: NOW })).toThrow(/not expired/)
    expect(advanceGroup(g, { type: 'expire', now: NOW + HOUR }).status).toBe('expired')
    let funding = committedGroup()
    funding = advanceGroup(funding, { type: 'funded', contribution: contributionOf(funding, 0) })
    expect(() => advanceGroup(funding, { type: 'expire', now: NOW + HOUR })).toThrow(IllegalTransitionError)
  })
})
