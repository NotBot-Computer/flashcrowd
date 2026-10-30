// Agents end to end on wallet-toolbox's mock chain, with a test-only in-process coordinator and mock seller in place
// of apps/server. Mock chain only: no testnet transaction.
import type { HtlcContext, ServiceOffer, SpendPolicy } from '@agentswap/core'
import { Utils } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockChain, type MockChain } from '../../../packages/core/test/helpers/mockchain'
import { runPurchase, type AgentConfig } from '../src/flow'
import { LocalCoordinator, type LocalCoordinatorOptions } from './helpers/localCoordinator'

const DATASET = JSON.stringify({ simulation: true, pair: 'BSV/USD', closes: ['41.20', '41.35', '40.98'] })

let chain: MockChain
let seller: Wallet
const agents: Wallet[] = []

const policy: SpendPolicy = {
  maxPerPurchaseSats: 6_000,
  maxTotalSats: 20_000,
  allowedServiceIds: ['premium-data'],
  requireMatchingResource: true,
  maxLockBlocks: 30,
}

const ctxOf = (wallet: Wallet): HtlcContext => ({ wallet, network: 'testnet' })

function service(priceSats: number): ServiceOffer {
  return {
    id: 'premium-data',
    network: 'testnet',
    sellerIdentityKey: seller.identityKey,
    title: 'BSV/USD daily closes (simulation)',
    resourceId: 'bsvusd-2026-10',
    priceSats,
    license: 'shared-within-group',
    simulation: true,
  }
}

function coordinator(priceSats: number, o: Partial<LocalCoordinatorOptions> = {}): LocalCoordinator {
  return new LocalCoordinator({
    seller: ctxOf(seller),
    sellerIdentityKey: seller.identityKey,
    service: service(priceSats),
    dataset: DATASET,
    chainTracker: chain.chainTracker,
    height: async () => await chain.services.getHeight(),
    lockBlocks: 20,
    claim: true,
    ...o,
  })
}

const config = (name: string, maxContributionSats: number, o: Partial<AgentConfig> = {}): AgentConfig => ({
  name,
  policy,
  serviceId: 'premium-data',
  resourceId: 'bsvusd-2026-10',
  maxContributionSats,
  intentTtlMs: 60_000,
  pollMs: 5,
  matchTimeoutMs: 3_000,
  ...o,
})

beforeAll(async () => {
  chain = await createMockChain()
  seller = await chain.makeWallet()
  for (let i = 0; i < 3; i++) {
    const wallet = await chain.makeWallet()
    await chain.fund(wallet)
    agents.push(wallet)
  }
})

afterAll(async () => {
  await chain?.close()
})

describe('three agents buy one dataset together', () => {
  it('each funds its share, the seller claims once, and every agent decrypts the dataset', async () => {
    const coord = coordinator(12_000)
    const before = await Promise.all(agents.map(async (a) => await a.balance()))
    const outcomes = await Promise.all(
      [3_000, 4_000, 5_000].map(
        async (max, i) =>
          await runPurchase(
            { ctx: ctxOf(agents[i]), coordinator: coord.client(agents[i].identityKey), spentSats: 0 },
            config(`agent-${i + 1}`, max),
          ),
      ),
    )
    for (const [i, outcome] of outcomes.entries()) {
      expect(outcome.status).toBe('decrypted')
      if (outcome.status !== 'decrypted') continue
      expect(Utils.toUTF8(outcome.data)).toBe(DATASET)
      expect(outcome.shareSats).toBe([3_000, 4_000, 5_000][i])
      expect(await agents[i].balance()).toBeLessThanOrEqual(before[i] - outcome.shareSats)
    }
    const decrypted = outcomes.filter((o) => o.status === 'decrypted')
    expect(new Set(decrypted.map((o) => o.claimTxid)).size).toBe(1)
    expect(new Set(decrypted.map((o) => o.fundingTxid)).size).toBe(3)
    const received = await seller.balance()
    console.log(`seller received ${received} of 12000 sats; claim ${decrypted[0].claimTxid}`)
    expect(received).toBeGreaterThan(11_900)
    expect(coord.events.some((e) => e.includes('decrypted'))).toBe(true)
  })
})

describe('the spend policy, not the coordinator, decides', () => {
  it('refuses a service the policy does not allow, without publishing an intent', async () => {
    const coord = coordinator(12_000)
    const outcome = await runPurchase(
      { ctx: ctxOf(agents[0]), coordinator: coord.client(agents[0].identityKey), spentSats: 0 },
      config('agent-1', 6_000, { policy: { ...policy, allowedServiceIds: ['something-else'] } }),
    )
    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringMatching(/not allowed/) })
    expect(coord.intents.size).toBe(0)
  })

  it('an agent whose policy rejects the terms signs nothing, and the other agent pays nothing', async () => {
    const coord = coordinator(12_000, { lockBlocks: 25 })
    const before = await Promise.all(agents.slice(0, 2).map(async (a) => await a.balance()))
    const [a, b] = await Promise.all([
      runPurchase(
        { ctx: ctxOf(agents[0]), coordinator: coord.client(agents[0].identityKey), spentSats: 0 },
        config('agent-1', 6_000, { matchTimeoutMs: 500 }),
      ),
      runPurchase(
        { ctx: ctxOf(agents[1]), coordinator: coord.client(agents[1].identityKey), spentSats: 0 },
        config('agent-2', 6_000, { policy: { ...policy, maxLockBlocks: 10 } }),
      ),
    ])
    expect(b).toMatchObject({ status: 'refused', reason: expect.stringMatching(/locked for 25 blocks/) })
    expect(a).toMatchObject({ status: 'unmatched' })
    expect(await Promise.all(agents.slice(0, 2).map(async (w) => await w.balance()))).toEqual(before)
    const group = [...coord.groups.values()][0]
    expect(group.participants.find((p) => p.identityKey === agents[1].identityKey)?.status).toBe('joined')
  })

  it('caps the offer at what the total budget leaves', async () => {
    const coord = coordinator(12_000)
    const outcome = await runPurchase(
      { ctx: ctxOf(agents[2]), coordinator: coord.client(agents[2].identityKey), spentSats: 19_500 },
      config('agent-3', 5_000),
    )
    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringMatching(/leaves 500 sats/) })
  })
})

describe('the seller never claims', () => {
  it('both agents get their contributions back after the refund height', async () => {
    const coord = coordinator(12_000, { claim: false, lockBlocks: 6 })
    // Blocks come only once the money is locked, so the agents fund well before the refund height.
    const sleep = async (): Promise<void> => {
      if (coord.anyLocked()) await chain.mineBlock()
      else await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const before = await Promise.all(agents.slice(0, 2).map(async (a) => await a.balance()))
    const outcomes = await Promise.all(
      [0, 1].map(
        async (i) =>
          await runPurchase(
            { ctx: ctxOf(agents[i]), coordinator: coord.client(agents[i].identityKey), spentSats: 0, sleep },
            config(`agent-${i + 1}`, 6_000),
          ),
      ),
    )
    for (const [i, outcome] of outcomes.entries()) {
      expect(outcome.status).toBe('refunded')
      if (outcome.status !== 'refunded') continue
      const lost = before[i] - (await agents[i].balance())
      console.log(`agent-${i + 1} refunded ${outcome.refundTxid}; fees ${lost} sats`)
      expect(lost).toBeGreaterThan(0)
      expect(lost).toBeLessThan(200)
    }
    // Each agent told the coordinator about its refund, and the group is settled.
    expect(coord.refundReports).toHaveLength(2)
    expect([...coord.groups.values()][0].status).toBe('refunded')
  })
})
