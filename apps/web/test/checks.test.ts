import { LockingScript, PrivateKey, ProtoWallet, Transaction, type WalletInterface } from '@bsv/sdk'
import type { HtlcContext } from '@agentswap/core'
import { describe, expect, it, vi } from 'vitest'
import { checkHashSignature, checkTermsSignature, prepareHtlcFunding, sendPreparedFunding } from '../src/checks'

// ProtoWallet does the key derivation and signing a BRC-100 wallet does, without coins or a network.
const contextFor = (wallet: Partial<WalletInterface>): HtlcContext => ({
  wallet: wallet as WalletInterface,
  network: 'testnet',
})

const protoContext = () => contextFor(new ProtoWallet(PrivateKey.fromRandom()))

/** Answers getPublicKey honestly but signs with another key, like a wallet that derives keys wrongly. */
function wrongSigner(): Partial<WalletInterface> {
  const honest = new ProtoWallet(PrivateKey.fromRandom())
  const other = new ProtoWallet(PrivateKey.fromRandom())
  return {
    getPublicKey: (args) => honest.getPublicKey(args),
    createSignature: (args) => other.createSignature(args),
  }
}

describe('checkHashSignature', () => {
  it('passes when the wallet signs the hash with its HTLC key', async () => {
    expect(await checkHashSignature(protoContext())).toMatchObject({ ok: true })
  })

  it('fails when the signature is from another key', async () => {
    expect(await checkHashSignature(contextFor(wrongSigner()))).toMatchObject({ ok: false })
  })
})

describe('checkTermsSignature', () => {
  it('passes when the wallet signs the data with its identity', async () => {
    expect(await checkTermsSignature(protoContext())).toMatchObject({ ok: true })
  })

  it('fails when the signature is from another key', async () => {
    expect(await checkTermsSignature(contextFor(wrongSigner()))).toMatchObject({ ok: false })
  })
})

describe('prepareHtlcFunding', () => {
  it('aborts when the wallet leaves out the HTLC output', async () => {
    const proto = new ProtoWallet(PrivateKey.fromRandom())
    const tx = new Transaction()
    tx.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1_000 })
    const abortAction = vi.fn(async () => ({ aborted: true as const }))
    const ctx = contextFor({
      getPublicKey: (args) => proto.getPublicKey(args),
      createAction: async () => ({ txid: tx.id('hex'), tx: tx.toAtomicBEEF() }),
      abortAction,
    })
    await expect(prepareHtlcFunding(ctx)).rejects.toThrow('left out the HTLC output')
    expect(abortAction).toHaveBeenCalledWith({ reference: tx.id('hex') }, undefined)
  })
})

describe('sendPreparedFunding', () => {
  const txid = 'ab'.repeat(32)
  const sendWith = (status?: 'unproven' | 'sending' | 'failed') =>
    contextFor({
      createAction: async () => ({ sendWithResults: status === undefined ? [] : [{ txid, status }] }),
    })

  it('passes with a WhatsOnChain link once the wallet sends it', async () => {
    const result = await sendPreparedFunding(sendWith('unproven'), txid)
    expect(result).toMatchObject({ ok: true })
    expect(result.wocUrl).toContain(txid)
  })

  it('fails when the wallet reports a failure', async () => {
    expect(await sendPreparedFunding(sendWith('failed'), txid)).toMatchObject({ ok: false })
  })

  it('fails when the wallet reports nothing for the transaction', async () => {
    expect(await sendPreparedFunding(sendWith(), txid)).toMatchObject({ ok: false })
  })
})
