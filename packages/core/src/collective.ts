// FlashCrowd purchase groups: matching intents, splitting the price, and the group's state machine. Everything here
// is pure; the server keeps the groups and feeds events in only after it has checked them (signatures, SPV, chain).
//
//   open -> matched -> committed -> funding -> locked -> claimed
//   open | matched | committed -> expired                       (nobody has paid)
//   funding -> funding_failed                                   (a buyer did not fund; the seller never claims)
//   locked -> settlement_failed                                 (the claim did not go through)
//   funding | funding_failed | locked | settlement_failed -> refund_available   (refundHeight reached, no claim)
//   refund_available -> refunded                                (every funded buyer has its refund on chain)
import { Hash, Utils } from '@bsv/sdk'
import { MIN_CONTRIBUTION_SATS } from './htlc'
import type {
  ClaimProof,
  FundingContribution,
  GroupStatus,
  HtlcTerms,
  PurchaseGroup,
  PurchaseIntent,
  RefundProof,
  ServiceOffer,
} from './types'

export class InsufficientFundingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InsufficientFundingError'
  }
}

export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IllegalTransitionError'
  }
}

const isSats = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0

/**
 * Splits `priceSats` in proportion to `maxima` by largest remainder: integer shares that add up to exactly the
 * price, none above its maximum and none below MIN_CONTRIBUTION_SATS. Ties go to the earlier entry.
 */
export function splitPrice(priceSats: number, maxima: number[]): number[] {
  if (!isSats(priceSats)) throw new InsufficientFundingError('the price must be a positive integer')
  if (maxima.length === 0 || !maxima.every(isSats)) {
    throw new InsufficientFundingError('every maximum must be a positive integer')
  }
  const price = BigInt(priceSats)
  const total = maxima.reduce((sum, m) => sum + BigInt(m), 0n)
  if (total < price) throw new InsufficientFundingError(`the maxima add up to ${total}, below ${priceSats}`)
  const shares = maxima.map((m) => (price * BigInt(m)) / total)
  const remainders = maxima.map((m, i) => ({ i, r: (price * BigInt(m)) % total }))
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
  let left = price - shares.reduce((sum, s) => sum + s, 0n)
  for (const { i } of remainders) {
    if (left === 0n) break
    shares[i] += 1n
    left -= 1n
  }
  const result = shares.map(Number)
  result.forEach((s, i) => {
    if (s > maxima[i]) throw new Error('splitPrice: a share exceeds its maximum')
    if (s < MIN_CONTRIBUTION_SATS) {
      throw new InsufficientFundingError(
        `a share of ${s} sats is below the minimum of ${MIN_CONTRIBUTION_SATS}`,
      )
    }
  })
  return result
}

/** Whether `intent` asks for what `service` sells, on its network, and is still open at `now`. */
function compatible(service: ServiceOffer, intent: PurchaseIntent, now: number): string | undefined {
  if (intent.status !== 'open') return 'the intent is not open'
  if (intent.network !== service.network) return 'another network'
  if (intent.serviceId !== service.id) return 'another service'
  if (intent.resourceId !== service.resourceId) return 'another resource'
  if (!(intent.expiresAt > now)) return 'the intent has expired'
  if (!isSats(intent.maxContributionSats) || intent.maxContributionSats < MIN_CONTRIBUTION_SATS) {
    return `the contribution must be an integer of at least ${MIN_CONTRIBUTION_SATS} sats`
  }
  if (intent.agentIdentityKey === service.sellerIdentityKey) return 'the seller cannot buy from itself'
  return undefined
}

/** A group started by one intent; others join it with advanceGroup({ type: 'join' }). */
export function openGroup(service: ServiceOffer, intent: PurchaseIntent, now: number): PurchaseGroup {
  const problem = compatible(service, intent, now)
  if (problem !== undefined) throw new IllegalTransitionError(`cannot open a group: ${problem}`)
  const group: PurchaseGroup = {
    id: `group-${intent.id}`,
    network: service.network,
    serviceId: service.id,
    resourceId: service.resourceId,
    priceSats: service.priceSats,
    participants: [],
    status: 'open',
    refunds: [],
    createdAt: new Date(now).toISOString(),
    expiresAt: intent.expiresAt,
  }
  return advanceGroup(group, { type: 'join', intent, service, now })
}

/**
 * Matches open intents for `service`: same network, service and resource, not expired, one per agent. Takes them
 * oldest first until their maxima reach the price, and returns the matched group, or null if they do not.
 */
export function matchIntents(
  service: ServiceOffer,
  intents: PurchaseIntent[],
  now: number,
): PurchaseGroup | null {
  const candidates = intents
    .filter((i) => compatible(service, i, now) === undefined)
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    )
  const seen = new Set<string>()
  const chosen: PurchaseIntent[] = []
  let sum = 0
  for (const intent of candidates) {
    if (seen.has(intent.agentIdentityKey)) continue
    seen.add(intent.agentIdentityKey)
    chosen.push(intent)
    sum += intent.maxContributionSats
    if (sum >= service.priceSats) break
  }
  if (sum < service.priceSats) return null
  let group = openGroup(service, chosen[0], now)
  for (const intent of chosen.slice(1)) group = advanceGroup(group, { type: 'join', intent, service, now })
  return group.status === 'matched' ? group : null
}

export type GroupEvent =
  | { type: 'join'; intent: PurchaseIntent; service: ServiceOffer; now: number }
  /** After verifyTerms. */
  | { type: 'terms'; terms: HtlcTerms; ciphertext: string }
  | { type: 'authorize'; identityKey: string }
  /** After verifyFunding. */
  | { type: 'funded'; contribution: FundingContribution }
  /** After the claim is seen on chain. */
  | { type: 'claimed'; claim: ClaimProof }
  /** After the refund is seen on chain. */
  | { type: 'refunded'; refund: RefundProof }
  | { type: 'height'; height: number }
  | { type: 'expire'; now: number }
  | { type: 'fail'; status: 'funding_failed' | 'settlement_failed'; reason: string }

const sameShares = (a: HtlcTerms['shares'], b: HtlcTerms['shares']): boolean =>
  a.length === b.length &&
  a.every((s, i) => s.identityKey === b[i].identityKey && s.shareSats === b[i].shareSats)

/** The group's shares in the order the terms list them. */
const sharesOf = (group: PurchaseGroup): HtlcTerms['shares'] =>
  group.participants
    .map((p) => ({ identityKey: p.identityKey, shareSats: p.shareSats }))
    .sort((a, b) => (a.identityKey < b.identityKey ? -1 : 1))

/**
 * Applies one event and returns the new group; `group` itself is not changed. Throws IllegalTransitionError for
 * anything the current state does not allow, so a share, the terms or a settlement can never change once fixed.
 */
export function advanceGroup(group: PurchaseGroup, event: GroupEvent): PurchaseGroup {
  const illegal = (reason: string): never => {
    throw new IllegalTransitionError(`${event.type} in ${group.status}: ${reason}`)
  }
  const expect = (...allowed: GroupStatus[]): void => {
    if (!allowed.includes(group.status)) illegal(`allowed only in ${allowed.join(', ')}`)
  }
  const g: PurchaseGroup = {
    ...group,
    participants: group.participants.map((p) => ({ ...p })),
    refunds: [...group.refunds],
  }
  const participant = (identityKey: string) =>
    g.participants.find((p) => p.identityKey === identityKey) ?? illegal('not a member of the group')

  switch (event.type) {
    case 'join': {
      expect('open')
      const { intent, service, now } = event
      if (
        service.id !== g.serviceId ||
        service.resourceId !== g.resourceId ||
        service.priceSats !== g.priceSats
      ) {
        illegal('the service does not match the group')
      }
      const problem = compatible(service, intent, now)
      if (problem !== undefined) illegal(problem)
      if (intent.network !== g.network) illegal('another network')
      if (g.participants.some((p) => p.identityKey === intent.agentIdentityKey)) illegal('already a member')
      g.participants.push({
        identityKey: intent.agentIdentityKey,
        intentId: intent.id,
        maxContributionSats: intent.maxContributionSats,
        shareSats: 0,
        status: 'joined',
      })
      g.expiresAt = Math.min(g.expiresAt, intent.expiresAt)
      const total = g.participants.reduce((sum, p) => sum + p.maxContributionSats, 0)
      if (total >= g.priceSats) {
        const shares = splitPrice(
          g.priceSats,
          g.participants.map((p) => p.maxContributionSats),
        )
        g.participants.forEach((p, i) => (p.shareSats = shares[i]))
        g.status = 'matched'
      }
      return g
    }
    case 'terms': {
      expect('matched')
      if (g.terms !== undefined) illegal('the group already has terms')
      const t = event.terms
      if (
        t.groupId !== g.id ||
        t.network !== g.network ||
        t.serviceId !== g.serviceId ||
        t.resourceId !== g.resourceId ||
        t.priceSats !== g.priceSats
      ) {
        illegal('the terms are for another purchase')
      }
      if (!sameShares(t.shares, sharesOf(g))) illegal("the terms do not carry the group's shares")
      if (Utils.toHex(Hash.sha256(Utils.toArray(event.ciphertext, 'hex'))) !== t.ciphertextHash) {
        illegal('the ciphertext does not match the terms')
      }
      g.terms = t
      g.ciphertext = event.ciphertext
      return g
    }
    case 'authorize': {
      expect('matched')
      if (g.terms === undefined) illegal('no terms to authorize yet')
      const p = participant(event.identityKey)
      if (p.status !== 'joined') illegal('already authorized')
      p.status = 'authorized'
      if (g.participants.every((q) => q.status === 'authorized')) g.status = 'committed'
      return g
    }
    case 'funded': {
      expect('committed', 'funding')
      const c = event.contribution
      const p = participant(c.identityKey)
      if (p.status !== 'authorized') illegal('this buyer has already funded or never authorized')
      if (c.status !== 'verified') illegal('the funding has not been verified')
      if (c.satoshis !== p.shareSats) illegal(`the funding holds ${c.satoshis} sats, not the agreed share`)
      p.status = 'funded'
      p.contribution = c
      g.status = g.participants.every((q) => q.status === 'funded') ? 'locked' : 'funding'
      return g
    }
    case 'claimed': {
      expect('locked')
      const outpoints = g.participants.map((p) => `${p.contribution!.txid}.${p.contribution!.vout}`).sort()
      const claimed = [...event.claim.outpoints].sort()
      if (outpoints.length !== claimed.length || outpoints.some((o, i) => o !== claimed[i])) {
        illegal("the claim does not spend exactly the group's contributions")
      }
      if (Utils.toHex(Hash.sha256(Utils.toArray(event.claim.secret, 'hex'))) !== g.terms!.hash) {
        illegal('the claimed secret does not match the hash')
      }
      g.claim = event.claim
      g.status = 'claimed'
      return g
    }
    case 'height': {
      const waiting: GroupStatus[] = ['funding', 'funding_failed', 'locked', 'settlement_failed']
      if (waiting.includes(g.status) && g.terms !== undefined && event.height >= g.terms.refundHeight) {
        g.status = 'refund_available'
      }
      return g
    }
    case 'refunded': {
      expect('refund_available')
      const r = event.refund
      const p = participant(r.identityKey)
      if (p.status !== 'funded') illegal('nothing of this buyer to refund')
      if (r.outpoint !== `${p.contribution!.txid}.${p.contribution!.vout}`)
        illegal("not this buyer's contribution")
      p.status = 'refunded'
      g.refunds.push(r)
      if (!g.participants.some((q) => q.status === 'funded')) g.status = 'refunded'
      return g
    }
    case 'expire': {
      expect('open', 'matched', 'committed')
      if (event.now < g.expiresAt) illegal('the group has not expired yet')
      g.status = 'expired'
      return g
    }
    case 'fail': {
      if (event.status === 'funding_failed') expect('committed', 'funding')
      else expect('locked')
      g.status = event.status
      return g
    }
  }
}
