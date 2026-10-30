import { PrivateKey } from '@bsv/sdk'
import type { GroupParticipant, ServiceOffer } from '@agentswap/core'
import { shortKey, type FeedItem, type GroupView } from './model'

// Simulation data for the dashboard until it reads apps/server (session 4). Same shapes as the API. It never holds a
// txid: the page must not show a transaction that does not exist, so simulated groups have no transactions.

export interface DashboardData {
  services: ServiceOffer[]
  groups: GroupView[]
  feed: FeedItem[]
  /** True for this file's data: the page labels it "simulation". */
  simulation: boolean
}

/** Valid, fixed public keys, so the page looks real without pointing at anyone's wallet. */
const key = (n: number) => new PrivateKey(n).toPublicKey().toString()

const SELLER = key(1)
const AGENTS = [key(2), key(3), key(4), key(5)]
const a = (agent: number) => shortKey(AGENTS[agent])

const service = (id: string, title: string, resourceId: string, priceSats: number): ServiceOffer => ({
  id,
  network: 'testnet',
  sellerIdentityKey: SELLER,
  title,
  resourceId,
  priceSats,
  license: 'shared-within-group',
  simulation: true,
})

const participant = (
  agent: number,
  shareSats: number,
  status: GroupParticipant['status'],
  maxContributionSats = shareSats,
): GroupParticipant => ({
  identityKey: AGENTS[agent],
  intentId: `intent-${agent + 1}`,
  maxContributionSats,
  shareSats,
  status,
})

export function mockData(now = Date.now()): DashboardData {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  const closes = service('bsv-usd-closes', 'BSV/USD daily closes, October 2026', 'bsvusd-2026-10', 12_000)
  const weather = service('munich-weather', 'Munich weather station readings, 2025', 'munich-2025', 30_000)

  const group = (
    id: string,
    offer: ServiceOffer,
    status: GroupView['status'],
    participants: GroupParticipant[],
    minutesAgo: number,
  ): GroupView => ({
    id,
    network: 'testnet',
    serviceId: offer.id,
    resourceId: offer.resourceId,
    priceSats: offer.priceSats,
    participants,
    status,
    refunds: [],
    createdAt: iso(minutesAgo),
    expiresAt: now + 60 * 60_000,
    transactions: [],
  })

  return {
    simulation: true,
    services: [closes, weather],
    groups: [
      group(
        'group-a1',
        closes,
        'funding',
        [participant(0, 4_000, 'funded'), participant(1, 4_000, 'funded'), participant(2, 4_000, 'authorized', 5_000)],
        6,
      ),
      group('group-b2', weather, 'open', [participant(3, 0, 'joined', 12_000)], 3),
      group(
        'group-c3',
        closes,
        'claimed',
        [participant(1, 6_000, 'funded'), participant(3, 6_000, 'funded')],
        48,
      ),
      group(
        'group-d4',
        weather,
        'refund_available',
        [participant(0, 10_000, 'funded'), participant(2, 10_000, 'funded'), participant(3, 10_000, 'authorized')],
        95,
      ),
    ],
    feed: [
      { id: 1, type: 'intent', message: `${a(0)} wants bsvusd-2026-10, up to 4,000 sats`, at: iso(7) },
      { id: 2, type: 'intent', message: `${a(1)} wants bsvusd-2026-10, up to 4,000 sats`, at: iso(7) },
      { id: 3, type: 'intent', message: `${a(2)} wants bsvusd-2026-10, up to 5,000 sats`, at: iso(6) },
      { id: 4, type: 'group', message: 'group group-a1 matched: 3 buyers, 4,000 sats each', at: iso(6) },
      { id: 5, type: 'group', message: 'group group-a1 is committed: every buyer accepted', at: iso(5) },
      { id: 6, type: 'lock', message: `${a(0)} locked 4,000 sats in group-a1`, at: iso(4) },
      { id: 7, type: 'intent', message: `${a(3)} wants munich-2025, up to 12,000 sats`, at: iso(3) },
      { id: 8, type: 'lock', message: `${a(1)} locked 4,000 sats in group-a1`, at: iso(2) },
      { id: 9, type: 'agent', message: `${a(2)}: checking the terms of group-a1 before paying`, at: iso(1) },
    ],
  }
}
