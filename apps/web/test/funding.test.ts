import {
  LockingScript,
  PrivateKey,
  ProtoWallet,
  Transaction,
  type CreateActionArgs,
  type WalletInterface,
} from '@bsv/sdk'
import type { HtlcContext } from '@agentswap/core'
import { describe, expect, it, vi } from 'vitest'
import { acceptBrc29Payment } from '../../../packages/core/src/kit/client/payments'
import {
  fundAgent,
  fundingProblem,
  MAX_FUNDING_SATS,
  MIN_FUNDING_SATS,
  paymentFileJson,
  savedPayments,
  savePayment,
  type PaymentFile,
} from '../src/funding'

/** A sender wallet: real key derivation (ProtoWallet), and a createAction that builds the transaction it is asked for. */
function senderWallet() {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  const createAction = vi.fn(async (args: CreateActionArgs) => {
    const tx = new Transaction()
    for (const o of args.outputs ?? []) {
      tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis })
    }
    return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
  })
  const wallet = { getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => proto.getPublicKey(a), createAction }
  return { wallet: wallet as unknown as WalletInterface, createAction, proto }
}

const ctxOf = (wallet: WalletInterface): HtlcContext => ({ wallet, network: 'mainnet' })

async function identityOf(wallet: Pick<WalletInterface, 'getPublicKey'>) {
  return (await wallet.getPublicKey({ identityKey: true })).publicKey
}

describe('fundingProblem', () => {
  const agent = '02' + 'ab'.repeat(32)

  it('accepts a valid key and amount', () => {
    expect(fundingProblem(agent, 5_000)).toBeUndefined()
    expect(fundingProblem(` ${agent.toUpperCase()} `, MIN_FUNDING_SATS)).toBeUndefined()
  })

  it('rejects a malformed key', () => {
    expect(fundingProblem('04' + 'ab'.repeat(32), 5_000)).toMatch(/66 hex/)
    expect(fundingProblem(agent.slice(2), 5_000)).toMatch(/66 hex/)
  })

  it('rejects paying yourself', () => {
    expect(fundingProblem(agent, 5_000, agent)).toMatch(/your own/)
  })

  it('keeps the amount a whole number within limits', () => {
    expect(fundingProblem(agent, 1_500.5)).toMatch(/whole number/)
    expect(fundingProblem(agent, Number.NaN)).toMatch(/whole number/)
    expect(fundingProblem(agent, MIN_FUNDING_SATS - 1)).toMatch(/at least/)
    expect(fundingProblem(agent, MAX_FUNDING_SATS + 1)).toMatch(/at most/)
  })
})

describe('fundAgent', () => {
  it('pays the agent a payment it can take in with core acceptBrc29Payment', async () => {
    const sender = senderWallet()
    const agent = new ProtoWallet(PrivateKey.fromRandom())
    const agentKey = await identityOf(agent)

    const file = await fundAgent(ctxOf(sender.wallet), agentKey, 4_000)
    expect(file).toMatchObject({
      kind: 'flashcrowd agent funding',
      network: 'mainnet',
      recipientIdentityKey: agentKey,
      satoshis: 4_000,
      senderIdentityKey: await identityOf(sender.wallet),
    })
    expect(file.wocUrl).toBe(`https://whatsonchain.com/tx/${file.txid}`)

    // The agent's side, from the JSON the page downloads.
    const internalizeAction = vi.fn(async () => ({ accepted: true as const }))
    const agentWallet = {
      getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => agent.getPublicKey(a),
      internalizeAction,
    } as unknown as WalletInterface
    await acceptBrc29Payment(agentWallet, JSON.parse(paymentFileJson(file)))
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            outputIndex: file.outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: file.derivationPrefix,
              derivationSuffix: file.derivationSuffix,
              senderIdentityKey: file.senderIdentityKey,
            },
          }),
        ],
      }),
      undefined,
    )
  })

  it('pays a key no other agent can take in', async () => {
    const sender = senderWallet()
    const agentKey = await identityOf(new ProtoWallet(PrivateKey.fromRandom()))
    const file = await fundAgent(ctxOf(sender.wallet), agentKey, 4_000)
    const stranger = new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface
    await expect(acceptBrc29Payment(stranger, file)).rejects.toThrow('not locked to our key')
  })

  it('refuses to pay your own identity key, before the wallet spends anything', async () => {
    const sender = senderWallet()
    await expect(fundAgent(ctxOf(sender.wallet), await identityOf(sender.wallet), 4_000)).rejects.toThrow(
      'your own',
    )
    expect(sender.createAction).not.toHaveBeenCalled()
  })
})

describe('payment files in this browser', () => {
  const file = (txid: string) => ({ txid, satoshis: 1_000 }) as PaymentFile

  function memoryStorage() {
    const items = new Map<string, string>()
    return {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
    }
  }

  it('keeps every payment once, newest first', () => {
    const storage = memoryStorage()
    savePayment(file('a'), storage)
    savePayment(file('b'), storage)
    savePayment(file('a'), storage)
    expect(savedPayments(storage).map((p) => p.txid)).toEqual(['a', 'b'])
  })

  it('reports blocked or broken storage instead of throwing', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(savePayment(file('a'), blocked)).toBe(false)
    expect(savedPayments(blocked)).toEqual([])
    expect(savedPayments({ getItem: () => 'not json' })).toEqual([])
    expect(savedPayments(undefined)).toEqual([])
  })
})
