// The server end to end on wallet-toolbox's mock chain: real wallets, a real HTTP server and real BRC-103 (AuthFetch).
// Mock chain only: this proves the coordinator's order of calls and its checks, not testnet behaviour.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertSpend,
  broadcastContribution,
  decryptResource,
  prepareContribution,
  refundContribution,
  secretFromClaim,
  verifyRefundSignature,
  verifyTerms,
  type FundingContribution,
  type HtlcContext,
  type HtlcTerms,
  type PurchaseGroup,
  type PurchaseIntent,
  type ServiceOffer,
  type SpendPolicy,
} from '@agentswap/core'
import { AuthFetch, PrivateKey, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createMockChain, type MockChain } from '../../../packages/core/test/helpers/mockchain'
import { createApp } from '../src/app'
import type { ChainView } from '../src/chain'
import { Coordinator } from '../src/coordinator'
import { Feed } from '../src/feed'
import { MockSeller } from '../src/seller'
import { Store } from '../src/store'

type Name = 'alice' | 'bob' | 'carol'
const NAMES: Name[] = ['alice', 'bob', 'carol']

interface Agent {
  ctx: HtlcContext
  identityKey: string
  http: AuthFetch
}

interface Reply<T = any> {
  status: number
  body: T
}

let chain: MockChain
let chainView: ChainView
let sellerWallet: Wallet
const agents = {} as Record<Name, Agent>

interface Running {
  base: string
  coordinator: Coordinator
  feed: Feed
  seller: MockSeller
  clock: { now: number }
  close(): Promise<void>
}
const running: Running[] = []

/** A coordinator behind a real HTTP server. `clock` drives expiry without waiting. */
async function startServer(
  options: { noClaim?: boolean; lockBlocks?: number; dir?: string; tracker?: ChainView['tracker'] } = {},
): Promise<Running> {
  const feed = new Feed('testnet')
  const clock = { now: Date.now() }
  const seller = await MockSeller.create(
    { wallet: sellerWallet, network: 'testnet' },
    {
      lockBlocks: options.lockBlocks ?? 20,
      noClaim: options.noClaim ?? false,
      secretsFile: options.dir && join(options.dir, 'secrets.json'),
    },
  )
  const coordinator = new Coordinator(
    'testnet',
    new Store(options.dir && join(options.dir, 'state.json')),
    feed,
    seller,
    { ...chainView, ...(options.tracker && { tracker: options.tracker }) },
    () => clock.now,
  )
  const app = createApp({
    network: 'testnet',
    coordinator,
    feed,
    authWallet: new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface,
  })
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const entry: Running = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    coordinator,
    feed,
    seller,
    clock,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
  running.push(entry)
  return entry
}

async function call<T = any>(agent: Agent, url: string, method = 'GET', body?: unknown): Promise<Reply<T>> {
  const res = await agent.http.fetch(url, {
    method,
    ...(body !== undefined && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { status: res.status, body: (await res.json()) as T }
}

async function get<T = any>(url: string): Promise<Reply<T>> {
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as T }
}

const newIntent = (service: ServiceOffer, max: number, expiresIn = 600_000) => ({
  network: 'testnet',
  serviceId: service.id,
  resourceId: service.resourceId,
  maxContributionSats: max,
  expiresAt: Date.now() + expiresIn,
})

/** A fresh agent with money, for tests that must not share state on the group's shares. */
async function newAgent(): Promise<Agent> {
  const wallet = await chain.makeWallet()
  await chain.fund(wallet)
  return {
    ctx: { wallet, network: 'testnet' },
    identityKey: wallet.identityKey,
    http: new AuthFetch(wallet),
  }
}

/** Three agents post intents; the third completes the group. Returns the group with its terms. */
async function matchedGroup(
  server: Running,
  members: Agent[] = NAMES.map((n) => agents[n]),
  maxima = [3_000, 4_000, 5_000],
): Promise<{ service: ServiceOffer; group: PurchaseGroup; terms: HtlcTerms; intents: PurchaseIntent[] }> {
  const [service] = (await get<ServiceOffer[]>(`${server.base}/api/services`)).body
  const intents: PurchaseIntent[] = []
  let group: PurchaseGroup | undefined
  for (const [i, member] of members.entries()) {
    const reply = await call(member, `${server.base}/api/intents`, 'POST', newIntent(service, maxima[i]))
    expect(reply.status).toBe(201)
    intents.push(reply.body.intent)
    group = reply.body.group
  }
  expect(group?.status).toBe('matched')
  return { service, group: group!, terms: group!.terms!, intents }
}

async function authorizeAll(server: Running, groupId: string, members: Agent[]): Promise<void> {
  for (const member of members) {
    expect((await call(member, `${server.base}/api/groups/${groupId}/authorize`, 'POST', {})).status).toBe(
      200,
    )
  }
}

/** The agent's side of funding, in the order the plan fixes. */
async function fund(server: Running, member: Agent, terms: HtlcTerms): Promise<FundingContribution> {
  const url = `${server.base}/api/groups/${terms.groupId}`
  const { contribution, beef } = await prepareContribution(member.ctx, terms)
  const signed = await call(member, `${url}/contributions`, 'POST', contribution)
  expect(signed.status).toBe(200)
  expect(verifyRefundSignature(terms, contribution, signed.body.refundSignature)).toBe(true)
  const sent = await broadcastContribution(
    member.ctx,
    terms,
    { ...contribution, refundSignature: signed.body.refundSignature },
    beef,
  )
  const funded = await call(member, `${url}/funding`, 'POST', sent.contribution)
  expect(funded.status).toBe(200)
  return sent.contribution
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('timed out')
}

beforeAll(async () => {
  chain = await createMockChain()
  chainView = {
    currentHeight: () => chain.services.getHeight(),
    getRawTx: async (txid) => (await chain.services.getRawTx(txid)).rawTx,
    tracker: chain.chainTracker,
  }
  // The seller gets no funds: the claim pays its fee out of the HTLC values.
  sellerWallet = await chain.makeWallet()
  for (const name of NAMES) agents[name] = await newAgent()
})

afterEach(async () => {
  for (const server of running.splice(0)) {
    server.coordinator.stop()
    await server.close()
  }
})

afterAll(async () => {
  await chain?.close()
})

describe('the demo flow', () => {
  it('three agents match, fund and decrypt; the seller claims all shares in one transaction', async () => {
    const server = await startServer()
    const members = NAMES.map((n) => agents[n])
    const { group, terms, intents, service } = await matchedGroup(server)
    expect(service.simulation).toBe(true)
    // The clock is fixed here, so the order of equal createdAt values is the intents' random ids.
    const shares = (g: PurchaseGroup) => g.participants.map((p) => p.shareSats).sort((a, b) => a - b)
    expect(shares(group)).toEqual([3_000, 4_000, 5_000])
    for (const [i, member] of members.entries()) {
      expect(group.participants.find((p) => p.identityKey === member.identityKey)?.intentId).toBe(
        intents[i].id,
      )
    }
    await verifyTerms(terms)

    // An agent finds its group from its intent, and the seller's K is in nothing public before the claim.
    const found = await get(`${server.base}/api/groups?intentId=${intents[0].id}`)
    expect(found.body.map((g: PurchaseGroup) => g.id)).toEqual([group.id])
    expect(found.body[0].ciphertext).toBeUndefined()
    const before = await get(`${server.base}/api/groups/${group.id}/settlement`)
    expect(before.body).toMatchObject({ status: 'matched', refundAvailable: false })
    expect(before.body.claim).toBeUndefined()
    expect(before.body.claimTx).toBeUndefined()

    const statuses = await get<PurchaseIntent[]>(`${server.base}/api/intents`)
    expect(statuses.body.map((i) => i.status)).toEqual(['matched', 'matched', 'matched'])

    const policy: SpendPolicy = {
      maxPerPurchaseSats: 5_000,
      maxTotalSats: 20_000,
      allowedServiceIds: [service.id],
      requireMatchingResource: true,
      maxLockBlocks: 50,
    }
    for (const [i, member] of members.entries()) {
      assertSpend(policy, {
        terms,
        identityKey: member.identityKey,
        intent: intents[i],
        currentHeight: await chain.services.getHeight(),
        spentSats: 0,
      })
    }

    await authorizeAll(server, group.id, members)
    const committed = await get<PurchaseIntent[]>(`${server.base}/api/intents`)
    expect(committed.body.map((i) => i.status)).toEqual(['committed', 'committed', 'committed'])

    const contributions: FundingContribution[] = []
    for (const member of members) contributions.push(await fund(server, member, terms))

    const settled = await until(
      () => get(`${server.base}/api/groups/${group.id}/settlement`),
      (r) => r.body.status === 'claimed' || r.body.status === 'settlement_failed',
    )
    expect(settled.body.status).toBe('claimed')
    expect(settled.body.claim.outpoints.sort()).toEqual(
      contributions.map((c) => `${c.txid}.${c.vout}`).sort(),
    )
    expect(await sellerWallet.balance()).toBeGreaterThan(11_000)

    // Each buyer reads K from the claim transaction itself and opens the dataset.
    const { body: full } = await get(`${server.base}/api/groups/${group.id}`)
    const secret = secretFromClaim(terms, settled.body.claimTx)
    const data = JSON.parse(Utils.toUTF8(decryptResource(terms, secret, full.ciphertext)))
    expect(data).toMatchObject({ simulation: true, pair: 'BSV/USD' })

    // The dashboard's links and the feed name every transaction.
    expect(full.transactions.map((t: { kind: string }) => t.kind).sort()).toEqual([
      'claim',
      'funding',
      'funding',
      'funding',
    ])
    for (const t of full.transactions) expect(t.wocUrl).toContain(`test.whatsonchain.com/tx/${t.txid}`)
    const feedTypes = server.feed.since().map((e) => e.type)
    for (const type of ['intent', 'group', 'lock', 'claim']) expect(feedTypes).toContain(type)
    expect(server.feed.since().find((e) => e.type === 'claim')?.wocUrl).toContain(settled.body.claim.txid)
  })

  it('without a claim every buyer gets its money back after the refund height', async () => {
    const server = await startServer({ noClaim: true, lockBlocks: 4 })
    const members = [await newAgent(), await newAgent()]
    const { group, terms } = await matchedGroup(server, members, [6_000, 6_000])
    await authorizeAll(server, group.id, members)
    const contributions: FundingContribution[] = []
    for (const member of members) contributions.push(await fund(server, member, terms))
    await server.coordinator.tick()
    expect(server.coordinator.settlement(group.id).status).toBe('locked')

    // Too early: the wallet refuses a transaction that is not final yet.
    await expect(refundContribution(members[0].ctx, terms, contributions[0])).rejects.toThrow()

    // At refundHeight itself the wallet still says "not final", so the server does not announce refunds yet.
    while ((await chain.services.getHeight()) < terms.refundHeight) await chain.mineBlock()
    await server.coordinator.tick()
    expect(server.coordinator.settlement(group.id).status).toBe('locked')
    await expect(refundContribution(members[0].ctx, terms, contributions[0])).rejects.toThrow(/not final/)
    await chain.mineBlock()
    await server.coordinator.tick()
    expect(server.coordinator.settlement(group.id)).toMatchObject({
      status: 'refund_available',
      refundAvailable: true,
    })

    const url = `${server.base}/api/groups/${group.id}/refunds`
    const first = await refundContribution(members[0].ctx, terms, contributions[0])
    // Bob cannot report Alice's refund, and a transaction that is not a refund is no proof.
    expect((await call(members[1], url, 'POST', { txid: first.txid })).status).toBe(422)
    expect((await call(members[0], url, 'POST', { txid: contributions[1].txid })).status).toBe(422)
    expect((await call(members[0], url, 'POST', { txid: first.txid })).status).toBe(200)
    expect(server.coordinator.settlement(group.id).status).toBe('refund_available')

    const second = await refundContribution(members[1].ctx, terms, contributions[1])
    expect((await call(members[1], url, 'POST', { txid: second.txid })).status).toBe(200)
    const done = server.coordinator.settlement(group.id)
    expect(done.status).toBe('refunded')
    expect(done.refunds.map((r) => r.txid)).toEqual([first.txid, second.txid])
    expect(server.feed.since().filter((e) => e.type === 'refund' && e.txid !== undefined)).toHaveLength(2)
  })
})

describe('who may do what', () => {
  it('refuses writes without a signed request, also when a header or the body claims an identity', async () => {
    const server = await startServer()
    const [service] = (await get<ServiceOffer[]>(`${server.base}/api/services`)).body
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    const intent = { ...newIntent(service, 5_000), agentIdentityKey: agents.alice.identityKey }
    expect((await post('/api/intents', intent)).status).toBe(401)
    // A claimed identity without a signature is refused by the middleware itself.
    const forged = await post('/api/intents', intent, { 'x-bsv-auth-identity-key': agents.alice.identityKey })
    expect(forged.status).toBeGreaterThanOrEqual(400)
    expect(forged.status).toBeLessThan(500)
    expect((await post('/api/events', { message: 'hello' })).status).toBe(401)
    expect((await get(`${server.base}/api/intents`)).body).toEqual([])
  })

  it('the identity comes from auth: a different one in the body is ignored or refused', async () => {
    const server = await startServer()
    const [service] = (await get<ServiceOffer[]>(`${server.base}/api/services`)).body
    const reply = await call(agents.alice, `${server.base}/api/intents`, 'POST', {
      ...newIntent(service, 4_000),
      agentIdentityKey: agents.bob.identityKey,
      status: 'matched',
      id: 'chosen-by-the-caller',
    })
    expect(reply.body.intent.agentIdentityKey).toBe(agents.alice.identityKey)
    expect(reply.body.intent.status).toBe('open')
    expect(reply.body.intent.id).not.toBe('chosen-by-the-caller')
  })

  it('checks intents', async () => {
    const server = await startServer()
    const [service] = (await get<ServiceOffer[]>(`${server.base}/api/services`)).body
    const url = `${server.base}/api/intents`
    const good = newIntent(service, 4_000)
    const bad: [Record<string, unknown>, number][] = [
      [{ ...good, network: 'mainnet' }, 400],
      [{ ...good, serviceId: 'nothing' }, 404],
      [{ ...good, resourceId: 'other' }, 400],
      [{ ...good, maxContributionSats: 999 }, 400],
      [{ ...good, maxContributionSats: 4000.5 }, 400],
      [{ ...good, maxContributionSats: '4000' }, 400],
      [{ ...good, expiresAt: Date.now() - 60_000 }, 400],
      [{ ...good, expiresAt: Date.now() + 2 * 24 * 3600_000 }, 400],
    ]
    for (const [body, status] of bad)
      expect((await call(agents.alice, url, 'POST', body)).status).toBe(status)
    expect((await call(agents.alice, url, 'POST', good)).status).toBe(201)
    expect((await call(agents.alice, url, 'POST', good)).status).toBe(409)
    expect((await get(url)).body).toHaveLength(1)
  })

  it('the seller cannot join its own sale', async () => {
    const server = await startServer()
    const [service] = (await get<ServiceOffer[]>(`${server.base}/api/services`)).body
    const reply = await call(
      { ...agents.alice, http: new AuthFetch(sellerWallet) },
      `${server.base}/api/intents`,
      'POST',
      newIntent(service, 20_000),
    )
    expect(reply.status).toBe(400)
  })

  it('a contribution is checked before the seller signs anything', async () => {
    const server = await startServer()
    const members = [await newAgent(), await newAgent(), await newAgent()]
    const outsider = await newAgent()
    const { group, terms } = await matchedGroup(server, members)
    const url = `${server.base}/api/groups/${group.id}`

    // Terms exist, but nobody may fund until everyone has accepted them.
    const early = await prepareContribution(members[0].ctx, terms)
    expect((await call(members[0], `${url}/contributions`, 'POST', early.contribution)).status).toBe(409)
    expect((await call(outsider, `${url}/authorize`, 'POST', {})).status).toBe(409)
    await authorizeAll(server, group.id, members)
    expect((await call(members[0], `${url}/authorize`, 'POST', {})).status).toBe(409)

    const { contribution, beef } = early
    const post = (member: Agent, body: unknown) => call(member, `${url}/contributions`, 'POST', body)
    expect((await post(outsider, contribution)).status).toBe(403)
    expect((await post(members[1], contribution)).status).toBe(403)
    // Without the identity in the body: Bob's HTLC is not the one this script names.
    const { identityKey: _, ...anonymous } = contribution
    expect((await post(members[1], anonymous)).status).toBe(422)
    expect((await post(members[0], { ...contribution, satoshis: contribution.satoshis - 1 })).status).toBe(
      422,
    )
    expect((await post(members[0], { ...contribution, beef })).status).toBe(400)
    expect((await post(members[0], { ...contribution, txid: 'zz' })).status).toBe(400)
    expect((await post(members[0], { ...contribution, vout: -1 })).status).toBe(400)
    expect((await post(members[0], { lockingScript: 'zz' })).status).toBe(400)

    // Funding needs the signed contribution first, and must be that contribution.
    const funding = `${url}/funding`
    expect((await call(members[0], funding, 'POST', { ...contribution, beef })).status).toBe(409)
    const signed = await post(members[0], contribution)
    expect(signed.status).toBe(200)
    expect(signed.body.refundSignature).toMatch(/^[0-9a-f]+$/)
    const sent = await broadcastContribution(
      members[0].ctx,
      terms,
      { ...contribution, refundSignature: signed.body.refundSignature },
      beef,
    )
    const later = await prepareContribution(members[1].ctx, terms)
    expect(
      (
        await call(members[0], funding, 'POST', {
          ...later.contribution,
          identityKey: members[0].identityKey,
          beef: later.beef,
        })
      ).status,
    ).toBe(409)
    expect((await call(members[0], funding, 'POST', { ...sent.contribution, beef: 'zz' })).status).toBe(400)
    expect((await call(members[0], funding, 'POST', { ...sent.contribution, beef: later.beef })).status).toBe(
      422,
    )
    expect((await call(members[0], funding, 'POST', sent.contribution)).status).toBe(200)
    // Funding twice is refused by the state machine, and the share stays.
    expect((await call(members[0], funding, 'POST', sent.contribution)).status).toBe(409)
    expect((await post(members[0], contribution)).status).toBe(409)
    expect(server.coordinator.settlement(group.id).status).toBe('funding')
  })

  it('agents post only as themselves, only agent events, and links are ours', async () => {
    const server = await startServer()
    const url = `${server.base}/api/events`
    const txid = 'ab'.repeat(32)
    const reply = await call(agents.alice, url, 'POST', {
      type: 'claim',
      message: 'the seller claimed',
      txid,
      wocUrl: 'https://evil.example',
    })
    expect(reply.status).toBe(201)
    expect(reply.body.type).toBe('agent')
    expect(reply.body.message).toContain(agents.alice.identityKey.slice(0, 10))
    expect(reply.body.wocUrl).toBe(`https://test.whatsonchain.com/tx/${txid}`)
    for (const body of [{}, { message: '' }, { message: 'x'.repeat(501) }, { message: 'ok', txid: 'nope' }]) {
      expect((await call(agents.alice, url, 'POST', body)).status).toBe(400)
    }
  })

  it('answers unknown groups and broken JSON as client errors', async () => {
    const server = await startServer()
    expect((await get(`${server.base}/api/groups/nothing`)).status).toBe(404)
    expect((await get(`${server.base}/api/nothing`)).status).toBe(404)
    expect((await call(agents.alice, `${server.base}/api/groups/nothing/authorize`, 'POST', {})).status).toBe(
      404,
    )
    const broken = await fetch(`${server.base}/api/intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(broken.status).toBe(400)
    expect(await broken.json()).toHaveProperty('error')
  })
})

describe('the live parts', () => {
  it('streams the feed to a client without a wallet, history first', async () => {
    const server = await startServer()
    server.feed.publish({ type: 'agent', message: 'before connecting' })
    const abort = new AbortController()
    const res = await fetch(`${server.base}/api/feed`, { signal: abort.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    server.feed.publish({ type: 'agent', message: 'after connecting' })
    while (!text.includes('after connecting')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    abort.abort()
    expect(text.indexOf('before connecting')).toBeLessThan(text.indexOf('after connecting'))
    expect(text).toMatch(/^id: 1\ndata: \{/)
  })

  it('opens the stream before there is any event', async () => {
    const server = await startServer()
    const res = await fetch(`${server.base}/api/feed`, { signal: AbortSignal.timeout(5_000) })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body!.cancel()
  })

  it('a very small intent does not block a service: the others match and it stays open', async () => {
    const server = await startServer()
    const members = [await newAgent(), await newAgent(), await newAgent()]
    const [service] = (await get<ServiceOffer[]>(`${server.base}/api/services`)).body
    const url = `${server.base}/api/intents`
    // 1,000 + 5,000 + 9,000 would give the first a share of 800, below the minimum.
    const small = await call(members[0], url, 'POST', newIntent(service, 1_000))
    await call(members[1], url, 'POST', newIntent(service, 5_000))
    const last = await call(members[2], url, 'POST', newIntent(service, 9_000))
    expect(last.status).toBe(201)
    const shares = last.body.group.participants.map((p: { shareSats: number }) => p.shareSats)
    expect(shares.sort((a: number, b: number) => a - b)).toEqual([4_286, 7_714])
    const intents = (await get<PurchaseIntent[]>(url)).body
    expect(intents.find((i) => i.id === small.body.intent.id)?.status).toBe('open')
  })

  it('expires what nobody paid for, and frees the agents to try again', async () => {
    const server = await startServer()
    const members = [await newAgent(), await newAgent()]
    const { group, intents, service } = await matchedGroup(server, members, [6_000, 6_000])
    server.clock.now = group.expiresAt
    await server.coordinator.tick()
    expect(server.coordinator.settlement(group.id).status).toBe('expired')
    expect(server.coordinator.intents().map((i) => i.status)).toEqual(['expired', 'expired'])
    expect(intents).toHaveLength(2)
    server.clock.now = Date.now()
    const again = await call(members[0], `${server.base}/api/intents`, 'POST', newIntent(service, 6_000))
    expect(again.status).toBe(201)

    // An open intent nobody matched also expires.
    server.clock.now = again.body.intent.expiresAt
    await server.coordinator.tick()
    expect(server.coordinator.intents().at(-1)?.status).toBe('expired')
  })

  it('a buyer who never funds fails the group; the funded buyer refunds; the seller never claims', async () => {
    const server = await startServer({ lockBlocks: 4 })
    const members = [await newAgent(), await newAgent()]
    const { group, terms } = await matchedGroup(server, members, [6_000, 6_000])
    await authorizeAll(server, group.id, members)
    const funded = await fund(server, members[0], terms)
    expect(server.coordinator.settlement(group.id).status).toBe('funding')

    server.clock.now = group.expiresAt
    await server.coordinator.tick()
    expect(server.coordinator.settlement(group.id).status).toBe('funding_failed')
    const late = await prepareContribution(members[1].ctx, terms)
    expect(
      (
        await call(
          members[1],
          `${server.base}/api/groups/${group.id}/contributions`,
          'POST',
          late.contribution,
        )
      ).status,
    ).toBe(409)

    while ((await chain.services.getHeight()) <= terms.refundHeight) await chain.mineBlock()
    await server.coordinator.tick()
    expect(server.coordinator.settlement(group.id).status).toBe('refund_available')
    const refund = await refundContribution(members[0].ctx, terms, funded)
    const reply = await call(members[0], `${server.base}/api/groups/${group.id}/refunds`, 'POST', {
      txid: refund.txid,
    })
    expect(reply.status).toBe(200)
    expect(server.coordinator.settlement(group.id).status).toBe('refunded')
    expect(server.coordinator.settlement(group.id).claim).toBeUndefined()
  })

  it('concurrent funding of one group loses no share', async () => {
    // A slow SPV check holds every request inside its await, where one write could overwrite another.
    const server = await startServer({
      tracker: {
        currentHeight: () => chain.chainTracker.currentHeight(),
        isValidRootForHeight: async (root, height) => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return await chain.chainTracker.isValidRootForHeight(root, height)
        },
      },
    })
    const members = [await newAgent(), await newAgent(), await newAgent()]
    const { group, terms } = await matchedGroup(server, members)
    await authorizeAll(server, group.id, members)
    const url = `${server.base}/api/groups/${group.id}`
    const ready = []
    for (const member of members) {
      const { contribution, beef } = await prepareContribution(member.ctx, terms)
      const { body } = await call(member, `${url}/contributions`, 'POST', contribution)
      const sent = await broadcastContribution(
        member.ctx,
        terms,
        { ...contribution, refundSignature: body.refundSignature },
        beef,
      )
      ready.push({ member, contribution: sent.contribution })
    }
    const replies = await Promise.all(
      ready.map(({ member, contribution }) => call(member, `${url}/funding`, 'POST', contribution)),
    )
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200])
    const settled = await until(
      () => get(`${url}/settlement`),
      (r) => r.body.status === 'claimed' || r.body.status === 'settlement_failed',
    )
    expect(settled.body.status).toBe('claimed')
  })
})

describe('the claim', () => {
  it('does not claim too close to the refund height', async () => {
    const server = await startServer({ lockBlocks: 4 })
    const members = [await newAgent(), await newAgent()]
    const { group, terms } = await matchedGroup(server, members, [6_000, 6_000])
    await authorizeAll(server, group.id, members)
    await fund(server, members[0], terms)
    while ((await chain.services.getHeight()) < terms.refundHeight - 2) await chain.mineBlock()
    await fund(server, members[1], terms)
    const settled = await until(
      async () => server.coordinator.settlement(group.id),
      (s) => s.status !== 'locked',
    )
    expect(settled.status).toBe('settlement_failed')
    expect(settled.claim).toBeUndefined()
  })
})

describe('a restart', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('keeps groups and the seller key, keeps K out of the public state, and still settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashcrowd-'))
    dirs.push(dir)
    const members = [await newAgent(), await newAgent()]
    const first = await startServer({ dir, noClaim: true })
    const { group, terms } = await matchedGroup(first, members, [6_000, 6_000])
    await authorizeAll(first, group.id, members)
    for (const member of members) await fund(first, member, terms)
    expect(first.coordinator.settlement(group.id).status).toBe('locked')
    first.coordinator.stop()
    await first.close()

    const [[, secret]] = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as [string, string][]
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).not.toContain(secret)

    const second = await startServer({ dir })
    expect(second.coordinator.settlement(group.id).status).toBe('locked')
    // The ticker picks up the locked group the crashed process never claimed.
    await second.coordinator.tick()
    const settled = second.coordinator.settlement(group.id)
    expect(settled.status).toBe('claimed')
    expect(Utils.toHex(secretFromClaim(terms, settled.claimTx!))).toBe(secret)
  })
})
