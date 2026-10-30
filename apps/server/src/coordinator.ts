// The coordinator: keeps intents and groups, calls core in the right order and reports to the feed. It holds no
// buyer's key or money. Whenever a caller's identity matters it is an argument from BRC-103 auth, never from a body.
import { randomUUID } from 'node:crypto'
import {
  advanceGroup,
  IllegalTransitionError,
  InsufficientFundingError,
  InvalidHtlcError,
  matchIntents,
  MIN_CONTRIBUTION_SATS,
  verifyFunding,
  verifyTerms,
  wocTxUrl,
  type FundingContribution,
  type GroupStatus,
  type Network,
  type PurchaseGroup,
  type PurchaseIntent,
  type RefundProof,
  type ServiceOffer,
} from '@agentswap/core'
import { Transaction } from '@bsv/sdk'
import type { ChainView } from './chain'
import type { Feed } from './feed'
import type { MockSeller } from './seller'
import type { Store } from './store'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

const TXID = /^[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})+$/
const MAX_INTENT_MS = 24 * 60 * 60 * 1000
const MAX_EVENT_LENGTH = 500
/** Attempts before a claim counts as failed; the ticker retries it, since most failures are the network's. */
const MAX_CLAIM_ATTEMPTS = 3
const FINISHED: GroupStatus[] = ['claimed', 'expired', 'refunded']

const short = (key: string): string => `${key.slice(0, 10)}…`
const outpointOf = (c: FundingContribution): string => `${c.txid}.${c.vout}`
const intentIdsOf = (g: PurchaseGroup): string[] => g.participants.map((p) => p.intentId)
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'the body must be a JSON object')
  }
  return body as Record<string, unknown>
}

/** A contribution as a buyer sends it. The identity comes from auth; a different one in the body is refused. */
function parseContribution(body: unknown, identityKey: string): FundingContribution {
  const b = record(body)
  if (b.identityKey !== undefined && b.identityKey !== identityKey) {
    throw new HttpError(403, 'the contribution names another identity than the signed request')
  }
  if (typeof b.txid !== 'string' || !TXID.test(b.txid)) throw new HttpError(400, 'bad txid')
  if (!Number.isSafeInteger(b.vout) || (b.vout as number) < 0) throw new HttpError(400, 'bad vout')
  if (!Number.isSafeInteger(b.satoshis) || (b.satoshis as number) <= 0)
    throw new HttpError(400, 'bad satoshis')
  if (typeof b.lockingScript !== 'string' || !HEX.test(b.lockingScript)) {
    throw new HttpError(400, 'bad lockingScript')
  }
  return {
    identityKey,
    txid: b.txid,
    vout: b.vout as number,
    satoshis: b.satoshis as number,
    lockingScript: b.lockingScript,
    status: 'prepared',
  }
}

export class Coordinator {
  /** Mutations of one key run one at a time, so an await inside one cannot lose another's write. */
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly claimAttempts = new Map<string, number>()
  private ticking = false
  private timer?: NodeJS.Timeout
  /** Latest height seen, for /health. */
  height?: number

  constructor(
    private readonly network: Network,
    private readonly store: Store,
    private readonly feed: Feed,
    private readonly seller: MockSeller,
    private readonly chain: ChainView,
    private readonly now: () => number = Date.now,
  ) {}

  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.then(work)
    const tail = run.catch(() => undefined)
    this.locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  private async currentHeight(): Promise<number> {
    try {
      this.height = await this.chain.currentHeight()
      return this.height
    } catch (e) {
      throw new HttpError(503, `the chain cannot be read right now: ${errorText(e)}`)
    }
  }

  private requireGroup(id: string): PurchaseGroup {
    const group = this.store.group(id)
    if (group === undefined) throw new HttpError(404, 'no such group')
    return group
  }

  // Reads

  services(): ServiceOffer[] {
    return this.seller.services()
  }

  intents(): PurchaseIntent[] {
    return this.store.allIntents()
  }

  /** The list leaves out what only the group's own page needs. */
  groups(intentId?: string): PurchaseGroup[] {
    return this.store
      .allGroups()
      .filter((g) => intentId === undefined || intentIdsOf(g).includes(intentId))
      .map((g) => {
        const { ciphertext: _, ...rest } = g
        return {
          ...rest,
          participants: g.participants.map((p) => {
            if (p.contribution === undefined) return p
            const { beef: __, ...contribution } = p.contribution
            return { ...p, contribution }
          }),
        }
      })
  }

  /** The group, with a link for every transaction known to be sent. */
  group(id: string) {
    const group = this.requireGroup(id)
    const link = (kind: 'funding' | 'claim' | 'refund', txid: string, identityKey?: string) => ({
      kind,
      txid,
      wocUrl: wocTxUrl(txid, this.network),
      ...(identityKey !== undefined && { identityKey }),
    })
    return {
      ...group,
      transactions: [
        ...group.participants.flatMap((p) =>
          p.contribution?.status === 'verified' ? [link('funding', p.contribution.txid, p.identityKey)] : [],
        ),
        ...(group.claim === undefined ? [] : [link('claim', group.claim.txid)]),
        ...group.refunds.map((r) => link('refund', r.txid, r.identityKey)),
      ],
    }
  }

  settlement(id: string) {
    const group = this.requireGroup(id)
    return {
      groupId: id,
      status: group.status,
      refundHeight: group.terms?.refundHeight,
      refundAvailable: group.status === 'refund_available',
      claim: group.claim,
      /** Hex AtomicBEEF for secretFromClaim: buyers read K from the transaction, not from our word. */
      claimTx: this.store.claimTx(id),
      refunds: group.refunds,
    }
  }

  // Intents and matching

  async submitIntent(identityKey: string, body: unknown) {
    const b = record(body)
    const now = this.now()
    if (b.network !== this.network) throw new HttpError(400, `this server runs on ${this.network}`)
    const service = this.seller.services().find((s) => s.id === b.serviceId)
    if (service === undefined) throw new HttpError(404, 'no such service')
    if (b.resourceId !== service.resourceId)
      throw new HttpError(400, 'this service does not sell that resource')
    if (identityKey === service.sellerIdentityKey)
      throw new HttpError(400, 'the seller cannot buy from itself')
    const max = b.maxContributionSats
    if (!Number.isSafeInteger(max) || (max as number) < MIN_CONTRIBUTION_SATS) {
      throw new HttpError(400, `maxContributionSats must be an integer of at least ${MIN_CONTRIBUTION_SATS}`)
    }
    const expiresAt = b.expiresAt
    if (
      !Number.isSafeInteger(expiresAt) ||
      (expiresAt as number) <= now ||
      (expiresAt as number) > now + MAX_INTENT_MS
    ) {
      throw new HttpError(400, 'expiresAt must be Unix ms, in the future and within 24 hours')
    }
    const { intent, groupId } = await this.locked('matching', async () => {
      const taken = this.store
        .allIntents()
        .some(
          (i) =>
            i.agentIdentityKey === identityKey &&
            i.status === 'open' &&
            i.serviceId === service.id &&
            i.expiresAt > now,
        )
      if (taken) throw new HttpError(409, 'this agent already has an open intent for this service')
      const intent: PurchaseIntent = {
        id: randomUUID(),
        network: this.network,
        agentIdentityKey: identityKey,
        serviceId: service.id,
        resourceId: service.resourceId,
        maxContributionSats: max as number,
        expiresAt: expiresAt as number,
        status: 'open',
        createdAt: new Date(now).toISOString(),
      }
      this.store.putIntent(intent)
      this.feed.publish({
        type: 'intent',
        message: `${short(identityKey)} wants ${service.resourceId}, up to ${intent.maxContributionSats} sats`,
      })
      const group = this.tryMatch(service, now)
      return { intent, groupId: group?.id }
    })
    if (groupId === undefined) return { intent: this.store.intent(intent.id)!, group: undefined }
    await this.locked(groupId, () => this.attachTerms(groupId)).catch((e: unknown) => {
      // The ticker tries again; the intent itself went through.
      console.error(`terms for ${groupId} failed: ${errorText(e)}`)
    })
    return { intent: this.store.intent(intent.id)!, group: this.group(groupId) }
  }

  /**
   * matchIntents gives up with InsufficientFundingError when a share falls below the minimum, and it would do the
   * same on every later try, so one very small intent could block a service until it expires. Drop the smallest
   * intent from this attempt and try again; it stays open for a later group.
   */
  private tryMatch(service: ServiceOffer, now: number): PurchaseGroup | undefined {
    let candidates = this.store.allIntents().filter((i) => i.status === 'open')
    for (;;) {
      let group: PurchaseGroup | null
      try {
        group = matchIntents(service, candidates, now)
      } catch (e) {
        if (!(e instanceof InsufficientFundingError) || candidates.length === 0) throw e
        const smallest = candidates.reduce((a, b) => (b.maxContributionSats < a.maxContributionSats ? b : a))
        candidates = candidates.filter((i) => i !== smallest)
        continue
      }
      if (group === null) return undefined
      this.store.putGroup(group)
      this.store.setIntentStatus(intentIdsOf(group), 'matched')
      const shares = group.participants.map((p) => `${short(p.identityKey)} ${p.shareSats}`).join(', ')
      this.feed.publish({ type: 'group', message: `group ${group.id} matched: ${shares}` })
      return group
    }
  }

  /** Runs under the group's lock. */
  private async attachTerms(groupId: string): Promise<void> {
    const group = this.requireGroup(groupId)
    if (group.status !== 'matched' || group.terms !== undefined) return
    const { terms, ciphertext } = await this.seller.makeTerms(group, await this.currentHeight())
    await verifyTerms(terms)
    this.store.putGroup(advanceGroup(group, { type: 'terms', terms, ciphertext }))
    this.feed.publish({
      type: 'group',
      message: `group ${groupId}: the seller signed the terms, refunds from block ${terms.refundHeight}`,
    })
  }

  // Authorize, fund

  async authorize(identityKey: string, groupId: string): Promise<PurchaseGroup> {
    return await this.locked(groupId, async () => {
      const group = advanceGroup(this.requireGroup(groupId), { type: 'authorize', identityKey })
      this.store.putGroup(group)
      this.feed.publish({ type: 'group', message: `${short(identityKey)} accepted the terms of ${groupId}` })
      if (group.status === 'committed') {
        this.store.setIntentStatus(intentIdsOf(group), 'committed')
        this.feed.publish({ type: 'group', message: `group ${groupId} is committed: every buyer accepted` })
      }
      return group
    })
  }

  /** Step 1 of funding: the buyer's unsigned-to-us HTLC reference goes in, the seller's refund signature comes back. */
  async submitContribution(identityKey: string, groupId: string, body: unknown) {
    if (record(body).beef !== undefined) {
      throw new HttpError(400, 'do not send the BEEF before you hold the refund signature')
    }
    const submitted = parseContribution(body, identityKey)
    return await this.locked(groupId, async () => {
      const group = this.requireGroup(groupId)
      if ((group.status !== 'committed' && group.status !== 'funding') || group.terms === undefined) {
        throw new HttpError(409, `group is ${group.status}: not taking contributions`)
      }
      const participant = group.participants.find((p) => p.identityKey === identityKey)
      if (participant === undefined) throw new HttpError(403, 'not a member of this group')
      if (participant.status !== 'authorized') throw new HttpError(409, 'this buyer has already funded')
      const height = await this.currentHeight()
      if (height >= group.terms.refundHeight) throw new HttpError(409, 'the refund height has passed')
      const refundSignature = await this.seller.signRefund(group.terms, submitted)
      const contribution: FundingContribution = { ...submitted, refundSignature, status: 'refund_signed' }
      // Not a state change of the group: advanceGroup only sees the contribution once it is verified.
      this.store.putGroup({
        ...group,
        participants: group.participants.map((p) =>
          p.identityKey === identityKey ? { ...p, contribution } : p,
        ),
      })
      return { refundSignature, contribution }
    })
  }

  /** Step 2 of funding: the buyer has broadcast, and hands over the BEEF. A locked group goes on to the claim. */
  async submitFunding(identityKey: string, groupId: string, body: unknown): Promise<PurchaseGroup> {
    const beef = record(body).beef
    if (typeof beef !== 'string' || !HEX.test(beef)) throw new HttpError(400, 'bad beef')
    const submitted = parseContribution(body, identityKey)
    const group = await this.locked(groupId, async () => {
      const group = this.requireGroup(groupId)
      if (group.terms === undefined) throw new HttpError(409, 'the group has no terms yet')
      const participant = group.participants.find((p) => p.identityKey === identityKey)
      if (participant === undefined) throw new HttpError(403, 'not a member of this group')
      const signed = participant.contribution
      if (signed === undefined)
        throw new HttpError(409, 'send the contribution for its refund signature first')
      if (outpointOf(signed) !== outpointOf(submitted) || signed.lockingScript !== submitted.lockingScript) {
        throw new HttpError(409, 'this is not the contribution the seller signed a refund for')
      }
      const contribution: FundingContribution = { ...signed, beef }
      await verifyFunding(group.terms, contribution, this.chain.tracker)
      const next = advanceGroup(group, {
        type: 'funded',
        contribution: { ...contribution, status: 'verified' },
      })
      this.store.putGroup(next)
      this.feed.publish({
        type: 'lock',
        message: `${short(identityKey)} locked ${contribution.satoshis} sats in ${groupId}`,
        txid: contribution.txid,
      })
      return next
    })
    if (group.status === 'locked') {
      this.feed.publish({ type: 'group', message: `group ${groupId} is locked: every share is funded` })
      // The buyer does not wait for it; a failure goes to the feed and the ticker retries.
      void this.settle(groupId).catch((e: unknown) => console.error(`claim of ${groupId}: ${errorText(e)}`))
    }
    return group
  }

  private async settle(groupId: string): Promise<void> {
    if (this.seller.noClaim) return
    await this.locked(groupId, async () => {
      const group = this.requireGroup(groupId)
      if (group.status !== 'locked') return
      const fail = (reason: string): void => {
        this.store.putGroup(advanceGroup(group, { type: 'fail', status: 'settlement_failed', reason }))
        this.feed.publish({ type: 'claim', message: `the claim of ${groupId} failed: ${reason}` })
      }
      let proof: Awaited<ReturnType<MockSeller['claim']>>
      try {
        proof = await this.seller.claim(group)
      } catch (e) {
        const attempts = (this.claimAttempts.get(groupId) ?? 0) + 1
        this.claimAttempts.set(groupId, attempts)
        if (e instanceof InvalidHtlcError || attempts >= MAX_CLAIM_ATTEMPTS) fail(errorText(e))
        else console.error(`claim of ${groupId}, attempt ${attempts}: ${errorText(e)}`)
        return
      }
      const { beef, ...claim } = proof
      this.store.putClaim(advanceGroup(group, { type: 'claimed', claim }), beef)
      this.feed.publish({
        type: 'claim',
        message: `the seller claimed ${group.priceSats} sats of ${groupId}; the key is on chain`,
        txid: claim.txid,
      })
    })
  }

  // Refunds

  /** A buyer reports its refund; the network must know a transaction that really is that refund. */
  async reportRefund(identityKey: string, groupId: string, body: unknown): Promise<PurchaseGroup> {
    const txid = record(body).txid
    if (typeof txid !== 'string' || !TXID.test(txid)) throw new HttpError(400, 'bad txid')
    return await this.locked(groupId, async () => {
      let group = advanceGroup(this.requireGroup(groupId), {
        type: 'height',
        height: await this.currentHeight(),
      })
      const contribution = group.participants.find((p) => p.identityKey === identityKey)?.contribution
      if (contribution === undefined) throw new HttpError(403, 'no contribution of this buyer in this group')
      const raw = await this.chain.getRawTx(txid).catch(() => undefined)
      if (raw === undefined) throw new HttpError(409, 'the network does not know this transaction yet; retry')
      const tx = Transaction.fromBinary(raw)
      const spends = tx.inputs.some(
        (i) => i.sourceTXID === contribution.txid && i.sourceOutputIndex === contribution.vout,
      )
      if (tx.id('hex') !== txid || !spends || tx.lockTime < group.terms!.refundHeight) {
        throw new HttpError(422, 'this transaction is not a refund of your contribution')
      }
      const refund: RefundProof = {
        identityKey,
        txid,
        wocUrl: wocTxUrl(txid, this.network),
        outpoint: outpointOf(contribution),
      }
      group = advanceGroup(group, { type: 'refunded', refund })
      this.store.putGroup(group)
      this.feed.publish({
        type: 'refund',
        message: `${short(identityKey)} got ${contribution.satoshis} sats back from ${groupId}`,
        txid,
      })
      return group
    })
  }

  // Agents' steps

  /** Agents only report their own steps: the type and the sender are ours, so nobody can fake a claim in the feed. */
  postEvent(identityKey: string, body: unknown) {
    const { message, txid } = record(body)
    if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_EVENT_LENGTH) {
      throw new HttpError(400, `message must be 1 to ${MAX_EVENT_LENGTH} characters`)
    }
    if (txid !== undefined && (typeof txid !== 'string' || !TXID.test(txid)))
      throw new HttpError(400, 'bad txid')
    return this.feed.publish({ type: 'agent', message: `${short(identityKey)}: ${message.trim()}`, txid })
  }

  // The ticker

  /** One round: block height, expiries, retries. Errors of one group do not stop the others. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      const expired = this.store.allIntents().filter((i) => i.status === 'open' && i.expiresAt <= now)
      if (expired.length > 0) {
        this.store.setIntentStatus(
          expired.map((i) => i.id),
          'expired',
        )
      }
      let height: number | undefined
      try {
        height = await this.currentHeight()
      } catch (e) {
        console.error(errorText(e))
      }
      for (const { id, status } of this.store.allGroups()) {
        if (FINISHED.includes(status)) continue
        try {
          await this.locked(id, () => this.tickGroup(id, now, height))
          if (this.store.group(id)?.status === 'locked') await this.settle(id)
        } catch (e) {
          console.error(`tick of ${id}: ${errorText(e)}`)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private async tickGroup(id: string, now: number, height: number | undefined): Promise<void> {
    let group = this.requireGroup(id)
    if (group.status === 'matched' && group.terms === undefined && height !== undefined) {
      await this.attachTerms(id)
      group = this.requireGroup(id)
    }
    if (now >= group.expiresAt && ['open', 'matched', 'committed', 'funding'].includes(group.status)) {
      // After a refund signature a buyer may have broadcast: its money waits for refundHeight, so the group does too.
      const maybeFunded = group.participants.some((p) => p.contribution !== undefined)
      if (group.status === 'funding' || maybeFunded) {
        group = advanceGroup(group, {
          type: 'fail',
          status: 'funding_failed',
          reason: 'a buyer did not fund in time',
        })
        this.store.putGroup(group)
        this.feed.publish({
          type: 'group',
          message: `group ${id}: a buyer did not fund in time; the seller will not claim, refunds from block ${group.terms!.refundHeight}`,
        })
      } else {
        group = advanceGroup(group, { type: 'expire', now })
        this.store.putGroup(group)
        this.store.setIntentStatus(intentIdsOf(group), 'expired')
        this.feed.publish({ type: 'group', message: `group ${id} expired before anyone paid` })
      }
    }
    if (height !== undefined) {
      const next = advanceGroup(group, { type: 'height', height })
      if (next.status !== group.status) {
        this.store.putGroup(next)
        this.feed.publish({ type: 'refund', message: `group ${id}: refunds are available from now on` })
      }
    }
  }

  start(intervalMs: number): void {
    const run = (): void => void this.tick().catch((e: unknown) => console.error(errorText(e)))
    run()
    this.timer = setInterval(run, intervalMs)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
  }
}

export const isClientError = (e: unknown): number | undefined => {
  if (e instanceof HttpError) return e.status
  if (e instanceof IllegalTransitionError) return 409
  if (e instanceof InvalidHtlcError) return 422
  return undefined
}
