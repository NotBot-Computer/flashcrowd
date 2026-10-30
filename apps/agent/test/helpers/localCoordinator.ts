// Test only: an in-process coordinator with a mock seller, standing in for apps/server so the agents can run end to
// end on the mock chain. It answers like the server's API (apps/server/README.md) and calls the same core functions,
// but it is not the server: no HTTP, no auth, no persistence. Each agent gets a client bound to its identity key, as BRC-103 auth would give the server.
import {
  advanceGroup,
  claimContributions,
  encryptResource,
  htlcKey,
  matchIntents,
  newSecret,
  signRefund,
  signTerms,
  verifyFunding,
  type ClaimProof,
  type HtlcContext,
  type PurchaseGroup,
  type PurchaseIntent,
  type ServiceOffer,
} from '@agentswap/core'
import { Utils, type ChainTracker } from '@bsv/sdk'
import { CoordinatorError, type Coordinator, type Settlement } from '../../src/coordinator'

export interface LocalCoordinatorOptions {
  seller: HtlcContext
  sellerIdentityKey: string
  service: ServiceOffer
  dataset: string
  chainTracker: ChainTracker
  height: () => Promise<number>
  /** refundHeight = height at match + lockBlocks. */
  lockBlocks: number
  /** False for the refund demo: the seller never claims. */
  claim: boolean
}

export class LocalCoordinator {
  readonly intents = new Map<string, PurchaseIntent>()
  readonly groups = new Map<string, PurchaseGroup>()
  readonly events: string[] = []
  readonly refundReports: string[] = []
  private readonly secrets = new Map<string, number[]>()
  private readonly claimTxs = new Map<string, string>()

  constructor(private readonly o: LocalCoordinatorOptions) {}

  anyLocked(): boolean {
    return [...this.groups.values()].some((g) => g.status === 'locked' || g.status === 'refund_available')
  }

  private update(id: string, event: Parameters<typeof advanceGroup>[1]): PurchaseGroup {
    const g = advanceGroup(this.groups.get(id)!, event)
    this.groups.set(id, g)
    return g
  }

  /** The mock seller prepares the data and signs the terms once a group is matched. */
  private async sell(group: PurchaseGroup): Promise<void> {
    const { secret, hash } = newSecret()
    const { ciphertext, ciphertextHash } = encryptResource(secret, Utils.toArray(this.o.dataset, 'utf8'))
    const terms = await signTerms(this.o.seller, {
      groupId: group.id,
      network: group.network,
      serviceId: group.serviceId,
      resourceId: group.resourceId,
      sellerIdentityKey: this.o.sellerIdentityKey,
      sellerKey: await htlcKey(this.o.seller, group.id),
      priceSats: group.priceSats,
      shares: group.participants
        .map((p) => ({ identityKey: p.identityKey, shareSats: p.shareSats }))
        .sort((a, b) => (a.identityKey < b.identityKey ? -1 : 1)),
      hash,
      ciphertextHash,
      refundHeight: (await this.o.height()) + this.o.lockBlocks,
    })
    this.secrets.set(group.id, secret)
    this.update(group.id, { type: 'terms', terms, ciphertext })
  }

  private async claim(id: string): Promise<void> {
    const g = this.groups.get(id)!
    try {
      const { beef, ...proof } = await claimContributions(
        this.o.seller,
        g.terms!,
        this.secrets.get(id)!,
        g.participants.map((p) => p.contribution!),
      )
      this.claimTxs.set(id, beef)
      this.update(id, { type: 'claimed', claim: proof as ClaimProof })
      this.events.push(`seller claimed ${proof.txid}`)
    } catch (e) {
      this.update(id, { type: 'fail', status: 'settlement_failed', reason: (e as Error).message })
    }
  }

  client(identityKey: string): Coordinator {
    const member = (groupId: string) => {
      const g = this.groups.get(groupId)
      if (g === undefined) throw new Error(`no group ${groupId}`)
      if (!g.participants.some((p) => p.identityKey === identityKey)) throw new Error('not a member')
      return g
    }
    return {
      services: async () => [this.o.service],
      createIntent: async (n) => {
        if (
          [...this.intents.values()].some(
            (i) => i.agentIdentityKey === identityKey && i.status === 'open' && i.serviceId === n.serviceId,
          )
        ) {
          throw new CoordinatorError(409, 'this agent already has an open intent for this service')
        }
        const now = Date.now()
        const intent: PurchaseIntent = {
          ...n,
          id: `intent-${this.intents.size + 1}`,
          agentIdentityKey: identityKey,
          status: 'open',
          createdAt: new Date(now).toISOString(),
        }
        this.intents.set(intent.id, intent)
        const group = matchIntents(this.o.service, [...this.intents.values()], now)
        if (group !== null) {
          this.groups.set(group.id, group)
          for (const p of group.participants) {
            this.intents.set(p.intentId, { ...this.intents.get(p.intentId)!, status: 'matched' })
          }
          await this.sell(group)
          return { intent: this.intents.get(intent.id)!, group: this.groups.get(group.id) }
        }
        return { intent }
      },
      groupsForIntent: async (intentId) =>
        [...this.groups.values()]
          .filter((g) => g.participants.some((p) => p.intentId === intentId))
          .map(({ ciphertext: _, ...g }) => g),
      group: async (id) => member(id),
      authorize: async (groupId) => {
        member(groupId)
        return this.update(groupId, { type: 'authorize', identityKey })
      },
      submitContribution: async (groupId, c) => {
        const g = member(groupId)
        if (c.identityKey !== identityKey) throw new CoordinatorError(403, 'not your contribution')
        if (c.beef !== undefined) throw new CoordinatorError(400, 'do not send the BEEF yet')
        if (g.status !== 'committed' && g.status !== 'funding') {
          throw new CoordinatorError(409, `group is ${g.status}: not taking contributions`)
        }
        return { refundSignature: await signRefund(this.o.seller, g.terms!, c) }
      },
      submitFunding: async (groupId, c) => {
        const g = member(groupId)
        if (c.identityKey !== identityKey) throw new Error('not your contribution')
        await verifyFunding(g.terms!, c, this.o.chainTracker)
        const updated = this.update(groupId, { type: 'funded', contribution: { ...c, status: 'verified' } })
        if (updated.status === 'locked' && this.o.claim) await this.claim(groupId)
        return this.groups.get(groupId)!
      },
      settlement: async (groupId): Promise<Settlement> => {
        member(groupId)
        // Like the server: refunds open one block after refundHeight, when the wallet takes them as final.
        const g = this.update(groupId, { type: 'height', height: (await this.o.height()) - 1 })
        return {
          groupId,
          status: g.status,
          refundHeight: g.terms?.refundHeight,
          refundAvailable: g.status === 'refund_available',
          claim: g.claim,
          claimTx: this.claimTxs.get(groupId),
          refunds: g.refunds,
        }
      },
      reportRefund: async (groupId, txid) => {
        const c = member(groupId).participants.find((p) => p.identityKey === identityKey)?.contribution
        if (c === undefined) throw new CoordinatorError(403, 'no contribution of this buyer in this group')
        this.refundReports.push(txid)
        return this.update(groupId, {
          type: 'refunded',
          refund: { identityKey, txid, wocUrl: '', outpoint: `${c.txid}.${c.vout}` },
        })
      },
      report: async ({ message }) => {
        this.events.push(message)
      },
    }
  }
}
