// Atomic offers end to end on wallet-toolbox's mock chain, with the overlay in-process: a maker lists USDx, a taker
// fills the offer from their own wallet, and the maker takes the payment in.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { P2PKH, PrivateKey, type CreateActionArgs } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tokenKit, type CoreContext } from '../src/context'
import { startOverlay, type RunningOverlay } from '../src/kit/overlay/server'
import {
  cancelOffer,
  claimOfferPayment,
  createOffer,
  fillOffer,
  InvalidOfferError,
  verifyOffer,
} from '../src/offers'
import { deployToken, getBalances, sendTokens, syncTokens } from '../src/tokens'
import type { NewOffer } from '../src/types'
import { createMockChain, type MockChain } from './helpers/mockchain'

let dir: string
let chain: MockChain
let overlay: RunningOverlay
let makerWallet: Wallet
let takerWallet: Wallet
let maker: CoreContext
let taker: CoreContext
let tokenId: string

const checks = (): Parameters<typeof verifyOffer>[1] => ({
  chainTracker: chain.chainTracker,
  overlayUrl: overlay.url,
})

/** Expects `p` to fail with an InvalidOfferError whose message matches `reason`. */
async function expectInvalid(p: Promise<unknown>, reason: RegExp): Promise<void> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(InvalidOfferError)
  expect((error as Error).message).toMatch(reason)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentswap-offers-'))
  chain = await createMockChain()
  overlay = await startOverlay({
    port: 18092,
    dbFile: join(dir, 'overlay.db'),
    chainTracker: chain.chainTracker,
    quiet: true,
  })
  makerWallet = await chain.makeWallet()
  takerWallet = await chain.makeWallet()
  await chain.fund(makerWallet)
  await chain.fund(takerWallet)
  maker = { wallet: makerWallet, network: 'testnet', overlayUrl: overlay.url }
  taker = { wallet: takerWallet, network: 'testnet', overlayUrl: overlay.url }
  ;({ tokenId } = await deployToken(maker, { sym: 'USDx', supply: 1_000_000n, dec: 2 }))
})

afterAll(async () => {
  await overlay?.close()
  await chain?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('atomic offers on the mock chain', () => {
  let filled: NewOffer
  let fillTxid: string
  let open: NewOffer
  let cancelTxid: string

  it('creates an offer, splitting off an exact UTXO, then verifies and fills it', async () => {
    const { offer, splitTxid } = await createOffer(maker, { tokenId, tokenAmount: 250n, priceSats: 5_000 })
    expect(splitTxid).toBeDefined()
    expect(offer.id.startsWith(`${splitTxid}.`)).toBe(true)
    expect(offer).toMatchObject({ network: 'testnet', tokenId, tokenAmount: '250', priceSats: 5_000 })
    await verifyOffer(offer, checks())

    const { txid, wocUrl } = await fillOffer(taker, offer)
    expect(wocUrl).toBe(`https://test.whatsonchain.com/tx/${txid}`)
    filled = offer
    fillTxid = txid

    // As signed: input 0 is the maker's UTXO and output 0 the price; output 1 carries the tokens.
    const [token] = await tokenKit(taker).overlay.lookup({ op: 'outpoint', txid, vout: 1 })
    const input = token.tx.inputs[0]
    expect(`${input.sourceTXID ?? input.sourceTransaction?.id('hex')}.${input.sourceOutputIndex}`).toBe(
      offer.id,
    )
    expect(token.tx.outputs[0].lockingScript.toHex()).toBe(offer.payToLockingScript)
    expect(token.tx.outputs[0].satoshis).toBe(5_000)
    expect(token.ctx).toMatchObject({ tokenId, amt: '250', spent: false })

    // The taker's wallet took the tokens into its basket at once, so sync has nothing to add.
    expect(await getBalances(taker)).toEqual([
      { tokenId, sym: 'USDx', dec: '2', overlay: 250n, basket: 250n, utxos: 1 },
    ])
    expect((await syncTokens(taker)).inserted).toEqual([])
  })

  it('lets the maker claim the payment, and a filled offer is closed', async () => {
    const before = await makerWallet.balance()
    await claimOfferPayment(maker, filled, fillTxid)
    expect(await makerWallet.balance()).toBe(before + 5_000)
    // Taking the fill in also marked the sold UTXO spent in the maker's basket.
    expect(await getBalances(maker)).toEqual([
      { tokenId, sym: 'USDx', dec: '2', overlay: 999_750n, basket: 999_750n, utxos: 1 },
    ])
    await expectInvalid(
      verifyOffer(filled, checks()),
      new RegExp(`closed: its UTXO was spent by ${fillTxid}`),
    )
  })

  it('refuses an offer whose price or payee was changed', async () => {
    const { offer } = await createOffer(maker, { tokenId, tokenAmount: 100n, priceSats: 3_000 })
    const cheaper = { ...offer, priceSats: 2_000 }
    const elsewhere = {
      ...offer,
      payToLockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
    }
    await expectInvalid(verifyOffer(cheaper, checks()), /signature/)
    await expectInvalid(verifyOffer(elsewhere, checks()), /signature/)

    const sats = await takerWallet.balance()
    await expectInvalid(fillOffer(taker, cheaper), /signature/)
    await expectInvalid(fillOffer(taker, elsewhere), /signature/)
    expect(await takerWallet.balance()).toBe(sats)

    await verifyOffer(offer, checks()) // the offer as signed is still good
    open = offer
  })

  it('cannot fill an offer after it is cancelled', async () => {
    ;({ txid: cancelTxid } = await cancelOffer(maker, open))
    const sats = await takerWallet.balance()
    await expectInvalid(verifyOffer(open, checks()), /closed/)
    await expectInvalid(fillOffer(taker, open), /closed/)
    expect(await takerWallet.balance()).toBe(sats)
    await expect(cancelOffer(maker, open)).rejects.toThrow(/not open/)
  })

  it('lists a UTXO that already holds the exact amount without a split', async () => {
    // The cancel moved the 100 tokens to a fresh UTXO of exactly that amount.
    const { offer, splitTxid } = await createOffer(maker, { tokenId, tokenAmount: 100n, priceSats: 1_500 })
    expect(splitTxid).toBeUndefined()
    expect(offer.id.startsWith(`${cancelTxid}.`)).toBe(true)
    await verifyOffer(offer, checks())
    open = offer
  })

  it('sendTokens leaves the UTXOs behind open offers alone', async () => {
    const takerKey = await tokenKit(taker).identityKey()
    // The 999,650-token UTXO and the offer's 100 would cover 999,700, but the offer's UTXO is excluded.
    await expect(sendTokens(maker, tokenId, 999_700n, takerKey, { exclude: [open.id] })).rejects.toThrow(
      /insufficient token balance/,
    )
    await sendTokens(maker, tokenId, 1_000n, takerKey, { exclude: [open.id] })
    await verifyOffer(open, checks())
  })

  it('aborts a fill when the wallet does not keep the signed layout', async () => {
    // A wallet that reverses the outputs: the maker's signature would no longer hold, so nothing gets signed.
    const reordering = new Proxy(takerWallet, {
      get(target, prop) {
        if (prop === 'createAction') {
          return async (args: CreateActionArgs, originator?: string) =>
            await target.createAction({ ...args, outputs: [...(args.outputs ?? [])].reverse() }, originator)
        }
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const sats = await takerWallet.balance()
    await expect(fillOffer({ ...taker, wallet: reordering }, open)).rejects.toThrow(
      "the wallet did not keep the offer's layout (output 0 is not the payment to the maker); aborted",
    )
    expect(await takerWallet.balance()).toBe(sats)
    await verifyOffer(open, checks()) // the UTXO was not spent, so the offer is still open

    await fillOffer(taker, open)
    await expectInvalid(verifyOffer(open, checks()), /closed/)
  })
})
