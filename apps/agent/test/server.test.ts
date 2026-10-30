// Agents against the real apps/server over HTTP and BRC-103 (httpCoordinator + AuthFetch), on wallet-toolbox's mock
// chain. The server is built the way its own tests build it. Mock chain only: no testnet transaction.
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PrivateKey, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockChain, type MockChain } from '../../../packages/core/test/helpers/mockchain'
import { createApp } from '../../server/src/app'
import type { ChainView } from '../../server/src/chain'
import { Coordinator } from '../../server/src/coordinator'
import { Feed } from '../../server/src/feed'
import { MockSeller } from '../../server/src/seller'
import { Store } from '../../server/src/store'
import type { SpendPolicy } from '@agentswap/core'
import { httpCoordinator } from '../src/httpCoordinator'
import { runAgents, type AgentRun } from '../src/runner'

let chain: MockChain
let chainView: ChainView
let sellerWallet: Wallet
const agents: Wallet[] = []
const servers: { coordinator: Coordinator; close: () => Promise<void> }[] = []

const policy: SpendPolicy = {
  maxPerPurchaseSats: 6_000,
  maxTotalSats: 20_000,
  allowedServiceIds: ['bsv-usd-closes'],
  requireMatchingResource: true,
  maxLockBlocks: 30,
}

async function startServer(o: { noClaim: boolean; lockBlocks: number }) {
  const feed = new Feed('testnet')
  const seller = await MockSeller.create({ wallet: sellerWallet, network: 'testnet' }, o)
  const coordinator = new Coordinator('testnet', new Store(), feed, seller, chainView, () => Date.now())
  const app = createApp({
    network: 'testnet',
    coordinator,
    feed,
    authWallet: new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface,
  })
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const entry = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    coordinator,
    feed,
    close: async () =>
      await new Promise<void>((resolve) => {
        coordinator.stop()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
  servers.push(entry)
  return entry
}

const runsFor = (base: string, offers: number[], sleep?: () => Promise<void>): AgentRun[] =>
  offers.map((max, i) => ({
    ctx: { wallet: agents[i], network: 'testnet' },
    coordinator: httpCoordinator(base, agents[i]),
    spentSats: 0,
    config: {
      name: `agent-${i + 1}`,
      policy,
      serviceId: 'bsv-usd-closes',
      resourceId: 'bsvusd-2026-10',
      maxContributionSats: max,
      intentTtlMs: 600_000,
      pollMs: 20,
      matchTimeoutMs: 20_000,
    },
    ...(sleep !== undefined && { sleep }),
  }))

beforeAll(async () => {
  chain = await createMockChain()
  chainView = {
    currentHeight: () => chain.services.getHeight(),
    getRawTx: async (txid) => (await chain.services.getRawTx(txid)).rawTx,
    tracker: chain.chainTracker,
  }
  sellerWallet = await chain.makeWallet()
  for (let i = 0; i < 3; i++) {
    const wallet = await chain.makeWallet()
    await chain.fund(wallet)
    agents.push(wallet)
  }
})

afterAll(async () => {
  for (const s of servers) await s.close()
  await chain?.close()
})

describe('agents against apps/server', () => {
  it('three agents buy the dataset through the server and decrypt it', async () => {
    const server = await startServer({ noClaim: false, lockBlocks: 20 })
    const outcomes = await runAgents(runsFor(server.base, [3_000, 4_000, 5_000]), () => undefined)
    expect(outcomes.map((o) => o.status)).toEqual(['decrypted', 'decrypted', 'decrypted'])
    const claimTxids = new Set(outcomes.map((o) => (o.status === 'decrypted' ? o.claimTxid : '')))
    expect(claimTxids.size).toBe(1)
    for (const o of outcomes) {
      if (o.status === 'decrypted') expect(Utils.toUTF8(o.data)).toMatch(/simulation/i)
    }
    const group = server.coordinator.groups()[0]
    expect(group.status).toBe('claimed')
    // The agents' own steps reached the server's feed, as agent events under their keys.
    const agentEvents = server.feed.since(0).filter((e) => e.type === 'agent')
    expect(agentEvents.some((e) => e.message.includes('decrypted'))).toBe(true)
    expect(server.feed.since(0).some((e) => e.type === 'claim' && e.txid === [...claimTxids][0])).toBe(true)
  })

  it('with no claim, two agents refund and the server records both refunds', async () => {
    const server = await startServer({ noClaim: true, lockBlocks: 4 })
    // Blocks come only once the money is locked, then the server's ticker sees them.
    const sleep = async (): Promise<void> => {
      const locked = server.coordinator
        .groups()
        .some((g) => ['locked', 'funding', 'refund_available'].includes(g.status))
      if (locked) {
        await chain.mineBlock()
        await server.coordinator.tick()
      } else await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const outcomes = await runAgents(runsFor(server.base, [6_000, 6_000], sleep))
    expect(outcomes.map((o) => o.status)).toEqual(['refunded', 'refunded'])
    const group = server.coordinator.groups()[0]
    expect(group.status).toBe('refunded')
    expect(group.refunds).toHaveLength(2)
  })
})
