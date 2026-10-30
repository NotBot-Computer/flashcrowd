// What happens to locked money when things break after funding, on wallet-toolbox's mock chain with the test
// coordinator: the coordinator is down for a while, it disappears for good, or the agent's process dies.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServiceOffer, SpendPolicy } from '@agentswap/core'
import type { Wallet } from '@bsv/wallet-toolbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockChain, type MockChain } from '../../../packages/core/test/helpers/mockchain'
import type { Coordinator } from '../src/coordinator'
import { readLedger } from '../src/ledger'
import { recoverRefunds } from '../src/recover'
import { runAgents, type AgentRun } from '../src/runner'
import { LocalCoordinator } from './helpers/localCoordinator'

let chain: MockChain
let seller: Wallet
let dir: string
const agents: Wallet[] = []

const policy: SpendPolicy = {
  maxPerPurchaseSats: 6_000,
  maxTotalSats: 50_000,
  allowedServiceIds: ['premium-data'],
  requireMatchingResource: true,
  maxLockBlocks: 30,
}

const service = (): ServiceOffer => ({
  id: 'premium-data',
  network: 'testnet',
  sellerIdentityKey: seller.identityKey,
  title: 'BSV/USD daily closes (simulation)',
  resourceId: 'bsvusd-2026-10',
  priceSats: 7_000,
  license: 'shared-within-group',
  simulation: true,
})

const coordinator = (claim: boolean): LocalCoordinator =>
  new LocalCoordinator({
    seller: { wallet: seller, network: 'testnet' },
    sellerIdentityKey: seller.identityKey,
    service: service(),
    dataset: JSON.stringify({ simulation: true }),
    chainTracker: chain.chainTracker,
    height: async () => await chain.services.getHeight(),
    lockBlocks: 4,
    claim,
  })

const delay = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 5))

function runs(
  clients: Coordinator[],
  o: { sleep?: () => Promise<void>; ledgers?: string[] } = {},
): AgentRun[] {
  return clients.map((coordinator, i) => ({
    ctx: { wallet: agents[i], network: 'testnet' },
    coordinator,
    spentSats: 0,
    sleep: o.sleep,
    ledgerFile: o.ledgers?.[i],
    config: {
      name: `agent-${i + 1}`,
      policy,
      serviceId: 'premium-data',
      resourceId: 'bsvusd-2026-10',
      maxContributionSats: [3_000, 4_000][i],
      intentTtlMs: 60_000,
      pollMs: 5,
      matchTimeoutMs: 5_000,
    },
  }))
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'flashcrowd-recovery-'))
  chain = await createMockChain()
  seller = await chain.makeWallet()
  for (let i = 0; i < 2; i++) {
    const wallet = await chain.makeWallet()
    await chain.fund(wallet)
    agents.push(wallet)
  }
})

afterAll(async () => {
  await chain?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('after funding', () => {
  it('the agent waits through a coordinator outage and still decrypts', async () => {
    const coord = coordinator(true)
    let failures = 3
    const flaky = coord.client(agents[0].identityKey)
    const clients = [
      {
        ...flaky,
        settlement: async (id: string) => {
          if (failures-- > 0) throw new Error('tunnel down')
          return await flaky.settlement(id)
        },
      },
      coord.client(agents[1].identityKey),
    ]
    const lines: string[] = []
    const outcomes = await runAgents(runs(clients), (l) => lines.push(l))
    expect(outcomes.map((o) => o.status)).toEqual(['decrypted', 'decrypted'])
    expect(lines.some((l) => l.includes('unreachable (tunnel down)'))).toBe(true)
    expect(lines.some((l) => l.includes('the coordinator is back'))).toBe(true)
  })

  it('if the coordinator never comes back, each agent refunds on its own above the refund height', async () => {
    const coord = coordinator(false)
    const gone = (identityKey: string): Coordinator => ({
      ...coord.client(identityKey),
      settlement: async () => {
        throw new Error('server gone')
      },
      reportRefund: async () => {
        throw new Error('server gone')
      },
    })
    const sleep = async (): Promise<void> => (coord.anyLocked() ? await chain.mineBlock() : await delay())
    const before = await Promise.all(agents.map(async (a) => await a.balance()))
    const outcomes = await runAgents(
      runs(
        agents.map((a) => gone(a.identityKey)),
        { sleep },
      ),
      () => undefined,
    )
    expect(outcomes.map((o) => o.status)).toEqual(['refunded', 'refunded'])
    for (const [i, a] of agents.entries()) expect(before[i] - (await a.balance())).toBeLessThan(200)
  })

  it('if the agent process dies, the refund command recovers the money from the ledger', async () => {
    const coord = coordinator(false)
    const ledgers = [join(dir, 'agent-1.testnet.spent.json'), join(dir, 'agent-2.testnet.spent.json')]
    const killed = async (): Promise<void> => {
      if (coord.anyLocked()) throw new Error('process killed')
      await delay()
    }
    const before = await Promise.all(agents.map(async (a) => await a.balance()))
    const outcomes = await runAgents(
      runs(
        agents.map((a) => coord.client(a.identityKey)),
        { sleep: killed, ledgers },
      ),
      () => undefined,
    )
    expect(outcomes).toMatchObject([
      { status: 'error', reason: 'process killed' },
      { status: 'error', reason: 'process killed' },
    ])
    for (const ledger of ledgers) {
      const [entry] = readLedger(ledger)
      expect(entry).toMatchObject({ status: 'funded' })
      expect(entry.contribution?.refundSignature).toMatch(/^[0-9a-f]+$/)
      expect(entry.contribution?.beef).toMatch(/^[0-9a-f]+$/)
    }

    const ctx = { wallet: agents[0], network: 'testnet' as const }
    expect(await recoverRefunds(ctx, ledgers[0])).toMatchObject([{ status: 'waiting' }])

    for (let i = 0; i < 6; i++) await chain.mineBlock()
    for (const [i, ledger] of ledgers.entries()) {
      const report = coord.client(agents[i].identityKey).reportRefund
      const [result] = await recoverRefunds({ wallet: agents[i], network: 'testnet' }, ledger, report)
      expect(result.status).toBe('refunded')
      expect(readLedger(ledger)[0]).toMatchObject({ status: 'refunded', settledTxid: result.refundTxid })
      expect(before[i] - (await agents[i].balance())).toBeLessThan(200)
    }
    expect(coord.refundReports).toHaveLength(2)
    expect(await recoverRefunds(ctx, ledgers[0])).toEqual([])
  })
})
