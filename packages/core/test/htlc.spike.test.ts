// FlashCrowd pivot, feasibility spike (not application code yet): can BRC-100 wallets fund, claim and refund a
// hash-time-locked output? It runs on wallet-toolbox's mock chain with real wallet-toolbox wallets, the engine BSV
// Desktop runs. Two buyers fund one purchase with separate HTLC outputs that share the seller's hash; the seller
// claims both in one transaction by revealing the key, which the buyers then read from that transaction. A third
// HTLC is refunded after its lock height.
//
// BSV has no OP_CHECKLOCKTIMEVERIFY (a NOP since Genesis, and in @bsv/sdk's interpreter), so a script cannot check
// a timeout. The timeout is the refund transaction's nLockTime instead: before a buyer broadcasts the funding, the
// seller signs the refund in advance with NONE | ANYONECANPAY | FORKID, which still commits to the outpoint, the
// input's sequence and nLockTime. A transaction is not final, so it cannot be mined, until its nLockTime has passed;
// wallet-toolbox also refuses to process it before then (nLockTimeIsFinal, against the mock chain's height here).
import {
  BigNumber,
  ECDSA,
  Hash,
  LockingScript,
  OP,
  PrivateKey,
  PublicKey,
  Random,
  Signature,
  Spend,
  SymmetricKey,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  Beef,
  type AtomicBEEF,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockChain, type MockChain } from './helpers/mockchain'

const PROTOCOL: WalletProtocol = [1, 'flashcrowd htlc']
const ALL = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
/** 0xC2: the seller's refund signature covers only the HTLC input, its sequence and nLockTime. */
const REFUND_SCOPE =
  TransactionSignature.SIGHASH_NONE |
  TransactionSignature.SIGHASH_ANYONECANPAY |
  TransactionSignature.SIGHASH_FORKID
/** Below 0xffffffff, so nLockTime applies. */
const REFUND_SEQUENCE = 0xfffffffe
/** <signature> <key> OP_1 */
const CLAIM_UNLOCK_LENGTH = 74 + 33 + 1
/** <buyer signature> <seller signature> OP_0 */
const REFUND_UNLOCK_LENGTH = 74 + 74 + 1

interface Htlc {
  txid: string
  vout: number
  satoshis: number
  script: LockingScript
  /** AtomicBEEF of the funding transaction, from the buyer's wallet. */
  beef: AtomicBEEF
}

const push = (data: number[]): { op: number; data: number[] } => ({ op: data.length, data })

/**
 * OP_IF     OP_SHA256 <hash> OP_EQUALVERIFY <seller> OP_CHECKSIG          claim: the key and the seller's signature
 * OP_ELSE   <seller> OP_CHECKSIGVERIFY <buyer> OP_CHECKSIG                refund: the seller's pre-signature + the buyer
 * OP_ENDIF
 */
function htlcScript(hash: number[], sellerKey: string, buyerKey: string): LockingScript {
  const seller = Utils.toArray(sellerKey, 'hex')
  const buyer = Utils.toArray(buyerKey, 'hex')
  return new LockingScript([
    { op: OP.OP_IF },
    { op: OP.OP_SHA256 },
    push(hash),
    { op: OP.OP_EQUALVERIFY },
    push(seller),
    { op: OP.OP_CHECKSIG },
    { op: OP.OP_ELSE },
    push(seller),
    { op: OP.OP_CHECKSIGVERIFY },
    push(buyer),
    { op: OP.OP_CHECKSIG },
    { op: OP.OP_ENDIF },
  ])
}

const keyOf = async (wallet: WalletInterface, keyID: string): Promise<string> =>
  (await wallet.getPublicKey({ protocolID: PROTOCOL, keyID, counterparty: 'self' })).publicKey

const inputIndexOf = (tx: Transaction, h: Htlc): number =>
  tx.inputs.findIndex(
    (i) => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === h.txid && i.sourceOutputIndex === h.vout,
  )

/** The wallet signs input `index` of `tx` (sources attached) with its key for `keyID`; checksig format. */
async function signInput(
  wallet: WalletInterface,
  tx: Transaction,
  index: number,
  keyID: string,
  scope: number,
): Promise<number[]> {
  const input = tx.inputs[index]
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== index),
    inputIndex: index,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope,
  })
  const { signature } = await wallet.createSignature({
    hashToDirectlySign: Hash.hash256(preimage),
    protocolID: PROTOCOL,
    keyID,
    counterparty: 'self',
  })
  const sig = Signature.fromDER(signature)
  return new TransactionSignature(sig.r, sig.s, scope).toChecksigFormat()
}

/** What the seller's refund signature commits to: the HTLC outpoint, its value and script, sequence, nLockTime. */
const refundPreimage = (h: Htlc, lockTime: number): number[] =>
  TransactionSignature.format({
    sourceTXID: h.txid,
    sourceOutputIndex: h.vout,
    sourceSatoshis: h.satoshis,
    transactionVersion: 1,
    otherInputs: [],
    inputIndex: 0,
    outputs: [],
    inputSequence: REFUND_SEQUENCE,
    subscript: h.script,
    lockTime,
    scope: REFUND_SCOPE,
  })

/** The seller signs a buyer's refund before the funding is broadcast. It needs only txid, vout, value and script. */
async function presignRefund(
  seller: WalletInterface,
  keyID: string,
  h: Htlc,
  lockTime: number,
): Promise<number[]> {
  const { signature } = await seller.createSignature({
    hashToDirectlySign: Hash.hash256(refundPreimage(h, lockTime)),
    protocolID: PROTOCOL,
    keyID,
    counterparty: 'self',
  })
  const sig = Signature.fromDER(signature)
  return new TransactionSignature(sig.r, sig.s, REFUND_SCOPE).toChecksigFormat()
}

/** The buyer checks the seller's refund signature locally, without a wallet, before broadcasting the funding. */
function refundSignatureValid(sellerKey: string, h: Htlc, lockTime: number, checksigSig: number[]): boolean {
  if (checksigSig.at(-1) !== REFUND_SCOPE) return false
  return ECDSA.verify(
    new BigNumber(Hash.hash256(refundPreimage(h, lockTime))),
    Signature.fromDER(checksigSig.slice(0, -1)),
    PublicKey.fromString(sellerKey),
  )
}

/** The buyer's wallet signs the funding but keeps it (noSend) until the seller's refund signature is in hand. */
async function fundHtlc(buyer: WalletInterface, script: LockingScript, satoshis: number): Promise<Htlc> {
  const res = await buyer.createAction({
    description: 'Fund a FlashCrowd HTLC',
    outputs: [{ lockingScript: script.toHex(), satoshis, outputDescription: 'HTLC contribution' }],
    options: { randomizeOutputs: false, noSend: true },
  })
  if (res.txid === undefined || res.tx === undefined) throw new Error('the wallet did not sign the funding')
  const vout = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex(
    (o) => o.lockingScript.toHex() === script.toHex(),
  )
  return { txid: res.txid, vout, satoshis, script, beef: res.tx }
}

async function sendFunding(buyer: WalletInterface, txid: string): Promise<string> {
  const res = await buyer.createAction({
    description: 'Send HTLC funding',
    options: { sendWith: [txid], acceptDelayedBroadcast: false },
  })
  const status = res.sendWithResults?.find((r) => r.txid === txid)?.status
  if (status === undefined || status === 'failed') throw new Error(`funding ${txid} was not sent (${status})`)
  return status
}

/** The seller spends every HTLC of the purchase in one transaction; the wallet takes the value in as change. */
async function claimHtlcs(seller: WalletInterface, keyID: string, secret: number[], htlcs: Htlc[]) {
  const beef = new Beef()
  for (const h of htlcs) beef.mergeBeef(h.beef)
  const created = await seller.createAction({
    description: 'Claim FlashCrowd HTLCs',
    inputBEEF: beef.toBinary(),
    inputs: htlcs.map((h) => ({
      outpoint: `${h.txid}.${h.vout}`,
      unlockingScriptLength: CLAIM_UNLOCK_LENGTH,
      inputDescription: 'HTLC contribution',
    })),
    outputs: [],
    options: { acceptDelayedBroadcast: false },
  })
  const signable = created.signableTransaction!
  const tx = Transaction.fromAtomicBEEF(signable.tx)
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const h of htlcs) {
    const index = inputIndexOf(tx, h)
    const sig = await signInput(seller, tx, index, keyID, ALL)
    spends[index] = {
      unlockingScript: new UnlockingScript([push(sig), push(secret), { op: OP.OP_1 }]).toHex(),
    }
  }
  const signed = await seller.signAction({
    reference: signable.reference,
    spends,
    options: { acceptDelayedBroadcast: false },
  })
  return { txid: signed.txid!, beef: signed.tx! }
}

/** After the lock height the buyer spends its HTLC back with the seller's pre-signature and its own signature. */
async function refundHtlc(
  buyer: WalletInterface,
  keyID: string,
  h: Htlc,
  lockTime: number,
  sellerSig: number[],
): Promise<{ txid: string; beef: AtomicBEEF }> {
  const created = await buyer.createAction({
    description: 'Refund a FlashCrowd HTLC',
    inputBEEF: h.beef,
    inputs: [
      {
        outpoint: `${h.txid}.${h.vout}`,
        unlockingScriptLength: REFUND_UNLOCK_LENGTH,
        sequenceNumber: REFUND_SEQUENCE,
        inputDescription: 'HTLC refund',
      },
    ],
    outputs: [],
    lockTime,
    version: 1,
    options: { acceptDelayedBroadcast: false },
  })
  const signable = created.signableTransaction!
  const tx = Transaction.fromAtomicBEEF(signable.tx)
  const index = inputIndexOf(tx, h)
  const buyerSig = await signInput(buyer, tx, index, keyID, ALL)
  try {
    const signed = await buyer.signAction({
      reference: signable.reference,
      spends: {
        [index]: {
          unlockingScript: new UnlockingScript([push(buyerSig), push(sellerSig), { op: OP.OP_0 }]).toHex(),
        },
      },
      options: { acceptDelayedBroadcast: false },
    })
    return { txid: signed.txid!, beef: signed.tx! }
  } catch (e) {
    await buyer.abortAction({ reference: signable.reference }).catch(() => undefined)
    throw e
  }
}

/** Script check of one input, as a node would run it (version 1: BSV's malleability rules apply). */
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

let chain: MockChain
let seller: Wallet
let alice: Wallet
let bob: Wallet

beforeAll(async () => {
  chain = await createMockChain()
  seller = await chain.makeWallet()
  alice = await chain.makeWallet()
  bob = await chain.makeWallet()
  // The seller gets no funds: the claim pays its fee out of the HTLC values.
  await chain.fund(alice)
  await chain.fund(bob)
})

afterAll(async () => {
  await chain?.close()
})

describe('HTLC spike: two buyers, one key, one claim', () => {
  const GROUP = 'group-1'
  // Simulation data for the spike: a "premium dataset" the seller sells once to the whole group.
  const dataset = JSON.stringify({ simulation: true, pair: 'BSV/USD', closes: ['41.20', '41.35', '40.98'] })
  const secret = Random(32)
  const hash = Hash.sha256(secret)
  const ciphertext = new SymmetricKey(secret).encrypt(Utils.toArray(dataset, 'utf8')) as number[]
  let sellerKey: string
  const funded: Htlc[] = []
  let claim: { txid: string; beef: AtomicBEEF }

  it('each buyer funds its own HTLC with the shared hash, broadcast only after the seller pre-signs its refund', async () => {
    sellerKey = await keyOf(seller, GROUP)
    const lockTime = (await chain.services.getHeight()) + 20
    for (const [buyer, satoshis] of [
      [alice, 3_000],
      [bob, 4_000],
    ] as const) {
      const before = await buyer.balance()
      const h = await fundHtlc(buyer, htlcScript(hash, sellerKey, await keyOf(buyer, GROUP)), satoshis)
      expect(h.vout).toBeGreaterThanOrEqual(0)
      const sellerSig = await presignRefund(seller, GROUP, h, lockTime)
      expect(refundSignatureValid(sellerKey, h, lockTime, sellerSig)).toBe(true)
      expect(refundSignatureValid(sellerKey, h, lockTime - 1, sellerSig)).toBe(false)
      console.log(`funding ${h.txid}: ${await sendFunding(buyer, h.txid)}`)
      expect(await buyer.balance()).toBeLessThanOrEqual(before - satoshis)
      funded.push(h)
    }
  })

  it('the seller claims both outputs in one transaction by revealing the key', async () => {
    expect(await seller.balance()).toBe(0)
    claim = await claimHtlcs(seller, GROUP, secret, funded)
    const received = await seller.balance()
    console.log(`claim ${claim.txid}: seller received ${received} of 7000 sats`)
    expect(received).toBeGreaterThan(6_900)
    expect(received).toBeLessThanOrEqual(7_000)
  })

  it('every buyer reads the key from the claim and decrypts the dataset', () => {
    const tx = Transaction.fromAtomicBEEF(claim.beef)
    for (const h of funded) {
      const key = tx.inputs[inputIndexOf(tx, h)].unlockingScript!.chunks[1].data!
      expect(Hash.sha256(key)).toEqual(hash)
      expect(Utils.toUTF8(new SymmetricKey(key).decrypt(ciphertext) as number[])).toBe(dataset)
    }
  })

  it('the claim does not validate with a wrong key or with another key signature', () => {
    const tx = Transaction.fromAtomicBEEF(claim.beef)
    const index = inputIndexOf(tx, funded[0])
    expect(inputValid(tx, index)).toBe(true)

    const [sig] = tx.inputs[index].unlockingScript!.chunks
    tx.inputs[index].unlockingScript = new UnlockingScript([
      push(sig.data!),
      push(Random(32)),
      { op: OP.OP_1 },
    ])
    expect(inputValid(tx, index)).toBe(false)

    const stranger = PrivateKey.fromRandom().sign(Random(32))
    const strangerSig = new TransactionSignature(stranger.r, stranger.s, ALL).toChecksigFormat()
    tx.inputs[index].unlockingScript = new UnlockingScript([push(strangerSig), push(secret), { op: OP.OP_1 }])
    expect(inputValid(tx, index)).toBe(false)
  })
})

describe('HTLC spike: refund after the lock height', () => {
  const GROUP = 'group-2'
  let h: Htlc
  let lockTime: number
  let sellerSig: number[]
  let refund: { txid: string; beef: AtomicBEEF }

  it('funds an HTLC whose seller never claims', async () => {
    const sellerKey = await keyOf(seller, GROUP)
    lockTime = (await chain.services.getHeight()) + 2
    h = await fundHtlc(
      alice,
      htlcScript(Hash.sha256(Random(32)), sellerKey, await keyOf(alice, GROUP)),
      5_000,
    )
    sellerSig = await presignRefund(seller, GROUP, h, lockTime)
    expect(refundSignatureValid(sellerKey, h, lockTime, sellerSig)).toBe(true)
    await sendFunding(alice, h.txid)
  })

  it('refuses the refund before the lock height (the transaction is not final)', async () => {
    const before = await alice.balance()
    await expect(refundHtlc(alice, GROUP, h, lockTime, sellerSig)).rejects.toThrow(/not final/)
    expect(await alice.balance()).toBe(before)
  })

  it('refunds after the lock height', async () => {
    for (let i = 0; i < 3; i++) await chain.mineBlock()
    const before = await alice.balance()
    refund = await refundHtlc(alice, GROUP, h, lockTime, sellerSig)
    const back = (await alice.balance()) - before
    console.log(`refund ${refund.txid}: buyer got back ${back} of 5000 sats`)
    expect(back).toBeGreaterThan(4_900)
    expect(back).toBeLessThanOrEqual(5_000)
  })

  it('the refund does not validate without the seller pre-signature or with another lock time', () => {
    const tx = Transaction.fromAtomicBEEF(refund.beef)
    const index = inputIndexOf(tx, h)
    expect(tx.lockTime).toBe(lockTime)
    expect(inputValid(tx, index)).toBe(true)

    const [buyerSig] = tx.inputs[index].unlockingScript!.chunks
    tx.inputs[index].unlockingScript = new UnlockingScript([
      push(buyerSig.data!),
      push(buyerSig.data!),
      { op: OP.OP_0 },
    ])
    expect(inputValid(tx, index)).toBe(false)

    const shifted = Transaction.fromAtomicBEEF(refund.beef)
    shifted.lockTime = lockTime - 1
    expect(inputValid(shifted, index)).toBe(false)
  })
})
