// One purchase by one agent, step by step (docs/FLASHCROWD_PLAN.md, P4). Deterministic: the amount and every
// signature are decided here under the spend policy, never by an LLM. The on-chain steps are packages/core
// functions; the coordinator only carries messages.
//
// search -> intent -> match -> evaluate -> authorize -> fund -> settle -> decrypt | refund
//
// Nothing is signed before the terms pass verifyTerms and assertSpend, and the funding is broadcast only with a valid
// refund signature from the seller. Once funded, the agent never gives up: it waits for the claim or the refund.
import {
  abandonContribution,
  assertSpend,
  broadcastContribution,
  checkSpend,
  decryptResource,
  MIN_CONTRIBUTION_SATS,
  prepareContribution,
  refundContribution,
  secretFromClaim,
  verifyRefundSignature,
  verifyTerms,
  type FundingContribution,
  type GroupStatus,
  type HtlcContext,
  type HtlcTerms,
  type PurchaseGroup,
  type SpendPolicy,
} from '@agentswap/core'
import { Hash, Utils } from '@bsv/sdk'
import { CoordinatorError, type Coordinator, type Settlement } from './coordinator'

export interface AgentConfig {
  name: string
  policy: SpendPolicy
  serviceId: string
  resourceId: string
  /** The most this agent offers; also capped by the policy. */
  maxContributionSats: number
  /** How long the intent stays open. */
  intentTtlMs: number
  pollMs: number
  /** How long to wait for a group and for the others to authorize. Never applies once funded. */
  matchTimeoutMs: number
}

export type AgentStep =
  | 'search'
  | 'intent'
  | 'match'
  | 'evaluate'
  | 'authorize'
  | 'fund'
  | 'settle'
  | 'decrypt'
  | 'refund'
  | 'refuse'

export interface AgentDeps {
  ctx: HtlcContext
  coordinator: Coordinator
  /** What this agent has committed before this purchase. */
  spentSats: number
  log?: (step: AgentStep, message: string, txid?: string) => void
  sleep?: (ms: number) => Promise<void>
  /**
   * Called once the funding is on the network, before anything else can fail, with what a refund needs later:
   * the terms and the contribution with its refund signature and BEEF.
   */
  onFunded?: (funding: {
    groupId: string
    fundingTxid: string
    shareSats: number
    terms: HtlcTerms
    contribution: FundingContribution
    ciphertext: string
  }) => void
  now?: () => number
}

export type PurchaseOutcome =
  | {
      status: 'decrypted'
      groupId: string
      shareSats: number
      fundingTxid: string
      claimTxid: string
      data: number[]
    }
  | { status: 'refunded'; groupId: string; shareSats: number; fundingTxid: string; refundTxid: string }
  /** Refused before signing anything. */
  | { status: 'refused'; reason: string; groupId?: string }
  /** No group, or the group never committed; nothing was paid. */
  | { status: 'unmatched'; reason: string; groupId?: string }

const COMMITTED: GroupStatus[] = ['committed', 'funding', 'locked', 'claimed']
const GAVE_UP: GroupStatus[] = ['expired', 'funding_failed']
/** How often to tell the coordinator about a refund the network does not know yet. */
const REPORT_ATTEMPTS = 20

export async function runPurchase(deps: AgentDeps, config: AgentConfig): Promise<PurchaseOutcome> {
  const { ctx, coordinator } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const log = async (step: AgentStep, message: string, txid?: string): Promise<void> => {
    deps.log?.(step, `${config.name}: ${message}`, txid)
    await coordinator.report({ message: `${config.name}: ${message}`, txid }).catch(() => undefined)
  }
  const refuse = async (reason: string, groupId?: string): Promise<PurchaseOutcome> => {
    await log('refuse', `refused: ${reason}`)
    return { status: 'refused', reason, groupId }
  }
  const identityKey = (await ctx.wallet.getPublicKey({ identityKey: true }, ctx.originator)).publicKey
  const height = async (): Promise<number> => (await ctx.wallet.getHeight({}, ctx.originator)).height
  const { policy } = config

  // searchServices
  const service = (await coordinator.services()).find(
    (s) => s.id === config.serviceId && s.resourceId === config.resourceId && s.network === ctx.network,
  )
  if (service === undefined) return await refuse(`no ${config.serviceId} / ${config.resourceId} on offer`)
  if (!policy.allowedServiceIds.includes(service.id))
    return await refuse(`service ${service.id} is not allowed`)
  if (service.license !== 'shared-within-group')
    return await refuse('the result may not be shared in a group')
  const offer = Math.min(
    config.maxContributionSats,
    policy.maxPerPurchaseSats,
    policy.maxTotalSats - deps.spentSats,
  )
  if (!Number.isSafeInteger(offer) || offer < MIN_CONTRIBUTION_SATS) {
    return await refuse(`the policy leaves ${offer} sats, below ${MIN_CONTRIBUTION_SATS}`)
  }
  await log('search', `wants "${service.title}" (${service.priceSats} sats), offers up to ${offer}`)

  // createPurchaseIntent
  const posted = await coordinator.createIntent({
    network: ctx.network,
    serviceId: service.id,
    resourceId: service.resourceId,
    maxContributionSats: offer,
    expiresAt: now() + config.intentTtlMs,
  })
  const intent = posted.intent
  await log('intent', `intent ${intent.id} published, up to ${offer} sats`)

  // findMatchingGroup: wait for a group with signed terms. The list leaves out the ciphertext, so the group itself is
  // read once it has terms.
  const deadline = now() + config.matchTimeoutMs
  let groupId = posted.group?.id
  let group: PurchaseGroup | undefined = posted.group
  while (group?.terms === undefined || group.ciphertext === undefined) {
    if (now() > deadline) return { status: 'unmatched', reason: 'no group with terms in time', groupId }
    if (groupId === undefined) {
      groupId = (await coordinator.groupsForIntent(intent.id)).find((g) => !GAVE_UP.includes(g.status))?.id
    }
    if (groupId !== undefined) group = await coordinator.group(groupId)
    if (group !== undefined && GAVE_UP.includes(group.status)) {
      return { status: 'unmatched', reason: `group ${group.status}`, groupId }
    }
    if (group?.terms === undefined || group.ciphertext === undefined) await sleep(config.pollMs)
  }
  const terms: HtlcTerms = group.terms
  const ciphertext = group.ciphertext
  await log('match', `matched into ${group.id} with ${group.participants.length} agents`)

  // evaluatePurchase: the seller's signature, our share, the policy.
  try {
    await verifyTerms(terms)
  } catch (e) {
    return await refuse(`terms rejected: ${(e as Error).message}`, group.id)
  }
  if (terms.groupId !== group.id) return await refuse('the terms are for another group', group.id)
  if (
    ciphertext === undefined ||
    Utils.toHex(Hash.sha256(Utils.toArray(ciphertext, 'hex'))) !== terms.ciphertextHash
  ) {
    return await refuse('the ciphertext does not match the terms', group.id)
  }
  const spend = { terms, identityKey, intent, spentSats: deps.spentSats }
  const decision = checkSpend(policy, { ...spend, currentHeight: await height() })
  if (!decision.ok) return await refuse(decision.reason, group.id)
  const shareSats = decision.shareSats
  await log('evaluate', `terms verified, share ${shareSats} of ${terms.priceSats} sats within policy`)

  // joinPurchaseGroup
  group = await coordinator.authorize(group.id)
  await log('authorize', `authorized ${shareSats} sats`)
  while (!COMMITTED.includes(group.status)) {
    if (GAVE_UP.includes(group.status))
      return { status: 'unmatched', reason: `group ${group.status}`, groupId }
    if (now() > deadline)
      return { status: 'unmatched', reason: 'the others did not authorize in time', groupId }
    await sleep(config.pollMs)
    group = await coordinator.group(group.id)
  }

  // authorizeFunding: checked again right before signing, since the height has moved.
  assertSpend(policy, { ...spend, currentHeight: await height() })
  const { contribution, beef } = await prepareContribution(ctx, terms)
  let refundSignature: string
  try {
    ;({ refundSignature } = await coordinator.submitContribution(group.id, contribution))
  } catch (e) {
    await abandonContribution(ctx, contribution)
    return await refuse(`no refund signature: ${(e as Error).message}`, group.id)
  }
  if (!verifyRefundSignature(terms, contribution, refundSignature)) {
    await abandonContribution(ctx, contribution)
    return await refuse("the seller's refund signature is invalid", group.id)
  }
  const sent = await broadcastContribution(ctx, terms, { ...contribution, refundSignature }, beef)
  const funded = sent.contribution
  deps.onFunded?.({
    groupId: group.id,
    fundingTxid: sent.txid,
    shareSats,
    terms,
    contribution: funded,
    ciphertext,
  })
  await log('fund', `locked ${shareSats} sats in its HTLC ${sent.wocUrl}`, sent.txid)
  // The funds are on chain now: whatever the coordinator says, wait for the claim or the refund.
  await coordinator.submitFunding(group.id, funded).catch((e: unknown) => {
    deps.log?.('fund', `${config.name}: the coordinator did not take the funding: ${(e as Error).message}`)
  })

  /** The refund is on chain already; the server only needs to see it. It answers 409 until the network knows it. */
  const reportRefund = async (id: string, txid: string): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await coordinator.reportRefund(id, txid)
        return
      } catch (e) {
        if (!(e instanceof CoordinatorError && e.status === 409) || attempt >= REPORT_ATTEMPTS) {
          deps.log?.(
            'refund',
            `${config.name}: the coordinator did not take the refund: ${(e as Error).message}`,
          )
          return
        }
        await sleep(config.pollMs)
      }
    }
  }

  // waitForSettlement. The money is locked, so the agent never gives up: when the coordinator is unreachable it keeps
  // asking, and once the chain is above refundHeight it refunds on its own (the seller stops claiming before then).
  let unreachable = false
  for (;;) {
    let settlement: Settlement | undefined
    try {
      settlement = await coordinator.settlement(group.id)
      if (unreachable) deps.log?.('settle', `${config.name}: the coordinator is back`)
      unreachable = false
    } catch (e) {
      if (!unreachable) {
        deps.log?.(
          'settle',
          `${config.name}: the coordinator is unreachable (${(e as Error).message}); still waiting`,
        )
      }
      unreachable = true
    }
    if (settlement?.status === 'claimed' && settlement.claim !== undefined) {
      const key =
        settlement.claimTx !== undefined
          ? secretFromClaim(terms, settlement.claimTx)
          : Utils.toArray(settlement.claim.secret, 'hex')
      // decryptResource checks K against the hash and the ciphertext against the terms.
      const data = decryptResource(terms, key, ciphertext)
      await log(
        'settle',
        `seller claimed and revealed the key ${settlement.claim.wocUrl}`,
        settlement.claim.txid,
      )
      await log('decrypt', `decrypted ${data.length} bytes`)
      return {
        status: 'decrypted',
        groupId: group.id,
        shareSats,
        fundingTxid: sent.txid,
        claimTxid: settlement.claim.txid,
        data,
      }
    }
    const refundable =
      settlement === undefined
        ? (await height()) > terms.refundHeight
        : settlement.refundAvailable || settlement.status === 'refunded'
    if (refundable) {
      try {
        const refund = await refundContribution(ctx, terms, funded)
        await log('refund', `no claim; refunded its contribution ${refund.wocUrl}`, refund.txid)
        await reportRefund(group.id, refund.txid)
        return {
          status: 'refunded',
          groupId: group.id,
          shareSats,
          fundingTxid: sent.txid,
          refundTxid: refund.txid,
        }
      } catch (e) {
        // "not final": the coordinator's height ran ahead of the wallet's; anything else (a claim we have not seen
        // yet, a network error) is logged. Either way the agent tries again.
        if (!/not final/.test((e as Error).message)) {
          deps.log?.('refund', `${config.name}: refund failed (${(e as Error).message}); trying again`)
        }
      }
    }
    await sleep(config.pollMs)
  }
}
