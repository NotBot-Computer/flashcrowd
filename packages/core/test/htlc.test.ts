// FlashCrowd HTLCs end to end on wallet-toolbox's mock chain, with real wallet-toolbox wallets (the engine BSV
// Desktop runs). Mock chain only: this proves the scripts and the wallet flow, not testnet behaviour.
//
// Group 1: three buyers fund 3,000 + 4,000 + 5,000 sats into their own HTLCs; the seller claims all three in one
// transaction by revealing K, and every buyer decrypts the dataset with it.
// Group 2: two buyers fund, the seller never claims, and each buyer gets its own contribution back after the
// refund height.
import {
  PrivateKey,
  Random,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  OP,
} from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  abandonContribution,
  BroadcastError,
  broadcastContribution,
  claimContributions,
  decryptResource,
  encryptResource,
  htlcKey,
  htlcKeyOf,
  type HtlcContext,
  InvalidHtlcError,
  newSecret,
  prepareContribution,
  refundContribution,
  secretFromClaim,
  signRefund,
  signTerms,
  verifyFunding,
  verifyRefundSignature,
  verifyTerms,
} from '../src/htlc'
import { assertSpend, SpendPolicyError } from '../src/spendPolicy'
import type { FundingContribution, HtlcTerms, PurchaseIntent, SpendPolicy, UnsignedTerms } from '../src/types'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain
const wallets: Record<'seller' | 'alice' | 'bob' | 'carol', Wallet> = {} as never
const ctx: Record<keyof typeof wallets, HtlcContext> = {} as never
const id: Record<keyof typeof wallets, string> = {} as never

const policy: SpendPolicy = {
  maxPerPurchaseSats: 5_000,
  maxTotalSats: 20_000,
  allowedServiceIds: ['premium-data'],
  requireMatchingResource: true,
  maxLockBlocks: 50,
}

/** Expects `p` to fail with an InvalidHtlcError whose message matches `reason`. */
async function expectInvalid(p: Promise<unknown>, reason: RegExp): Promise<void> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(InvalidHtlcError)
  expect((error as Error).message).toMatch(reason)
}

async function makeTerms(
  groupId: string,
  shares: [keyof typeof wallets, number][],
  hash: string,
  ciphertextHash: string,
  lockBlocks: number,
): Promise<HtlcTerms> {
  const unsigned: UnsignedTerms = {
    groupId,
    network: 'testnet',
    serviceId: 'premium-data',
    resourceId: 'bsvusd-2026-10',
    sellerIdentityKey: id.seller,
    sellerKey: await htlcKey(ctx.seller, groupId),
    priceSats: shares.reduce((sum, [, s]) => sum + s, 0),
    shares: shares
      .map(([who, shareSats]) => ({ identityKey: id[who], shareSats }))
      .sort((a, b) => (a.identityKey < b.identityKey ? -1 : 1)),
    hash,
    ciphertextHash,
    refundHeight: (await chain.services.getHeight()) + lockBlocks,
  }
  return await signTerms(ctx.seller, unsigned)
}

/** Buyer prepares, seller pre-signs the refund, buyer checks it and broadcasts, seller verifies the funding. */
async function fund(who: keyof typeof wallets, terms: HtlcTerms): Promise<FundingContribution> {
  const { contribution, beef } = await prepareContribution(ctx[who], terms)
  const refundSignature = await signRefund(ctx.seller, terms, contribution)
  expect(verifyRefundSignature(terms, contribution, refundSignature)).toBe(true)
  const sent = await broadcastContribution(ctx[who], terms, { ...contribution, refundSignature }, beef)
  console.log(`funding ${sent.txid} (${who}, ${contribution.satoshis} sats)`)
  await verifyFunding(terms, sent.contribution, chain.chainTracker)
  return { ...sent.contribution, status: 'verified' }
}

/** Script check of one input, as a node would run it. */
function inputValid(tx: Transaction, index: number): boolean {
  const input = tx.inputs[index]
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  try {
    return new Spend({
      sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis!,
      lockingScript: source.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, i) => i !== index),
      outputs: tx.outputs,
      inputIndex: index,
      unlockingScript: input.unlockingScript!,
      inputSequence: input.sequence!,
      lockTime: tx.lockTime,
    }).validate()
  } catch {
    return false
  }
}

const push = (data: number[]): { op: number; data: number[] } => ({ op: data.length, data })
const strangerSig = (): number[] => {
  const s = PrivateKey.fromRandom().sign(Random(32))
  return new TransactionSignature(
    s.r,
    s.s,
    TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID,
  ).toChecksigFormat()
}
const inputOf = (tx: Transaction, c: FundingContribution): number =>
  tx.inputs.findIndex(
    (i) => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === c.txid && i.sourceOutputIndex === c.vout,
  )

beforeAll(async () => {
  chain = await createMockChain()
  for (const who of ['seller', 'alice', 'bob', 'carol'] as const) {
    wallets[who] = await chain.makeWallet()
    ctx[who] = { wallet: wallets[who], network: 'testnet' }
    id[who] = wallets[who].identityKey
  }
  // The seller gets no funds: the claim pays its fee out of the HTLC values.
  await chain.fund(wallets.alice)
  await chain.fund(wallets.bob)
  await chain.fund(wallets.carol)
})

afterAll(async () => {
  await chain?.close()
})

describe('keys and terms', () => {
  it("anyone derives a party's HTLC key from its identity key", async () => {
    expect(await htlcKeyOf(id.alice, 'g')).toBe(await htlcKey(ctx.alice, 'g'))
    expect(await htlcKeyOf(id.alice, 'g')).not.toBe(await htlcKey(ctx.alice, 'h'))
  })

  it('accepts terms the seller signed and refuses tampered or forged ones', async () => {
    const { hash } = newSecret()
    const terms = await makeTerms(
      'terms-check',
      [
        ['alice', 3_000],
        ['bob', 4_000],
      ],
      hash,
      hash,
      10,
    )
    await verifyTerms(terms)
    await expectInvalid(verifyTerms({ ...terms, refundHeight: terms.refundHeight + 1 }), /did not sign/)
    await expectInvalid(verifyTerms({ ...terms, hash: newSecret().hash }), /did not sign/)
    await expectInvalid(
      verifyTerms({ ...terms, shares: terms.shares.map((s) => ({ ...s, shareSats: s.shareSats + 1 })) }),
      /add up/,
    )
    await expectInvalid(
      verifyTerms({ ...terms, sellerKey: await htlcKey(ctx.alice, terms.groupId) }),
      /sellerKey/,
    )
    // Alice cannot sign terms in the seller's name.
    const { signature: _, ...unsigned } = terms
    await expectInvalid(signTerms(ctx.alice, unsigned), /only the seller/)
    await expectInvalid(
      verifyTerms({
        ...terms,
        signature: (
          await signTerms(ctx.seller, {
            ...unsigned,
            groupId: 'other',
            sellerKey: await htlcKey(ctx.seller, 'other'),
          })
        ).signature,
      }),
      /did not sign/,
    )
  })
})

describe('group 1: three buyers, one key, one claim', () => {
  const GROUP = 'group-claim'
  const dataset = JSON.stringify({ simulation: true, pair: 'BSV/USD', closes: ['41.20', '41.35', '40.98'] })
  const { secret, hash } = newSecret()
  const { ciphertext, ciphertextHash } = encryptResource(secret, Utils.toArray(dataset, 'utf8'))
  let terms: HtlcTerms
  const funded: FundingContribution[] = []
  let claim: Awaited<ReturnType<typeof claimContributions>>

  const intentOf = (who: 'alice' | 'bob' | 'carol', max: number): PurchaseIntent => ({
    id: `intent-${who}`,
    network: 'testnet',
    agentIdentityKey: id[who],
    serviceId: 'premium-data',
    resourceId: 'bsvusd-2026-10',
    maxContributionSats: max,
    expiresAt: Date.now() + 60_000,
    status: 'matched',
    createdAt: new Date().toISOString(),
  })

  it('every buyer checks its spend policy, then funds its own HTLC after the seller pre-signs its refund', async () => {
    terms = await makeTerms(
      GROUP,
      [
        ['alice', 3_000],
        ['bob', 4_000],
        ['carol', 5_000],
      ],
      hash,
      ciphertextHash,
      20,
    )
    const height = await chain.services.getHeight()
    for (const [who, share] of [
      ['alice', 3_000],
      ['bob', 4_000],
      ['carol', 5_000],
    ] as const) {
      await verifyTerms(terms)
      expect(
        assertSpend(policy, {
          terms,
          identityKey: id[who],
          intent: intentOf(who, share),
          currentHeight: height,
          spentSats: 0,
        }),
      ).toBe(share)
      const before = await wallets[who].balance()
      funded.push(await fund(who, terms))
      expect(await wallets[who].balance()).toBeLessThanOrEqual(before - share)
    }
    expect(() =>
      assertSpend(
        { ...policy, maxPerPurchaseSats: 4_999 },
        {
          terms,
          identityKey: id.carol,
          intent: intentOf('carol', 5_000),
          currentHeight: height,
          spentSats: 0,
        },
      ),
    ).toThrow(SpendPolicyError)
  })

  it('the seller refuses to pre-sign a contribution that is not the agreed HTLC', async () => {
    const c = funded[0]
    await expectInvalid(signRefund(ctx.seller, terms, { ...c, satoshis: c.satoshis - 1 }), /agreed share/)
    const theirs = funded.find((f) => f.identityKey !== c.identityKey)!
    await expectInvalid(
      signRefund(ctx.seller, terms, { ...c, lockingScript: theirs.lockingScript }),
      /locking script/,
    )
    await expectInvalid(signRefund(ctx.alice, terms, c), /only the seller/)
  })

  it('verifyFunding refuses a contribution whose transaction does not hold it', async () => {
    const [a, b] = funded
    await expectInvalid(
      verifyFunding(terms, { ...a, beef: b.beef }, chain.chainTracker),
      /not this contribution/,
    )
    await expectInvalid(verifyFunding(terms, { ...a, vout: a.vout + 1 }, chain.chainTracker), /agreed HTLC/)
  })

  it('a buyer does not broadcast without a valid refund signature, and a failed broadcast is reported', async () => {
    const extra = await makeTerms(
      'group-unsent',
      [
        ['alice', 2_000],
        ['bob', 2_000],
      ],
      hash,
      ciphertextHash,
      20,
    )
    const { contribution, beef } = await prepareContribution(ctx.alice, extra)
    await expectInvalid(broadcastContribution(ctx.alice, extra, contribution, beef), /refund signature/)
    const wrong = await signRefund(ctx.seller, terms, funded[0])
    await expectInvalid(
      broadcastContribution(ctx.alice, extra, { ...contribution, refundSignature: wrong }, beef),
      /refund signature/,
    )
    const refundSignature = await signRefund(ctx.seller, extra, contribution)
    await abandonContribution(ctx.alice, contribution)
    await expect(
      broadcastContribution(ctx.alice, extra, { ...contribution, refundSignature }, beef),
    ).rejects.toBeInstanceOf(BroadcastError)
  })

  it('the seller cannot claim with a wrong key or with a contribution missing', async () => {
    await expectInvalid(claimContributions(ctx.seller, terms, Random(32), funded), /secret/)
    await expectInvalid(
      claimContributions(ctx.seller, terms, secret, funded.slice(1)),
      /one contribution per share/,
    )
    await expectInvalid(
      claimContributions(ctx.seller, terms, secret, [funded[0], funded[0], funded[1]]),
      /one contribution per share/,
    )
  })

  it('the seller claims all three HTLCs in one transaction by revealing the key', async () => {
    expect(await wallets.seller.balance()).toBe(0)
    claim = await claimContributions(ctx.seller, terms, secret, funded)
    const received = await wallets.seller.balance()
    console.log(`claim ${claim.txid}: seller received ${received} of 12000 sats`)
    expect(received).toBeGreaterThan(11_900)
    expect(received).toBeLessThanOrEqual(12_000)
    expect(claim.outpoints).toHaveLength(3)
  })

  it('a second claim of the same outputs fails', async () => {
    await expect(claimContributions(ctx.seller, terms, secret, funded)).rejects.toThrow()
  })

  it('a buyer reads the key from the claim and decrypts the dataset', () => {
    const key = secretFromClaim(terms, claim.beef)
    expect(Utils.toUTF8(decryptResource(terms, key, ciphertext))).toBe(dataset)
    expect(() => decryptResource(terms, Random(32), ciphertext)).toThrow(InvalidHtlcError)
    expect(() => decryptResource({ ...terms, ciphertextHash: hash }, secret, ciphertext)).toThrow(
      /ciphertext/,
    )
  })

  it('the claim does not validate with a wrong key or with a stranger signature', () => {
    const tx = Transaction.fromAtomicBEEF(Utils.toArray(claim.beef, 'hex'))
    for (const c of funded) {
      const index = inputOf(tx, c)
      expect(inputValid(tx, index)).toBe(true)
      const [sig] = tx.inputs[index].unlockingScript!.chunks
      const original = tx.inputs[index].unlockingScript
      tx.inputs[index].unlockingScript = new UnlockingScript([
        push(sig.data!),
        push(Random(32)),
        { op: OP.OP_1 },
      ])
      expect(inputValid(tx, index)).toBe(false)
      tx.inputs[index].unlockingScript = new UnlockingScript([
        push(strangerSig()),
        push(secret),
        { op: OP.OP_1 },
      ])
      expect(inputValid(tx, index)).toBe(false)
      tx.inputs[index].unlockingScript = original
    }
  })
})

describe('group 2: the seller never claims, each buyer refunds after the refund height', () => {
  const GROUP = 'group-refund'
  const { secret, hash } = newSecret()
  let terms: HtlcTerms
  const funded: FundingContribution[] = []
  const refunds: Record<string, string> = {}

  it('two buyers fund their HTLCs', async () => {
    terms = await makeTerms(
      GROUP,
      [
        ['alice', 2_500],
        ['bob', 4_500],
      ],
      hash,
      hash,
      2,
    )
    funded.push(await fund('alice', terms))
    funded.push(await fund('bob', terms))
  })

  it('refuses a refund before the refund height (the transaction is not final)', async () => {
    const before = await wallets.alice.balance()
    await expect(refundContribution(ctx.alice, terms, funded[0])).rejects.toThrow(/not final/)
    expect(await wallets.alice.balance()).toBe(before)
  })

  it("no one refunds another buyer's contribution", async () => {
    await expectInvalid(refundContribution(ctx.bob, terms, funded[0]), /only the buyer/)
    await expectInvalid(refundContribution(ctx.seller, terms, funded[0]), /only the buyer/)
  })

  it('after the refund height each buyer gets back its own contribution, less the fee', async () => {
    for (let i = 0; i < 3; i++) await chain.mineBlock()
    for (const [who, c] of [
      ['alice', funded[0]],
      ['bob', funded[1]],
    ] as const) {
      const before = await wallets[who].balance()
      const refund = await refundContribution(ctx[who], terms, c)
      refunds[who] = refund.txid
      const back = (await wallets[who].balance()) - before
      console.log(`refund ${refund.txid}: ${who} got back ${back} of ${c.satoshis} sats`)
      expect(back).toBeGreaterThan(c.satoshis - 100)
      expect(back).toBeLessThanOrEqual(c.satoshis)
      expect(refund.outpoint).toBe(`${c.txid}.${c.vout}`)
    }
  })

  it('the seller can no longer claim after the refund height', async () => {
    await expectInvalid(claimContributions(ctx.seller, terms, secret, funded), /too late/)
  })

  it('a refund does not validate without the seller pre-signature, with a stranger, or with another lock time', async () => {
    const refundTx = async (who: 'alice' | 'bob'): Promise<Transaction> => {
      const { actions } = await wallets[who].listActions({ labels: [], includeLabels: false })
      expect(actions.some((a) => a.txid === refunds[who])).toBe(true)
      const beef = await chain.services.getRawTx(refunds[who])
      const tx = Transaction.fromBinary(beef.rawTx!)
      for (const input of tx.inputs) {
        const c = funded.find((f) => f.txid === input.sourceTXID)!
        input.sourceTransaction = Transaction.fromAtomicBEEF(Utils.toArray(c.beef!, 'hex'))
      }
      return tx
    }
    const tx = await refundTx('alice')
    const index = inputOf(tx, funded[0])
    expect(tx.lockTime).toBe(terms.refundHeight)
    expect(inputValid(tx, index)).toBe(true)

    const [buyerSig, sellerSig] = tx.inputs[index].unlockingScript!.chunks
    const swap = (chunks: number[][]) =>
      (tx.inputs[index].unlockingScript = new UnlockingScript([...chunks.map(push), { op: OP.OP_0 }]))
    swap([buyerSig.data!, buyerSig.data!])
    expect(inputValid(tx, index)).toBe(false)
    swap([sellerSig.data!, sellerSig.data!])
    expect(inputValid(tx, index)).toBe(false)
    swap([strangerSig(), sellerSig.data!])
    expect(inputValid(tx, index)).toBe(false)
    swap([buyerSig.data!, sellerSig.data!])
    tx.lockTime = terms.refundHeight - 1
    expect(inputValid(tx, index)).toBe(false)
  })
})
