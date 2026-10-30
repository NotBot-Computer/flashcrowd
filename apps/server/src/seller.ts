// The mock seller: a separate party with its own wallet and one simulation dataset. It keeps a fresh secret K per
// group until it claims. K never enters the coordinator's state, so no API response can leak it before the claim.
import {
  CLAIM_MARGIN_BLOCKS,
  claimContributions,
  encryptResource,
  htlcKey,
  newSecret,
  signRefund,
  signTerms,
  InvalidHtlcError,
  type ClaimProof,
  type FundingContribution,
  type HtlcContext,
  type HtlcTerms,
  type PurchaseGroup,
  type ServiceOffer,
} from '@agentswap/core'
import { Utils } from '@bsv/sdk'
import { readJson, writeJsonAtomic } from './store'

/** Clearly fake data: this demo sells no real dataset, and a revealed key proves disclosure, not quality. */
const DATASET = JSON.stringify({
  simulation: true,
  note: 'Generated demo data, not real market data.',
  pair: 'BSV/USD',
  month: '2026-10',
  closes: ['41.20', '41.35', '40.98', '41.77', '42.05'],
})

const SERVICE_ID = 'bsv-usd-closes'
const RESOURCE_ID = 'bsvusd-2026-10'
const PRICE_SATS = 12_000

export interface SellerOptions {
  /** refundHeight = height at matching + lockBlocks. */
  lockBlocks: number
  /** Demo of the refund path: the seller never claims. */
  noClaim: boolean
  /** Where K is kept across restarts; memory only if not given. */
  secretsFile?: string
}

export class MockSeller {
  readonly noClaim: boolean
  private readonly lockBlocks: number
  private readonly secretsFile?: string
  private readonly secrets: Map<string, string>
  private offer!: ServiceOffer

  private constructor(
    private readonly ctx: HtlcContext,
    options: SellerOptions,
  ) {
    if (!Number.isSafeInteger(options.lockBlocks) || options.lockBlocks <= CLAIM_MARGIN_BLOCKS) {
      throw new Error(`lockBlocks must be an integer above ${CLAIM_MARGIN_BLOCKS}`)
    }
    this.noClaim = options.noClaim
    this.lockBlocks = options.lockBlocks
    this.secretsFile = options.secretsFile
    const stored =
      options.secretsFile === undefined ? undefined : readJson<[string, string][]>(options.secretsFile)
    this.secrets = new Map(stored ?? [])
  }

  static async create(ctx: HtlcContext, options: SellerOptions): Promise<MockSeller> {
    const seller = new MockSeller(ctx, options)
    const { publicKey } = await ctx.wallet.getPublicKey({ identityKey: true }, ctx.originator)
    seller.offer = {
      id: SERVICE_ID,
      network: ctx.network,
      sellerIdentityKey: publicKey,
      title: 'BSV/USD daily closes, October 2026 (simulation)',
      resourceId: RESOURCE_ID,
      priceSats: PRICE_SATS,
      license: 'shared-within-group',
      simulation: true,
    }
    return seller
  }

  services(): ServiceOffer[] {
    return [this.offer]
  }

  private saveSecrets(): void {
    if (this.secretsFile !== undefined) writeJsonAtomic(this.secretsFile, [...this.secrets])
  }

  /** A fresh K for a matched group, the dataset encrypted with it, and the signed terms. */
  async makeTerms(group: PurchaseGroup, height: number): Promise<{ terms: HtlcTerms; ciphertext: string }> {
    const { secret, hash } = newSecret()
    const { ciphertext, ciphertextHash } = encryptResource(secret, Utils.toArray(DATASET, 'utf8'))
    const terms = await signTerms(this.ctx, {
      groupId: group.id,
      network: group.network,
      serviceId: group.serviceId,
      resourceId: group.resourceId,
      sellerIdentityKey: this.offer.sellerIdentityKey,
      sellerKey: await htlcKey(this.ctx, group.id),
      priceSats: group.priceSats,
      shares: group.participants
        .map((p) => ({ identityKey: p.identityKey, shareSats: p.shareSats }))
        .sort((a, b) => (a.identityKey < b.identityKey ? -1 : 1)),
      hash,
      ciphertextHash,
      refundHeight: height + this.lockBlocks,
    })
    this.secrets.set(group.id, Utils.toHex(secret))
    this.saveSecrets()
    return { terms, ciphertext }
  }

  async signRefund(terms: HtlcTerms, contribution: FundingContribution): Promise<string> {
    return await signRefund(this.ctx, terms, contribution)
  }

  /** Claims every contribution of a locked group in one transaction, which reveals K on chain. */
  async claim(group: PurchaseGroup): Promise<ClaimProof & { beef: string }> {
    const terms = group.terms
    const secret = this.secrets.get(group.id)
    if (terms === undefined || secret === undefined)
      throw new InvalidHtlcError('no terms or key for this group')
    const contributions = group.participants.flatMap((p) => p.contribution ?? [])
    return await claimContributions(this.ctx, terms, Utils.toArray(secret, 'hex'), contributions)
  }
}
