import {
  BigNumber,
  ECDSA,
  Hash,
  ProtoWallet,
  PublicKey,
  Random,
  Signature,
  Transaction,
  Utils,
} from '@bsv/sdk'
import {
  HTLC_PROTOCOL,
  MIN_CONTRIBUTION_SATS,
  TERMS_PROTOCOL,
  htlcKey,
  htlcKeyOf,
  htlcScript,
  newSecret,
  wocTxUrl,
  type HtlcContext,
} from '@agentswap/core'

// Session 2 of the P3 plan (docs/FLASHCROWD_PLAN.md): can BSV Desktop do the four wallet calls FlashCrowd needs?
// Each check makes the same call core makes, with the same protocol and arguments, so a pass here means the real
// flow works in this wallet. Checks throw on a wallet error and return ok: false when the wallet answers wrongly.

export interface CheckResult {
  ok: boolean
  detail: string
}

/** A throwaway group id, so every run derives fresh keys. */
const newGroupId = () => `check-${Utils.toHex(Random(8))}`

const identityOf = async (ctx: HtlcContext) =>
  (await ctx.wallet.getPublicKey({ identityKey: true }, ctx.originator)).publicKey

/**
 * The seller's refund and claim signatures: createSignature({ hashToDirectlySign }) under 'flashcrowd htlc'. The
 * signature must verify against the HTLC key anyone derives from the identity key, as verifyRefundSignature does.
 */
export async function checkHashSignature(ctx: HtlcContext): Promise<CheckResult> {
  const groupId = newGroupId()
  const expectedKey = await htlcKeyOf(await identityOf(ctx), groupId)
  const walletKey = await htlcKey(ctx, groupId)
  if (walletKey !== expectedKey) {
    return { ok: false, detail: 'the wallet derives a different HTLC key than other parties would' }
  }
  const hash = Hash.hash256(Random(32))
  const { signature } = await ctx.wallet.createSignature(
    { hashToDirectlySign: hash, protocolID: HTLC_PROTOCOL, keyID: groupId, counterparty: 'anyone' },
    ctx.originator,
  )
  const valid = ECDSA.verify(new BigNumber(hash), Signature.fromDER(signature), PublicKey.fromString(expectedKey))
  return valid
    ? { ok: true, detail: 'signed a raw hash with the HTLC key' }
    : { ok: false, detail: 'the signature does not verify against the HTLC key' }
}

/** The seller's terms: createSignature({ data }) under 'flashcrowd terms', checked as verifyTerms does. */
export async function checkTermsSignature(ctx: HtlcContext): Promise<CheckResult> {
  const groupId = newGroupId()
  const identityKey = await identityOf(ctx)
  const data = Utils.toArray(`flashcrowd terms check ${groupId}`, 'utf8')
  const { signature } = await ctx.wallet.createSignature(
    { data, protocolID: TERMS_PROTOCOL, keyID: groupId, counterparty: 'anyone' },
    ctx.originator,
  )
  try {
    await new ProtoWallet('anyone').verifySignature({
      data,
      signature,
      protocolID: TERMS_PROTOCOL,
      keyID: groupId,
      counterparty: identityKey,
    })
  } catch {
    return { ok: false, detail: 'the signature does not verify against the identity key' }
  }
  return { ok: true, detail: 'signed terms data with the identity key' }
}

export interface PreparedFunding {
  txid: string
  vout: number
  satoshis: number
}

/**
 * The buyer's funding: createAction with an HTLC output and noSend, as prepareContribution does. The wallet signs
 * but does not broadcast. Needs MIN_CONTRIBUTION_SATS plus a fee in the wallet. Both sides of the HTLC are this
 * wallet's own key.
 */
export async function prepareHtlcFunding(ctx: HtlcContext): Promise<PreparedFunding> {
  const key = await htlcKey(ctx, newGroupId())
  const script = htlcScript({ hash: newSecret().hash, sellerKey: key }, key).toHex()
  const satoshis = MIN_CONTRIBUTION_SATS
  const res = await ctx.wallet.createAction(
    {
      description: 'FlashCrowd wallet check',
      outputs: [{ lockingScript: script, satoshis, outputDescription: 'FlashCrowd HTLC check' }],
      options: { randomizeOutputs: false, noSend: true },
    },
    ctx.originator,
  )
  if (res.txid === undefined || res.tx === undefined) throw new Error('the wallet returned no signed transaction')
  const vout = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex((o) => o.lockingScript.toHex() === script)
  if (vout < 0) {
    await ctx.wallet.abortAction({ reference: res.txid }, ctx.originator)
    throw new Error('the wallet left out the HTLC output; aborted')
  }
  return { txid: res.txid, vout, satoshis }
}

/** Broadcasts a prepared funding with sendWith, as broadcastContribution does. */
export async function sendPreparedFunding(
  ctx: HtlcContext,
  txid: string,
): Promise<CheckResult & { wocUrl?: string }> {
  const res = await ctx.wallet.createAction(
    { description: 'Send FlashCrowd wallet check', options: { sendWith: [txid], acceptDelayedBroadcast: false } },
    ctx.originator,
  )
  const status = res.sendWithResults?.find((r) => r.txid === txid)?.status
  if (status === undefined || status === 'failed') {
    return { ok: false, detail: `the wallet did not send it (${status ?? 'no result'})` }
  }
  return { ok: true, detail: `sent (${status})`, wocUrl: wocTxUrl(txid, ctx.network) }
}

/** Gives up a prepared funding: the wallet releases its inputs. */
export async function abortPreparedFunding(ctx: HtlcContext, txid: string): Promise<void> {
  await ctx.wallet.abortAction({ reference: txid }, ctx.originator)
}
