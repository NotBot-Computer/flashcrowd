// Atomic offers (docs/ARCHITECTURE.md#atomic-offer). The maker signs input 0 (the token UTXO) together with output 0
// (the price, paid to the maker) with SIGHASH_SINGLE | ANYONECANPAY | FORKID. A taker completes the transaction from
// their own wallet, adding funding, the token output and change, but cannot change the price or the payee.
import {
  LockingScript,
  P2PKH,
  PublicKey,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type ChainTracker,
} from '@bsv/sdk'
import { wocTxUrl } from './config'
import { tokenKit, type CoreContext } from './context'
import { selectUtxos } from './kit/client/coinselect'
import { OverlayClient, type OverlayOutput } from './kit/client/overlayApi'
import { BRC29_PROTOCOL } from './kit/client/payments'
import { signWalletP2pkhInput } from './kit/client/signer'
import { instructionsFor, receivePkh, TOKEN_BASKET } from './kit/core/addresses'
import {
  buildBsv21Script,
  decodeBsv21,
  isTokenId,
  MAX_U64,
  tokenIdFromOutpoint,
} from './kit/core/inscription'
import type { TxResult } from './tokens'
import type { NewOffer, Outpoint, TokenId } from './types'

/** The maker's sighash type, 0xC3: SIGHASH_SINGLE | SIGHASH_ANYONECANPAY | SIGHASH_FORKID. */
export const OFFER_SIGHASH =
  TransactionSignature.SIGHASH_SINGLE |
  TransactionSignature.SIGHASH_ANYONECANPAY |
  TransactionSignature.SIGHASH_FORKID

// The maker's signature also covers these, so the taker's transaction must keep them.
const VERSION = 1
const LOCK_TIME = 0
const SEQUENCE = 0xffffffff
/** Output 0 pays the maker; the token output comes right after it. */
const TOKEN_VOUT = 1

/** Something is wrong with the offer itself, as opposed to the overlay or the chain tracker being unreachable. */
export class InvalidOfferError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidOfferError'
  }
}

/**
 * Lists `tokenAmount` of `tokenId` for `priceSats`. An offer sells one whole UTXO: if no spendable UTXO holds
 * exactly `tokenAmount`, one is split off first (`splitTxid`). `exclude` takes the outpoints of the maker's open
 * offers, so neither the split nor the new offer touches them.
 */
export async function createOffer(
  ctx: CoreContext,
  args: { tokenId: TokenId; tokenAmount: bigint; priceSats: number; exclude?: readonly Outpoint[] },
): Promise<{ offer: NewOffer; splitTxid?: string }> {
  const { tokenId, tokenAmount, priceSats } = args
  if (tokenAmount <= 0n) throw new Error('tokenAmount must be positive')
  if (!Number.isSafeInteger(priceSats) || priceSats <= 0) {
    throw new Error('priceSats must be a positive integer')
  }
  const kit = tokenKit(ctx)
  const skip = new Set(args.exclude ?? [])
  const { entries, beef } = await kit.spendable(tokenId)
  const free = entries.filter((e) => !skip.has(e.outpoint))
  let utxo = free.find((e) => e.amount === tokenAmount)
  let splitTxid: string | undefined
  if (utxo === undefined) {
    const { selected, total } = selectUtxos(free, tokenAmount)
    const split = await kit.spendInputs(
      selected,
      beef,
      tokenId,
      [
        { to: 'self', amount: tokenAmount },
        ...(total > tokenAmount ? [{ to: 'self' as const, amount: total - tokenAmount }] : []),
      ],
      'Split tokens for an offer',
    )
    splitTxid = split.txid
    // The new UTXO is the split's output on receive key #recipientIndex: found by its key, not by an index.
    utxo = (await kit.spendable(tokenId)).entries.find(
      (e) => e.txid === split.txid && e.instructions.index === split.recipientIndex,
    )
    if (utxo === undefined) throw new Error(`the overlay does not list the new UTXO of split ${split.txid}`)
  }

  // The overlay's copy of the UTXO's transaction comes with its ancestry: the taker's SPV proof.
  const [source] = await kit.overlay.lookup({ op: 'outpoint', txid: utxo.txid, vout: utxo.vout })
  if (source === undefined) throw new Error(`the overlay does not list ${utxo.outpoint}`)
  const makerIdentityKey = await kit.identityKey()
  const payToLockingScript = await makerPaymentScript(ctx, makerIdentityKey, utxo.outpoint)
  const unlockingScript = await signWalletP2pkhInput(
    ctx.wallet,
    offerTemplate(source.tx, utxo.vout, payToLockingScript, priceSats),
    0,
    { protocolID: utxo.instructions.protocolID, keyID: utxo.instructions.keyID },
    ctx.originator,
    OFFER_SIGHASH,
  )
  return {
    offer: {
      id: utxo.outpoint,
      network: ctx.network,
      tokenId,
      tokenAmount: tokenAmount.toString(),
      priceSats,
      makerIdentityKey,
      payToLockingScript,
      unlockingScript: unlockingScript.toHex(),
      sourceBeef: Utils.toHex(source.beef),
    },
    splitTxid,
  }
}

/**
 * Checks an offer before it is listed or filled and throws InvalidOfferError with the reason: the SPV proof of
 * `sourceBeef`; that the UTXO holds exactly `tokenAmount` of `tokenId`; that the maker's signature has sighash 0xC3
 * and covers this UTXO, price and payee; and that the overlay lists the UTXO, unspent, among the maker's own.
 * Network failures (overlay, chain tracker) are thrown as they are.
 */
export async function verifyOffer(
  offer: NewOffer,
  { chainTracker, overlayUrl }: { chainTracker: ChainTracker; overlayUrl: string },
): Promise<void> {
  const { txid, vout, tokenAmount } = checkFields(offer)
  let sourceTx: Transaction
  try {
    sourceTx = Transaction.fromBEEF(Utils.toArray(offer.sourceBeef, 'hex'), txid)
  } catch {
    throw new InvalidOfferError(`sourceBeef does not contain transaction ${txid}`)
  }
  await checkSpv(sourceTx, chainTracker)
  const token = tokenOf(sourceTx, txid, vout)
  if (token === null || token.tokenId !== offer.tokenId) {
    throw new InvalidOfferError(`${offer.id} is not a ${offer.tokenId} output`)
  }
  if (token.amount !== tokenAmount) {
    throw new InvalidOfferError(`${offer.id} holds ${token.amount} tokens, not ${offer.tokenAmount}`)
  }
  checkMakerSignature(
    offerTemplate(sourceTx, vout, offer.payToLockingScript, offer.priceSats),
    offer.unlockingScript,
  )
  await overlayUtxo(new OverlayClient(overlayUrl), offer, txid, vout, tokenAmount)
}

/**
 * Fills an offer from the caller's wallet: it pays `priceSats` to the maker and receives the tokens, or sends them
 * to `tokenRecipient` (an identity key). The overlay must vouch for the UTXO and the maker's signature must hold
 * before the wallet is asked anything, and the wallet's transaction is checked against the signed layout before it
 * is signed and broadcast.
 */
export async function fillOffer(
  ctx: CoreContext,
  offer: NewOffer,
  { tokenRecipient }: { tokenRecipient?: string } = {},
): Promise<TxResult> {
  const { txid, vout, tokenAmount } = checkFields(offer)
  if (offer.network !== ctx.network) {
    throw new InvalidOfferError(`the offer is on ${offer.network}, the wallet on ${ctx.network}`)
  }
  const kit = tokenKit(ctx)
  const utxo = await overlayUtxo(kit.overlay, offer, txid, vout, tokenAmount)
  checkMakerSignature(
    offerTemplate(utxo.tx, vout, offer.payToLockingScript, offer.priceSats),
    offer.unlockingScript,
  )

  const me = await kit.identityKey()
  const recipient = tokenRecipient ?? me
  const toSelf = recipient === me
  const index = await kit.nextIndex(recipient)
  const tokenScript = buildBsv21Script(
    { op: 'transfer', id: offer.tokenId, amt: offer.tokenAmount },
    receivePkh(recipient, index),
  ).toHex()
  const created = await ctx.wallet.createAction(
    {
      description: 'Fill a token offer',
      labels: ['bsv21'],
      inputBEEF: utxo.beef,
      inputs: [
        {
          outpoint: offer.id,
          // The maker's unlocking script goes in with signAction, so the wallet hands the transaction back for
          // checking instead of broadcasting it.
          unlockingScriptLength: offer.unlockingScript.length / 2,
          sequenceNumber: SEQUENCE,
          inputDescription: 'Offered tokens',
        },
      ],
      outputs: [
        {
          lockingScript: offer.payToLockingScript,
          satoshis: offer.priceSats,
          outputDescription: 'Payment to the maker',
        },
        {
          lockingScript: tokenScript,
          satoshis: 1,
          outputDescription: toSelf ? 'Tokens to self' : 'Tokens to recipient',
          ...(toSelf
            ? {
                basket: TOKEN_BASKET,
                customInstructions: JSON.stringify(instructionsFor(index)),
                tags: ['bsv21', `id:${offer.tokenId}`, `amt:${offer.tokenAmount}`],
              }
            : {}),
        },
      ],
      version: VERSION,
      lockTime: LOCK_TIME,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    },
    ctx.originator,
  )
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('wallet did not return a signable transaction')
  const problem = layoutProblem(Transaction.fromAtomicBEEF(signable.tx), offer, txid, vout, tokenScript)
  if (problem !== undefined) {
    await ctx.wallet.abortAction({ reference: signable.reference }, ctx.originator)
    throw new Error(`the wallet did not keep the offer's layout (${problem}); aborted`)
  }
  const signed = await ctx.wallet.signAction(
    {
      reference: signable.reference,
      spends: { 0: { unlockingScript: offer.unlockingScript } },
      options: { acceptDelayedBroadcast: false },
    },
    ctx.originator,
  )
  if (signed.txid === undefined || signed.tx === undefined) {
    throw new Error('wallet did not complete the fill')
  }
  await kit.overlay.submit(signed.tx)
  return { txid: signed.txid, wocUrl: wocTxUrl(signed.txid, ctx.network) }
}

/** Withdraws an offer: the maker moves its token UTXO to a fresh address of their own, which voids the signature. */
export async function cancelOffer(ctx: CoreContext, offer: NewOffer): Promise<TxResult> {
  const kit = tokenKit(ctx)
  if (offer.makerIdentityKey !== (await kit.identityKey())) {
    throw new Error('only the maker can cancel an offer')
  }
  const { entries, beef } = await kit.spendable(offer.tokenId)
  const utxo = entries.find((e) => e.outpoint === offer.id)
  if (utxo === undefined) {
    throw new Error(
      `offer ${offer.id} is not open: its UTXO was spent (filled or cancelled) or is not in this wallet`,
    )
  }
  const { txid } = await kit.spendInputs(
    [utxo],
    beef,
    offer.tokenId,
    [{ to: 'self', amount: utxo.amount }],
    'Cancel a token offer',
  )
  return { txid, wocUrl: wocTxUrl(txid, ctx.network) }
}

/**
 * Takes the payment of a filled offer into the maker's wallet as a `wallet payment`, so it counts towards the
 * balance. The fill is a token transaction, so the overlay has it; it is fetched through its token output.
 */
export async function claimOfferPayment(ctx: CoreContext, offer: NewOffer, fillTxid: string): Promise<void> {
  const kit = tokenKit(ctx)
  const me = await kit.identityKey()
  if (offer.makerIdentityKey !== me) throw new Error('only the maker can claim the payment of an offer')
  const payTo = await makerPaymentScript(ctx, me, offer.id)
  if (payTo !== offer.payToLockingScript) throw new Error(`offer ${offer.id} does not pay this wallet`)
  const [fill] = await kit.overlay.lookup({ op: 'outpoint', txid: fillTxid, vout: TOKEN_VOUT })
  if (fill?.txid !== fillTxid) throw new Error(`the overlay does not know the fill ${fillTxid}`)
  const input = fill.tx.inputs[0]
  if (`${input.sourceTXID ?? input.sourceTransaction?.id('hex')}.${input.sourceOutputIndex}` !== offer.id) {
    throw new Error(`${fillTxid} does not fill offer ${offer.id}`)
  }
  const outputIndex = fill.tx.outputs.findIndex((o) => o.lockingScript.toHex() === payTo)
  if (outputIndex === -1 || fill.tx.outputs[outputIndex].satoshis !== offer.priceSats) {
    throw new Error(`${fillTxid} does not pay the price of offer ${offer.id}`)
  }
  const { derivationPrefix, derivationSuffix } = paymentDerivation(offer.id)
  await ctx.wallet.internalizeAction(
    {
      tx: Transaction.fromBEEF(fill.beef, fillTxid).toAtomicBEEF(),
      outputs: [
        {
          outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: me },
        },
      ],
      description: 'Payment for a token offer',
    },
    ctx.originator,
  )
}

// ── The maker's payment key ──────────────────────────────────────────────────────────────────────────────────────

/** BRC-29 derivation for an offer: a fixed prefix and the offer's outpoint, both base64 as BRC-29 requires. */
function paymentDerivation(offerId: Outpoint): { derivationPrefix: string; derivationSuffix: string } {
  return {
    derivationPrefix: Utils.toBase64(Utils.toArray('agentswap offer', 'utf8')),
    derivationSuffix: Utils.toBase64(Utils.toArray(offerId, 'utf8')),
  }
}

/**
 * P2PKH (hex) of the maker's payment key for `offerId`. Its counterparty is the maker's own identity key, since no
 * taker is known when the offer is signed, so only the maker's wallet can derive it.
 */
async function makerPaymentScript(
  ctx: CoreContext,
  makerIdentityKey: string,
  offerId: Outpoint,
): Promise<string> {
  const { derivationPrefix, derivationSuffix } = paymentDerivation(offerId)
  const { publicKey } = await ctx.wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: makerIdentityKey,
      forSelf: true,
    },
    ctx.originator,
  )
  return new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
}

// ── Checks ───────────────────────────────────────────────────────────────────────────────────────────────────────

const OUTPOINT_RE = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/
const UINT_RE = /^(0|[1-9]\d*)$/
const HEX_RE = /^(?:[0-9a-f]{2})+$/
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/

/** Shape checks on an offer as received (JSON); returns its outpoint and amount. */
function checkFields(offer: NewOffer): { txid: string; vout: number; tokenAmount: bigint } {
  const m = typeof offer.id === 'string' ? OUTPOINT_RE.exec(offer.id) : null
  if (m === null) throw new InvalidOfferError('id must be "<txid>.<vout>"')
  if (typeof offer.tokenId !== 'string' || !isTokenId(offer.tokenId)) {
    throw new InvalidOfferError('tokenId must be "<txid>_<vout>"')
  }
  if (typeof offer.tokenAmount !== 'string' || !UINT_RE.test(offer.tokenAmount)) {
    throw new InvalidOfferError('tokenAmount must be a decimal string')
  }
  const tokenAmount = BigInt(offer.tokenAmount)
  if (tokenAmount === 0n || tokenAmount > MAX_U64) {
    throw new InvalidOfferError('tokenAmount must be 1 to 2^64-1')
  }
  if (!Number.isSafeInteger(offer.priceSats) || offer.priceSats <= 0) {
    throw new InvalidOfferError('priceSats must be a positive integer')
  }
  if (typeof offer.makerIdentityKey !== 'string' || !PUBKEY_RE.test(offer.makerIdentityKey)) {
    throw new InvalidOfferError('makerIdentityKey must be a compressed public key in lowercase hex')
  }
  for (const field of ['payToLockingScript', 'unlockingScript', 'sourceBeef'] as const) {
    if (typeof offer[field] !== 'string' || !HEX_RE.test(offer[field])) {
      throw new InvalidOfferError(`${field} must be lowercase hex`)
    }
  }
  try {
    LockingScript.fromHex(offer.payToLockingScript)
  } catch {
    throw new InvalidOfferError('payToLockingScript is not a script')
  }
  return { txid: m[1], vout: Number(m[2]), tokenAmount }
}

/**
 * SPV check of the offer's source transaction. A failure of the chain tracker itself (no headers) is thrown as it
 * is; anything else wrong with the proof makes the offer invalid.
 */
async function checkSpv(tx: Transaction, chainTracker: ChainTracker): Promise<void> {
  const trackerErrors = new Set<unknown>()
  const remember = async <T>(call: Promise<T>): Promise<T> =>
    await call.catch((e: unknown) => {
      trackerErrors.add(e)
      throw e
    })
  const tracked: ChainTracker = {
    isValidRootForHeight: async (root, height, signal) =>
      await remember(chainTracker.isValidRootForHeight(root, height, signal)),
    currentHeight: async (signal) => await remember(chainTracker.currentHeight(signal)),
  }
  let valid: boolean
  try {
    valid = await tx.verify(tracked)
  } catch (e) {
    if (trackerErrors.has(e)) throw e
    throw new InvalidOfferError(
      `sourceBeef failed SPV verification: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!valid) throw new InvalidOfferError('sourceBeef failed SPV verification')
}

/** Token id and amount of a canonical BSV-21 output that carries a balance, or null. */
function tokenOf(tx: Transaction, txid: string, vout: number): { tokenId: TokenId; amount: bigint } | null {
  const output = tx.outputs[vout]
  const d = output === undefined ? null : decodeBsv21(output.lockingScript)
  if (d === null || d.op === 'burn') return null
  return { tokenId: d.op === 'deploy+mint' ? tokenIdFromOutpoint(txid, vout) : d.id!, amount: d.amount }
}

/** What the maker signs: version 1, input 0 spending the token UTXO, output 0 paying the price, lockTime 0. */
function offerTemplate(
  sourceTx: Transaction,
  vout: number,
  payToLockingScript: string,
  priceSats: number,
): Transaction {
  const tx = new Transaction(VERSION, [], [], LOCK_TIME)
  tx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: vout, sequence: SEQUENCE })
  tx.addOutput({ lockingScript: LockingScript.fromHex(payToLockingScript), satoshis: priceSats })
  return tx
}

/** The maker's unlocking script must be a signature with sighash 0xC3 and a public key that spend `tx`'s input 0. */
function checkMakerSignature(tx: Transaction, unlockingScriptHex: string): void {
  let unlockingScript: UnlockingScript
  try {
    unlockingScript = UnlockingScript.fromHex(unlockingScriptHex)
  } catch {
    throw new InvalidOfferError('unlockingScript is not a script')
  }
  const [sig, pub] = unlockingScript.chunks
  if (unlockingScript.chunks.length !== 2 || sig.data === undefined || pub.data === undefined) {
    throw new InvalidOfferError('unlockingScript must push a signature and a public key')
  }
  if (sig.data.at(-1) !== OFFER_SIGHASH) {
    throw new InvalidOfferError(`the maker's signature must use sighash 0x${OFFER_SIGHASH.toString(16)}`)
  }
  const input = tx.inputs[0]
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  let valid: boolean
  try {
    valid = new Spend({
      sourceTXID: input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis!,
      lockingScript: source.lockingScript,
      transactionVersion: tx.version,
      otherInputs: [],
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript,
      inputSequence: input.sequence!,
      lockTime: tx.lockTime,
    }).validate()
  } catch {
    valid = false
  }
  if (!valid) throw new InvalidOfferError("the maker's signature does not cover this UTXO, price and payee")
}

/**
 * The overlay's record of the offer's UTXO, looked up among the maker's receive keys, so it also proves the UTXO is
 * the maker's. Throws InvalidOfferError unless the overlay admitted it, has not seen it spent and agrees on the
 * amount.
 */
async function overlayUtxo(
  overlay: OverlayClient,
  offer: NewOffer,
  txid: string,
  vout: number,
  tokenAmount: bigint,
): Promise<OverlayOutput> {
  const held = await overlay.lookup({
    op: 'identity',
    identityKey: offer.makerIdentityKey,
    tokenId: offer.tokenId,
  })
  const utxo = held.find((o) => o.txid === txid && o.vout === vout)
  if (utxo === undefined) {
    const [known] = await overlay.lookup({ op: 'outpoint', txid, vout })
    if (known === undefined) throw new InvalidOfferError(`the overlay never admitted ${offer.id}`)
    if (known.ctx.spent) {
      const by = known.ctx.spendingTxid !== undefined ? ` by ${known.ctx.spendingTxid}` : ''
      throw new InvalidOfferError(`offer ${offer.id} is closed: its UTXO was spent${by}`)
    }
    if (known.ctx.tokenId !== offer.tokenId) {
      throw new InvalidOfferError(`${offer.id} is not a ${offer.tokenId} output`)
    }
    throw new InvalidOfferError(`${offer.id} is not held by the maker's identity key`)
  }
  if (BigInt(utxo.ctx.amt) !== tokenAmount) {
    throw new InvalidOfferError(`${offer.id} holds ${utxo.ctx.amt} tokens, not ${offer.tokenAmount}`)
  }
  return utxo
}

/** How the wallet's transaction differs from the layout the maker signed, or undefined if it does not. */
function layoutProblem(
  tx: Transaction,
  offer: NewOffer,
  txid: string,
  vout: number,
  tokenScript: string,
): string | undefined {
  const input = tx.inputs[0]
  if ((input.sourceTXID ?? input.sourceTransaction?.id('hex')) !== txid || input.sourceOutputIndex !== vout) {
    return 'input 0 is not the offered UTXO'
  }
  if (input.sequence !== SEQUENCE) return `input 0 has sequence ${input.sequence}`
  if (tx.version !== VERSION || tx.lockTime !== LOCK_TIME) {
    return `version ${tx.version}, lockTime ${tx.lockTime}`
  }
  const pay = tx.outputs[0]
  if (pay.lockingScript.toHex() !== offer.payToLockingScript || pay.satoshis !== offer.priceSats) {
    return 'output 0 is not the payment to the maker'
  }
  const token = tx.outputs.at(TOKEN_VOUT)
  if (token === undefined || token.lockingScript.toHex() !== tokenScript || token.satoshis !== 1) {
    return `output ${TOKEN_VOUT} is not the token output`
  }
  return undefined
}
