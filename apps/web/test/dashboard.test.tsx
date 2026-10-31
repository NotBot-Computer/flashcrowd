import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivityList, Dashboard, GroupDetail, GroupList } from '../src/Dashboard'
import { mockData } from '../src/mock'
import {
  dashboardStats,
  fundedSats,
  fundingProgress,
  groupEvents,
  groupStatus,
  maxBuyers,
  serviceTitle,
  shortGroupId,
  shortKey,
  timeAgo,
  type GroupView,
} from '../src/model'

const HEX64 = /[0-9a-f]{64}/i
const NOW = Date.parse('2026-10-31T10:00:00Z')

const groupWith = (overrides: Partial<GroupView>): GroupView => ({ ...mockData(NOW).groups[0], ...overrides })

describe('model', () => {
  it('counts only funded shares towards the price', () => {
    const group = mockData(NOW).groups.find((g) => g.id === 'group-a1')!
    expect(fundedSats(group)).toBe(8_000)
    expect(fundingProgress(group)).toBeCloseTo(8_000 / 12_000)
  })

  it('caps progress at 1 and handles a zero price', () => {
    expect(fundingProgress(groupWith({ priceSats: 1_000 }))).toBe(1)
    expect(fundingProgress(groupWith({ priceSats: 0 }))).toBe(0)
  })

  it('labels every group status', () => {
    expect(groupStatus('refund_available')).toEqual({ label: 'Refund available', tone: 'warning' })
    expect(groupStatus('claimed').tone).toBe('success')
  })

  it('splits a price into shares of at least the minimum', () => {
    expect(maxBuyers(12_000)).toBe(12)
    expect(maxBuyers(999)).toBe(0)
  })

  it('shortens keys but leaves short strings alone', () => {
    expect(shortKey('02' + 'ab'.repeat(32))).toBe('02ababab…abab')
    expect(shortKey('group-a1')).toBe('group-a1')
  })

  it("shortens the server's group ids to their first block", () => {
    expect(shortGroupId('group-de38ed6a-430d-4496-9930-83fb13836f1f')).toBe('group-de38ed6a…')
    expect(shortGroupId('group-a1')).toBe('group-a1')
  })

  it('drops a "(simulation)" suffix only from simulation services', () => {
    expect(serviceTitle('BSV/USD daily closes (simulation)', true)).toBe('BSV/USD daily closes')
    expect(serviceTitle('BSV/USD daily closes (simulation)', false)).toBe('BSV/USD daily closes (simulation)')
  })

  it('dates feed events relative to now', () => {
    const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()
    expect(timeAgo(at(10), NOW)).toBe('just now')
    expect(timeAgo(at(4 * 60), NOW)).toBe('4 min ago')
    expect(timeAgo(at(3 * 3600), NOW)).toBe('3 h ago')
    expect(timeAgo(at(2 * 86400), NOW)).toBe('2 d ago')
    expect(timeAgo(at(-30), NOW)).toBe('just now')
  })
})

describe('simulation data', () => {
  const data = mockData(NOW)

  it('never contains a txid', () => {
    for (const g of data.groups) {
      expect(g.transactions).toEqual([])
      expect(g.claim).toBeUndefined()
      expect(g.refunds).toEqual([])
      for (const p of g.participants) expect(p.contribution).toBeUndefined()
    }
    for (const e of data.feed) {
      expect(e.txid).toBeUndefined()
      expect(e.wocUrl).toBeUndefined()
    }
  })

  it('marks every service as simulation', () => {
    expect(data.simulation).toBe(true)
    for (const s of data.services) expect(s.simulation).toBe(true)
  })

  it('never shares out more than the price', () => {
    for (const g of data.groups) {
      const shares = g.participants.reduce((sum, p) => sum + p.shareSats, 0)
      expect(shares).toBeLessThanOrEqual(g.priceSats)
    }
  })
})

describe('overview numbers', () => {
  it('sums funding and counts groups, outcomes and distinct agents', () => {
    expect(dashboardStats(mockData(NOW).groups)).toEqual({
      fundedSats: 8_000 + 12_000 + 20_000,
      groups: 4,
      claimed: 1,
      refunded: 0,
      agents: 4,
    })
  })

  it('picks the events that name a group', () => {
    const feed = mockData(NOW).feed
    expect(groupEvents(feed, 'group-a1').every((e) => e.message.includes('group-a1'))).toBe(true)
    expect(groupEvents(feed, 'group-a1')).toHaveLength(5)
    expect(groupEvents(feed, 'nope')).toEqual([])
  })
})

describe('Dashboard', () => {
  it('labels simulation data and shows no transaction id', () => {
    const html = renderToStaticMarkup(<Dashboard data={mockData(NOW)} now={NOW} />)
    expect(html).toContain('Simulation.')
    // Identity keys appear only shortened in the text; full keys sit in title attributes, txids nowhere.
    const text = html.replace(/title="[^"]*"/g, '')
    expect(text).not.toMatch(HEX64)
  })

  it('lists every service and group, and the numbers', () => {
    const data = mockData(NOW)
    const html = renderToStaticMarkup(<Dashboard data={data} now={NOW} />)
    for (const s of data.services) expect(html).toContain(s.title)
    for (const g of data.groups) expect(html).toContain(g.id)
    expect(html).toContain('40,000')
    expect(html).toContain('sats funded')
  })

  it('shows the block height when the server reports it', () => {
    const health = { ok: true, network: 'mainnet' as const, height: 973343 }
    const html = renderToStaticMarkup(<Dashboard data={mockData(NOW)} health={health} now={NOW} />)
    expect(html).toContain('973,343')
    expect(html).toContain('block · mainnet')
  })

  it('has no simulation notice for live data', () => {
    const html = renderToStaticMarkup(<Dashboard data={{ ...mockData(NOW), simulation: false }} now={NOW} />)
    expect(html).not.toContain('Simulation.')
  })
})

describe('GroupList', () => {
  const services = mockData(NOW).services

  it('shows a long group id shortened, with the full id on hover', () => {
    const id = 'group-de38ed6a-430d-4496-9930-83fb13836f1f'
    const html = renderToStaticMarkup(
      <GroupList groups={[groupWith({ id })]} services={services} onSelect={() => {}} now={NOW} />,
    )
    expect(html).toContain('group-de38ed6a…')
    expect(html).toContain(`title="${id}"`)
  })

  it('says when there are no groups', () => {
    const html = renderToStaticMarkup(<GroupList groups={[]} services={services} onSelect={() => {}} />)
    expect(html).toContain('No purchase groups yet')
  })
})

describe('GroupDetail', () => {
  it('links every real transaction to WhatsOnChain', () => {
    const txid = 'cd'.repeat(32)
    const wocUrl = `https://test.whatsonchain.com/tx/${txid}`
    const group = groupWith({ transactions: [{ kind: 'claim', txid, wocUrl }] })
    const html = renderToStaticMarkup(
      <GroupDetail group={group} title="Dataset" simulation={false} events={[]} />,
    )
    expect(html).toContain(`href="${wocUrl}"`)
    expect(html).not.toContain('None yet')
  })

  it('says a simulated group has no transactions, and shows its events', () => {
    const data = mockData(NOW)
    const group = data.groups[0]
    const html = renderToStaticMarkup(
      <GroupDetail
        group={group}
        title="Dataset"
        simulation
        events={groupEvents(data.feed, group.id)}
        now={NOW}
      />,
    )
    expect(html).toContain('None in simulation')
    expect(html).toContain('is committed: every buyer accepted')
  })
})

describe('ActivityList', () => {
  const items = [
    { id: 1, type: 'intent' as const, message: 'first', at: '2026-10-31T10:00:00Z' },
    { id: 2, type: 'group' as const, message: 'second', at: '2026-10-31T10:01:00Z' },
    { id: 3, type: 'lock' as const, message: 'third', at: '2026-10-31T10:02:00Z' },
  ]

  it('shows the newest event first', () => {
    const html = renderToStaticMarkup(<ActivityList items={items} />)
    expect(html.indexOf('second')).toBeLessThan(html.indexOf('first'))
  })

  it('keeps only the newest events when limited', () => {
    const html = renderToStaticMarkup(<ActivityList items={items} limit={2} />)
    expect(html).toContain('third')
    expect(html).not.toContain('first')
  })

  it('says when there are no events', () => {
    expect(renderToStaticMarkup(<ActivityList items={[]} />)).toContain('No events yet.')
  })
})
