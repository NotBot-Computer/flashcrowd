// FlashCrowd HTLCs (docs/FLASHCROWD_TASK.md). Each buyer funds its own output; all of a group's outputs share the
// seller's hash H = sha256(K), and the seller claims them in one transaction by revealing K, which decrypts the data.
//
// BSV has no OP_CHECKLOCKTIMEVERIFY (a NOP since Genesis), so a script cannot check a timeout. The timeout is the
// refund's nLockTime instead: before a buyer broadcasts its funding, the seller signs the refund in advance with
// NONE | ANYONECANPAY | FORKID, which commits to the outpoint, the input's sequence and nLockTime. A transaction is
// not final, so it cannot be mined, until its nLockTime has passed.
//
// Keys: every party's HTLC key is derived under [1, 'flashcrowd htlc'], keyID = groupId, counterparty 'anyone', so
// anyone can derive it from the party's identity key and check that a script names the right people.
import {
  Beef,
  BigNumber,
  ECDSA,
  Hash,
  LockingScript,
  OP,
  ProtoWallet,
  PublicKey,
  Random,
  Signature,
  SymmetricKey,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type ChainTracker,
  type WalletProtocol,
} from '@bsv/sdk'
import { ARCADE_URL, wocTxUrl } from './config'
import type { CoreContext } from './context'
import { ArcadeChainTracker } from './kit/client/arcadeChainTracker'
import type { TxResult } from './tokens'
import type { ClaimProof, FundingContribution, HtlcTerms, RefundProof, UnsignedTerms } from './types'

/** HTLC functions need no overlay. */
export type HtlcContext = Pick<CoreContext, 'wallet' | 'network' | 'originator'>

export const HTLC_PROTOCOL: WalletProtocol = [1, 'flashcrowd htlc']
export const TERMS_PROTOCOL: WalletProtocol = [1, 'flashcrowd terms']

/** 0xC2: the seller's refund signature covers only the HTLC input, its sequence and nLockTime. */
export const REFUND_SIGHASH =
  TransactionSignature.SIGHASH_NONE |
  TransactionSignature.SIGHASH_ANYONECANPAY |
  TransactionSignature.SIGHASH_FORKID

/**
 * Smallest share we accept: it must pay the claim's or the refund's fee out of the HTLC value. Our choice, not a
 * network rule.
 */
export const MIN_CONTRIBUTION_SATS = 1_000

const ALL = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
/** Below 0xffffffff, so nLockTime applies. */
const REFUND_SEQUENCE = 0xfffffffe
/** Version 1: BSV's malleability rules apply to the scripts. */
const VERSION = 1
/** nLockTime below this is a block height. */
const LOCKTIME_THRESHOLD = 500_000_000
/** <signature> <K> OP_1 */
const CLAIM_UNLOCK_LENGTH = 74 + 33 + 1
/** <buyer signature> <seller signature> OP_0 */
const REFUND_UNLOCK_LENGTH = 74 + 74 + 1

/** Something is wrong with the terms, a contribution or a claim, as opposed to the wallet or network failing. */
export class InvalidHtlcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidHtlcError'
  }
}

/** The wallet did not get a transaction to the network. */
export class BroadcastError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BroadcastError'
  }
}

const anyone = new ProtoWallet('anyone')
const HEX32 = /^[0-9a-f]{64}$/
const PUBKEY = /^0[23][0-9a-f]{64}$/

// Seller: secret and data

/** A fresh 32-byte secret K from a secure source, and H = sha256(K) in hex. */
export function newSecret(): { secret: number[]; hash: string } {
  const secret = Random(32)
  return { secret, hash: Utils.toHex(Hash.sha256(secret)) }
}

/** AES-256-GCM with K as the key and a random IV per call; ciphertextHash goes into the terms. */
export function encryptResource(
  secret: number[],
  plaintext: number[],
): { ciphertext: string; ciphertextHash: string } {
  const ciphertext = new SymmetricKey(secret).encrypt(plaintext) as number[]
  return { ciphertext: Utils.toHex(ciphertext), ciphertextHash: Utils.toHex(Hash.sha256(ciphertext)) }
}

/**
 * Checks K against the terms' hash and the ciphertext against the terms' ciphertextHash, then decrypts. GCM
 * authenticates the data, which proves the seller encrypted it, not that it is any good.
 */
export function decryptResource(terms: HtlcTerms, secret: number[], ciphertext: string): number[] {
  if (Utils.toHex(Hash.sha256(secret)) !== terms.hash) {
    throw new InvalidHtlcError('the secret does not match the hash in the terms')
  }
  const bytes = Utils.toArray(ciphertext, 'hex')
  if (Utils.toHex(Hash.sha256(bytes)) !== terms.ciphertextHash) {
    throw new InvalidHtlcError('the ciphertext is not the one the terms name')
  }
  return new SymmetricKey(secret).decrypt(bytes) as number[]
}

// Keys and script

/** The caller's own HTLC key for `groupId`. */
export async function htlcKey(ctx: HtlcContext, groupId: string): Promise<string> {
  const { publicKey } = await ctx.wallet.getPublicKey(
    { protocolID: HTLC_PROTOCOL, keyID: groupId, counterparty: 'anyone', forSelf: true },
    ctx.originator,
  )
  return publicKey
}

/** Someone else's HTLC key for `groupId`, derived from their identity key. */
export async function htlcKeyOf(identityKey: string, groupId: string): Promise<string> {
  const { publicKey } = await anyone.getPublicKey({
    protocolID: HTLC_PROTOCOL,
    keyID: groupId,
    counterparty: identityKey,
  })
  return publicKey
}

const push = (data: number[]): { op: number; data: number[] } => ({ op: data.length, data })

/**
 * OP_IF     OP_SHA256 <hash> OP_EQUALVERIFY <seller> OP_CHECKSIG          claim: K and the seller's signature
 * OP_ELSE   <seller> OP_CHECKSIGVERIFY <buyer> OP_CHECKSIG                refund: the seller's pre-signature + the buyer
 * OP_ENDIF
 */
export function htlcScript(
  terms: Pick<UnsignedTerms, 'hash' | 'sellerKey'>,
  buyerKey: string,
): LockingScript {
  const seller = Utils.toArray(terms.sellerKey, 'hex')
  return new LockingScript([
    { op: OP.OP_IF },
    { op: OP.OP_SHA256 },
    push(Utils.toArray(terms.hash, 'hex')),
    { op: OP.OP_EQUALVERIFY },
    push(seller),
    { op: OP.OP_CHECKSIG },
    { op: OP.OP_ELSE },
    push(seller),
    { op: OP.OP_CHECKSIGVERIFY },
    push(Utils.toArray(buyerKey, 'hex')),
    { op: OP.OP_CHECKSIG },
    { op: OP.OP_ENDIF },
  ])
}

// Terms

/** What the seller signs: every field but the signature, in a fixed order. */
function termsMessage(t: UnsignedTerms): number[] {
  return Utils.toArray(
    JSON.stringify([
      'flashcrowd terms v1',
      t.groupId,
      t.network,
      t.serviceId,
      t.resourceId,
      t.sellerIdentityKey,
      t.sellerKey,
      t.priceSats,
      t.shares.map((s) => [s.identityKey, s.shareSats]),
      t.hash,
      t.ciphertextHash,
      t.refundHeight,
    ]),
    'utf8',
  )
}

const isSats = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0

/** Shape and arithmetic of the terms; the signature is checked by verifyTerms. */
function checkTerms(t: UnsignedTerms): void {
  const fail = (reason: string): never => {
    throw new InvalidHtlcError(`invalid terms: ${reason}`)
  }
  for (const field of ['groupId', 'serviceId', 'resourceId'] as const) {
    if (typeof t[field] !== 'string' || t[field] === '') fail(`${field} is missing`)
  }
  if (t.network !== 'testnet' && t.network !== 'mainnet') fail('unknown network')
  if (!PUBKEY.test(t.sellerIdentityKey) || !PUBKEY.test(t.sellerKey)) fail('bad seller key')
  if (!HEX32.test(t.hash) || !HEX32.test(t.ciphertextHash)) fail('bad hash')
  if (!isSats(t.priceSats)) fail('priceSats must be a positive integer')
  if (!Number.isSafeInteger(t.refundHeight) || t.refundHeight <= 0 || t.refundHeight >= LOCKTIME_THRESHOLD) {
    fail('refundHeight must be a block height')
  }
  if (!Array.isArray(t.shares) || t.shares.length === 0) fail('no shares')
  let sum = 0
  t.shares.forEach((s, i) => {
    if (!PUBKEY.test(s.identityKey)) fail('bad buyer key')
    if (i > 0 && t.shares[i - 1].identityKey >= s.identityKey) fail('shares must be sorted, one per buyer')
    if (s.identityKey === t.sellerIdentityKey) fail('the seller cannot be a buyer')
    if (!isSats(s.shareSats) || s.shareSats < MIN_CONTRIBUTION_SATS) {
      fail(`every share must be an integer of at least ${MIN_CONTRIBUTION_SATS} sats`)
    }
    sum += s.shareSats
  })
  if (sum !== t.priceSats) fail(`shares add up to ${sum}, not ${t.priceSats}`)
}

const identityOf = async (ctx: HtlcContext): Promise<string> =>
  (await ctx.wallet.getPublicKey({ identityKey: true }, ctx.originator)).publicKey

/** The seller signs the terms with its identity; it must be the seller they name. */
export async function signTerms(ctx: HtlcContext, terms: UnsignedTerms): Promise<HtlcTerms> {
  checkTerms(terms)
  if ((await identityOf(ctx)) !== terms.sellerIdentityKey) {
    throw new InvalidHtlcError('only the seller named in the terms can sign them')
  }
  if ((await htlcKey(ctx, terms.groupId)) !== terms.sellerKey) {
    throw new InvalidHtlcError("sellerKey is not the seller's HTLC key for this group")
  }
  const { signature } = await ctx.wallet.createSignature(
    { data: termsMessage(terms), protocolID: TERMS_PROTOCOL, keyID: terms.groupId, counterparty: 'anyone' },
    ctx.originator,
  )
  return { ...terms, signature: Utils.toHex(signature) }
}

/**
 * Throws InvalidHtlcError unless the terms are well formed, the shares add up to the price, sellerKey is the
 * seller's HTLC key for the group, and the seller's identity signed exactly these terms.
 */
export async function verifyTerms(terms: HtlcTerms): Promise<void> {
  checkTerms(terms)
  if ((await htlcKeyOf(terms.sellerIdentityKey, terms.groupId)) !== terms.sellerKey) {
    throw new InvalidHtlcError("sellerKey is not the seller's HTLC key for this group")
  }
  try {
    await anyone.verifySignature({
      data: termsMessage(terms),
      signature: Utils.toArray(terms.signature, 'hex'),
      protocolID: TERMS_PROTOCOL,
      keyID: terms.groupId,
      counterparty: terms.sellerIdentityKey,
    })
  } catch {
    throw new InvalidHtlcError('the seller did not sign these terms')
  }
}

function shareOf(terms: UnsignedTerms, identityKey: string): number {
  const share = terms.shares.find((s) => s.identityKey === identityKey)
  if (share === undefined) throw new InvalidHtlcError('this identity has no share in the group')
  return share.shareSats
}

/** A contribution's outpoint, value and script are the ones the terms give its buyer. */
async function checkContribution(terms: HtlcTerms, c: FundingContribution): Promise<void> {
  if (!HEX32.test(c.txid) || !Number.isSafeInteger(c.vout) || c.vout < 0) {
    throw new InvalidHtlcError('bad contribution outpoint')
  }
  if (c.satoshis !== shareOf(terms, c.identityKey)) {
    throw new InvalidHtlcError(`the contribution holds ${c.satoshis} sats, not the agreed share`)
  }
  const expected = htlcScript(terms, await htlcKeyOf(c.identityKey, terms.groupId)).toHex()
  if (c.lockingScript !== expected)
    throw new InvalidHtlcError('the contribution has the wrong locking script')
}

// Buyer: funding

/**
 * Verifies the terms, then has the buyer's wallet sign a funding transaction with one HTLC output for the buyer's
 * share, without broadcasting it (noSend). Send the seller only `contribution`; keep `beef` until the refund
 * signature is back (broadcastContribution).
 */
export async function prepareContribution(
  ctx: HtlcContext,
  terms: HtlcTerms,
): Promise<{ contribution: FundingContribution; beef: string }> {
  await verifyTerms(terms)
  if (terms.network !== ctx.network) {
    throw new InvalidHtlcError(`the terms are on ${terms.network}, the wallet on ${ctx.network}`)
  }
  const identityKey = await identityOf(ctx)
  const satoshis = shareOf(terms, identityKey)
  const script = htlcScript(terms, await htlcKey(ctx, terms.groupId)).toHex()
  const res = await ctx.wallet.createAction(
    {
      description: 'Fund a FlashCrowd purchase',
      outputs: [{ lockingScript: script, satoshis, outputDescription: 'FlashCrowd HTLC' }],
      options: { randomizeOutputs: false, noSend: true },
    },
    ctx.originator,
  )
  if (res.txid === undefined || res.tx === undefined) throw new Error('the wallet did not sign the funding')
  const vout = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex((o) => o.lockingScript.toHex() === script)
  if (vout < 0) {
    await ctx.wallet.abortAction({ reference: res.txid }, ctx.originator)
    throw new Error('the wallet left out the HTLC output; aborted')
  }
  return {
    contribution: { identityKey, txid: res.txid, vout, satoshis, lockingScript: script, status: 'prepared' },
    beef: Utils.toHex(res.tx),
  }
}

/** What the seller's refund signature commits to: the HTLC outpoint, its value and script, sequence, nLockTime. */
const refundPreimage = (c: FundingContribution, lockTime: number): number[] =>
  TransactionSignature.format({
    sourceTXID: c.txid,
    sourceOutputIndex: c.vout,
    sourceSatoshis: c.satoshis,
    transactionVersion: VERSION,
    otherInputs: [],
    inputIndex: 0,
    outputs: [],
    inputSequence: REFUND_SEQUENCE,
    subscript: LockingScript.fromHex(c.lockingScript),
    lockTime,
    scope: REFUND_SIGHASH,
  })

/**
 * Seller: checks that the contribution is the buyer's agreed HTLC, then signs its refund for nLockTime =
 * refundHeight in advance. Returns the signature in checksig format (hex).
 */
export async function signRefund(
  ctx: HtlcContext,
  terms: HtlcTerms,
  c: FundingContribution,
): Promise<string> {
  if ((await identityOf(ctx)) !== terms.sellerIdentityKey) {
    throw new InvalidHtlcError('only the seller named in the terms signs refunds')
  }
  await checkContribution(terms, c)
  const { signature } = await ctx.wallet.createSignature(
    {
      hashToDirectlySign: Hash.hash256(refundPreimage(c, terms.refundHeight)),
      protocolID: HTLC_PROTOCOL,
      keyID: terms.groupId,
      counterparty: 'anyone',
    },
    ctx.originator,
  )
  const sig = Signature.fromDER(signature)
  return Utils.toHex(new TransactionSignature(sig.r, sig.s, REFUND_SIGHASH).toChecksigFormat())
}

/** Buyer: checks the seller's refund signature locally, without a wallet. */
export function verifyRefundSignature(terms: HtlcTerms, c: FundingContribution, signature: string): boolean {
  try {
    const bytes = Utils.toArray(signature, 'hex')
    if (bytes.at(-1) !== REFUND_SIGHASH) return false
    return ECDSA.verify(
      new BigNumber(Hash.hash256(refundPreimage(c, terms.refundHeight))),
      Signature.fromDER(bytes.slice(0, -1)),
      PublicKey.fromString(terms.sellerKey),
    )
  } catch {
    return false
  }
}

/**
 * Broadcasts a prepared funding, but only with a valid refund signature from the seller in `c.refundSignature`.
 * Returns the contribution with its BEEF, ready for the seller's verifyFunding.
 */
export async function broadcastContribution(
  ctx: HtlcContext,
  terms: HtlcTerms,
  c: FundingContribution,
  beef: string,
): Promise<TxResult & { contribution: FundingContribution }> {
  if (c.refundSignature === undefined || !verifyRefundSignature(terms, c, c.refundSignature)) {
    throw new InvalidHtlcError('no valid refund signature from the seller; not broadcasting')
  }
  if (Transaction.fromAtomicBEEF(Utils.toArray(beef, 'hex')).id('hex') !== c.txid) {
    throw new InvalidHtlcError('the BEEF is not this contribution')
  }
  let status: string | undefined
  try {
    const res = await ctx.wallet.createAction(
      {
        description: 'Send FlashCrowd funding',
        options: { sendWith: [c.txid], acceptDelayedBroadcast: false },
      },
      ctx.originator,
    )
    status = res.sendWithResults?.find((r) => r.txid === c.txid)?.status
  } catch (e) {
    throw new BroadcastError(`funding ${c.txid} was not sent: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (status === undefined || status === 'failed') {
    throw new BroadcastError(`funding ${c.txid} was not sent (${status ?? 'no result'})`)
  }
  return {
    txid: c.txid,
    wocUrl: wocTxUrl(c.txid, ctx.network),
    contribution: { ...c, beef, status: 'broadcast' },
  }
}

/** Gives up a prepared funding that was never broadcast: the wallet releases its inputs. */
export async function abandonContribution(ctx: HtlcContext, c: FundingContribution): Promise<void> {
  await ctx.wallet.abortAction({ reference: c.txid }, ctx.originator)
}

// Seller: verification and claim

/**
 * Throws InvalidHtlcError unless `c.beef` is the contribution's transaction, its output is the buyer's agreed HTLC
 * with the agreed share, and the transaction passes SPV against `chainTracker` (Arcade by default).
 */
export async function verifyFunding(
  terms: HtlcTerms,
  c: FundingContribution,
  chainTracker: ChainTracker = new ArcadeChainTracker(ARCADE_URL[terms.network]),
): Promise<void> {
  if (c.beef === undefined) throw new InvalidHtlcError('the contribution has no BEEF')
  await checkContribution(terms, c)
  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(Utils.toArray(c.beef, 'hex'))
  } catch {
    throw new InvalidHtlcError('the contribution BEEF does not parse')
  }
  if (tx.id('hex') !== c.txid) throw new InvalidHtlcError('the BEEF is not this contribution')
  const out = tx.outputs[c.vout]
  if (out?.lockingScript.toHex() !== c.lockingScript || out.satoshis !== c.satoshis) {
    throw new InvalidHtlcError('the funding transaction does not hold the agreed HTLC')
  }
  let valid: boolean
  try {
    valid = await tx.verify(chainTracker)
  } catch (e) {
    throw new InvalidHtlcError(`SPV check failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!valid) throw new InvalidHtlcError('SPV check failed')
}

const inputIndexOf = (tx: Transaction, c: FundingContribution): number =>
  tx.inputs.findIndex(
    (i) => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === c.txid && i.sourceOutputIndex === c.vout,
  )

/** The wallet signs input `index` of `tx` (sources attached) with its HTLC key; checksig format. */
async function signInput(
  ctx: HtlcContext,
  tx: Transaction,
  index: number,
  groupId: string,
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
  const { signature } = await ctx.wallet.createSignature(
    {
      hashToDirectlySign: Hash.hash256(preimage),
      protocolID: HTLC_PROTOCOL,
      keyID: groupId,
      counterparty: 'anyone',
    },
    ctx.originator,
  )
  const sig = Signature.fromDER(signature)
  return new TransactionSignature(sig.r, sig.s, scope).toChecksigFormat()
}

/**
 * Seller: spends every contribution of the group in one transaction by revealing K; the wallet takes the value in
 * as change. Refuses unless K matches the hash, the contributions are exactly one per share, and the chain is still
 * below refundHeight (afterwards the buyers may be refunding). The caller verifies each funding first.
 */
export async function claimContributions(
  ctx: HtlcContext,
  terms: HtlcTerms,
  secret: number[],
  contributions: FundingContribution[],
): Promise<ClaimProof & { beef: string }> {
  if (Utils.toHex(Hash.sha256(secret)) !== terms.hash) {
    throw new InvalidHtlcError('the secret does not match the hash in the terms')
  }
  const buyers = new Set(contributions.map((c) => c.identityKey))
  if (buyers.size !== contributions.length || buyers.size !== terms.shares.length) {
    throw new InvalidHtlcError('a claim needs exactly one contribution per share')
  }
  for (const c of contributions) {
    await checkContribution(terms, c)
    if (c.beef === undefined) throw new InvalidHtlcError('a contribution has no BEEF')
  }
  const { height } = await ctx.wallet.getHeight({}, ctx.originator)
  if (height >= terms.refundHeight) {
    throw new InvalidHtlcError(`too late to claim: height ${height}, refunds from ${terms.refundHeight}`)
  }
  const beef = new Beef()
  for (const c of contributions) beef.mergeBeef(Utils.toArray(c.beef!, 'hex'))
  const created = await ctx.wallet.createAction(
    {
      description: 'Claim a FlashCrowd purchase',
      inputBEEF: beef.toBinary(),
      inputs: contributions.map((c) => ({
        outpoint: `${c.txid}.${c.vout}`,
        unlockingScriptLength: CLAIM_UNLOCK_LENGTH,
        inputDescription: 'FlashCrowd HTLC',
      })),
      outputs: [],
      options: { acceptDelayedBroadcast: false },
    },
    ctx.originator,
  )
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('the wallet did not return a signable claim')
  const tx = Transaction.fromAtomicBEEF(signable.tx)
  const spends: Record<number, { unlockingScript: string }> = {}
  for (const c of contributions) {
    const index = inputIndexOf(tx, c)
    const sig = await signInput(ctx, tx, index, terms.groupId, ALL)
    spends[index] = {
      unlockingScript: new UnlockingScript([push(sig), push(secret), { op: OP.OP_1 }]).toHex(),
    }
  }
  const signed = await ctx.wallet.signAction(
    { reference: signable.reference, spends, options: { acceptDelayedBroadcast: false } },
    ctx.originator,
  )
  if (signed.txid === undefined || signed.tx === undefined)
    throw new Error('the wallet did not complete the claim')
  return {
    txid: signed.txid,
    wocUrl: wocTxUrl(signed.txid, ctx.network),
    secret: Utils.toHex(secret),
    outpoints: contributions.map((c) => `${c.txid}.${c.vout}`),
    beef: Utils.toHex(signed.tx),
  }
}

/** Buyer: reads K from a claim transaction (hex AtomicBEEF or raw hex) and checks it against the terms' hash. */
export function secretFromClaim(terms: HtlcTerms, claimTx: string): number[] {
  const bytes = Utils.toArray(claimTx, 'hex')
  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(bytes)
  } catch {
    tx = Transaction.fromBinary(bytes)
  }
  for (const input of tx.inputs) {
    const chunks = input.unlockingScript?.chunks ?? []
    const key = chunks[1]?.data
    if (chunks.length === 3 && chunks[2].op === OP.OP_1 && key !== undefined) {
      if (Utils.toHex(Hash.sha256(key)) === terms.hash) return key
    }
  }
  throw new InvalidHtlcError('the transaction reveals no key for these terms')
}

// Buyer: refund

/**
 * After refundHeight, the buyer spends its own contribution back with the seller's pre-signature and its own
 * signature. Before then the wallet refuses the transaction as not final.
 */
export async function refundContribution(
  ctx: HtlcContext,
  terms: HtlcTerms,
  c: FundingContribution,
): Promise<RefundProof> {
  if ((await identityOf(ctx)) !== c.identityKey) {
    throw new InvalidHtlcError('only the buyer who funded a contribution can refund it')
  }
  if (c.beef === undefined) throw new InvalidHtlcError('the contribution has no BEEF')
  if (c.refundSignature === undefined || !verifyRefundSignature(terms, c, c.refundSignature)) {
    throw new InvalidHtlcError('no valid refund signature from the seller')
  }
  const created = await ctx.wallet.createAction(
    {
      description: 'Refund a FlashCrowd contribution',
      inputBEEF: Utils.toArray(c.beef, 'hex'),
      inputs: [
        {
          outpoint: `${c.txid}.${c.vout}`,
          unlockingScriptLength: REFUND_UNLOCK_LENGTH,
          sequenceNumber: REFUND_SEQUENCE,
          inputDescription: 'FlashCrowd HTLC refund',
        },
      ],
      outputs: [],
      lockTime: terms.refundHeight,
      version: VERSION,
      options: { acceptDelayedBroadcast: false },
    },
    ctx.originator,
  )
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('the wallet did not return a signable refund')
  const tx = Transaction.fromAtomicBEEF(signable.tx)
  const index = inputIndexOf(tx, c)
  const buyerSig = await signInput(ctx, tx, index, terms.groupId, ALL)
  const sellerSig = Utils.toArray(c.refundSignature, 'hex')
  try {
    const signed = await ctx.wallet.signAction(
      {
        reference: signable.reference,
        spends: {
          [index]: {
            unlockingScript: new UnlockingScript([push(buyerSig), push(sellerSig), { op: OP.OP_0 }]).toHex(),
          },
        },
        options: { acceptDelayedBroadcast: false },
      },
      ctx.originator,
    )
    if (signed.txid === undefined) throw new Error('the wallet did not complete the refund')
    return {
      identityKey: c.identityKey,
      txid: signed.txid,
      wocUrl: wocTxUrl(signed.txid, ctx.network),
      outpoint: `${c.txid}.${c.vout}`,
    }
  } catch (e) {
    await ctx.wallet.abortAction({ reference: signable.reference }, ctx.originator).catch(() => undefined)
    throw e
  }
}
