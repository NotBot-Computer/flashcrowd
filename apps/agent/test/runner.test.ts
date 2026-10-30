// Several agents at once on wallet-toolbox's mock chain, with the test-only coordinator from flow.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HtlcContext, SpendPolicy } from '@agentswap/core'
import { PrivateKey } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockChain, type MockChain } from '../../../packages/core/test/helpers/mockchain'
import { depositAddress } from '../src/funding'
import { checkAgents, FEE_MARGIN_SATS, runAgents, summarize, type AgentRun } from '../src/runner'
import { LocalCoordinator } from './helpers/localCoordinator'

let chain: MockChain
let seller: Wallet
let dir: string
const keys = [PrivateKey.fromRandom(), PrivateKey.fromRandom(), PrivateKey.fromRandom()]
const agents: Wallet[] = []

const policy: SpendPolicy = {
  maxPerPurchaseSats: 6_000,
  maxTotalSats: 20_000,
  allowedServiceIds: ['premium-data'],
  requireMatchingResource: true,
  maxLockBlocks: 30,
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'flashcrowd-agents-'))
  chain = await createMockChain()
  seller = await chain.makeWallet()
  for (const key of keys) agents.push(await chain.makeWallet(key))
  await chain.fund(agents[0])
  await chain.fund(agents[1])
})

afterAll(async () => {
  await chain?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('runAgents', () => {
  it('runs the agents together and reports each with WhatsOnChain links', async () => {
    const coord = new LocalCoordinator({
      seller: { wallet: seller, network: 'testnet' },
      sellerIdentityKey: seller.identityKey,
      service: {
        id: 'premium-data',
        network: 'testnet',
        sellerIdentityKey: seller.identityKey,
        title: 'BSV/USD daily closes (simulation)',
        resourceId: 'bsvusd-2026-10',
        priceSats: 7_000,
        license: 'shared-within-group',
        simulation: true,
      },
      dataset: JSON.stringify({ simulation: true, closes: ['41.20'] }),
      chainTracker: chain.chainTracker,
      height: async () => await chain.services.getHeight(),
      lockBlocks: 20,
      claim: true,
    })
    const runs: AgentRun[] = [3_000, 4_000].map((max, i) => ({
      ctx: { wallet: agents[i], network: 'testnet' } satisfies HtlcContext,
      coordinator: coord.client(agents[i].identityKey),
      spentSats: 0,
      config: {
        name: `agent-${i + 1}`,
        policy,
        serviceId: 'premium-data',
        resourceId: 'bsvusd-2026-10',
        maxContributionSats: max,
        intentTtlMs: 60_000,
        pollMs: 5,
        matchTimeoutMs: 3_000,
      },
    }))
    // A third agent whose coordinator fails: the others still finish.
    runs.push({
      ...runs[0],
      config: { ...runs[0].config, name: 'agent-3' },
      coordinator: {
        ...coord.client(agents[2].identityKey),
        services: async () => {
          throw new Error('server unreachable')
        },
      },
    })
    const lines: string[] = []
    const outcomes = await runAgents(runs, (line) => lines.push(line))
    expect(outcomes.map((o) => o.status)).toEqual(['decrypted', 'decrypted', 'error'])
    const summary = outcomes.map((o, i) => summarize(`agent-${i + 1}`, o, 'testnet'))
    console.log(summary.join('\n'))
    expect(summary[0]).toMatch(/paid 3000 sats/)
    expect(summary[0]).toMatch(/funding https:\/\/test\.whatsonchain\.com\/tx\/[0-9a-f]{64}/)
    expect(summary[1]).toMatch(/claim {3}https:\/\/test\.whatsonchain\.com\/tx\//)
    expect(summary[2]).toMatch(/server unreachable/)
    expect(lines.some((l) => l.startsWith('[decrypt] agent-1'))).toBe(true)
  })
})

describe('checkAgents', () => {
  it("reports each agent's identity, deposit address and whether it can cover its offer", async () => {
    const settings = keys.map((key, i) => {
      const keyFile = join(dir, `agent-${i + 1}.key`)
      writeFileSync(keyFile, key.toHex())
      return { name: `agent-${i + 1}`, keyFile, maxContributionSats: 5_000 }
    })
    const report = await checkAgents(settings, 'testnet', async (a) => {
      const i = settings.indexOf(a)
      return { wallet: agents[i], identityKey: agents[i].identityKey, close: async () => undefined }
    })
    expect(report.map((r) => r.identityKey)).toEqual(agents.map((a) => a.identityKey))
    expect(report[0].depositAddress).toBe(depositAddress(keys[0], 'testnet'))
    expect(report.map((r) => r.needed)).toEqual([
      5_000 + FEE_MARGIN_SATS,
      5_000 + FEE_MARGIN_SATS,
      5_000 + FEE_MARGIN_SATS,
    ])
    expect(report[0].ready).toBe(true)
    expect(report[2]).toMatchObject({ balance: 0, ready: false })
  })
})
