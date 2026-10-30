// Funding an agent's wallet from its deposit address, on wallet-toolbox's mock chain.
import { PrivateKey } from '@bsv/sdk'
import { Setup, type Wallet } from '@bsv/wallet-toolbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockChain, type MockChain } from '../../../packages/core/test/helpers/mockchain'
import { depositAddress, depositKey, sweepDeposits } from '../src/funding'

/** Broadcast now: a delayed broadcast waits for a Monitor, which the mock chain does not run. */
const NOW = { acceptDelayedBroadcast: false }

let chain: MockChain
let faucet: Wallet
let agent: Wallet
const rootKey = PrivateKey.fromRandom()

beforeAll(async () => {
  chain = await createMockChain()
  faucet = await chain.makeWallet()
  await chain.fund(faucet)
  agent = await chain.makeWallet(rootKey)
})

afterAll(async () => {
  await chain?.close()
})

describe('deposit address', () => {
  it('is a testnet P2PKH address of a key derived from the root key, not the identity key', () => {
    const address = depositAddress(rootKey, 'testnet')
    expect(address).toMatch(/^[mn]/)
    expect(depositAddress(rootKey, 'testnet')).toBe(address)
    expect(depositKey(rootKey).toHex()).not.toBe(rootKey.toHex())
    expect(address).not.toBe(rootKey.toAddress('testnet'))
    expect(depositAddress(rootKey, 'mainnet')).toMatch(/^1/)
  })
})

describe('sweepDeposits', () => {
  it('takes coins sent to the deposit address into the wallet', async () => {
    const address = depositAddress(rootKey, 'testnet')
    const { outpoints } = await Setup.createP2PKHOutputsAction(
      faucet,
      [
        { address, satoshis: 20_000 },
        { address, satoshis: 5_000 },
      ],
      NOW,
    )
    await chain.mineBlock()
    expect(await agent.balance()).toBe(0)

    const results = await sweepDeposits(agent, rootKey, outpoints!)
    expect(results.map((r) => r.success)).toEqual([true, true])
    const balance = await agent.balance()
    console.log(`agent balance after the sweep: ${balance} of 25000 sats`)
    expect(balance).toBeGreaterThan(24_800)
    expect(balance).toBeLessThanOrEqual(25_000)
  })

  it('refuses an output that does not pay the deposit address, and one already swept', async () => {
    const { outpoints } = await Setup.createP2PKHOutputsAction(
      faucet,
      [
        { address: PrivateKey.fromRandom().toAddress('testnet'), satoshis: 3_000 },
        { address: depositAddress(rootKey, 'testnet'), satoshis: 4_000 },
      ],
      NOW,
    )
    await chain.mineBlock()
    const before = await agent.balance()
    const [other, ours] = await sweepDeposits(agent, rootKey, outpoints!)
    expect(other).toMatchObject({ success: false, error: expect.stringMatching(/deposit address/) })
    expect(ours.success).toBe(true)
    const after = await agent.balance()
    expect(after - before).toBeGreaterThan(3_900)

    const [again] = await sweepDeposits(agent, rootKey, [outpoints![1]])
    expect(again).toMatchObject({ success: false })
    expect(await agent.balance()).toBe(after)
  })

  it('waits for a deposit to be mined', async () => {
    const { outpoints } = await Setup.createP2PKHOutputsAction(
      faucet,
      [{ address: depositAddress(rootKey, 'testnet'), satoshis: 2_000 }],
      NOW,
    )
    const [first] = await sweepDeposits(agent, rootKey, outpoints!)
    expect(first).toMatchObject({ success: false, error: expect.stringMatching(/not mined/) })
    await chain.mineBlock()
    const [second] = await sweepDeposits(agent, rootKey, outpoints!)
    expect(second.success).toBe(true)
  })
})
