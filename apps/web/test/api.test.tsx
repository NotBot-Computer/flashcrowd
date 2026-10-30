import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  addFeedItem,
  ApiError,
  fetchGroup,
  fetchServices,
  loadDashboard,
  subscribeFeed,
  type FeedStatus,
} from '../src/api'
import { Dashboard } from '../src/Dashboard'
import { mockData } from '../src/mock'
import type { FeedItem } from '../src/model'
import { SourceBar } from '../src/SourceBar'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fetch that answers by path, like apps/server would. */
function server(routes: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const route = routes[String(input)]
    return route ? route() : json({ error: 'not found' }, 404)
  }) as unknown as typeof fetch
}

const sample = mockData(Date.parse('2026-10-31T10:00:00Z'))
const [older, newer] = [sample.groups[2], sample.groups[0]]

describe('loadDashboard', () => {
  it('reads services and every group with its transactions, newest group first', async () => {
    const txid = 'ef'.repeat(32)
    const withTx = { ...older, transactions: [{ kind: 'claim', txid, wocUrl: `https://whatsonchain.com/tx/${txid}` }] }
    const fetchImpl = server({
      '/api/services': () => json(sample.services),
      '/api/groups': () => json([older, newer].map(({ transactions: _, ...g }) => g)),
      [`/api/groups/${older.id}`]: () => json(withTx),
      [`/api/groups/${newer.id}`]: () => json(newer),
    })
    const data = await loadDashboard(fetchImpl)
    expect(data.simulation).toBe(false)
    expect(data.services).toEqual(sample.services)
    expect(data.groups.map((g) => g.id)).toEqual([newer.id, older.id])
    expect(data.groups[1].transactions[0].txid).toBe(txid)
  })

  it('works with no groups', async () => {
    const fetchImpl = server({ '/api/services': () => json([]), '/api/groups': () => json([]) })
    expect(await loadDashboard(fetchImpl)).toEqual({ services: [], groups: [], feed: [], simulation: false })
  })
})

describe('errors', () => {
  it('says the server is unreachable when fetch fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(fetchServices(fetchImpl)).rejects.toThrow(/unreachable.*Failed to fetch/)
  })

  it("passes on the server's error and status", async () => {
    const error = await fetchGroup('nope', server({})).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(404)
    expect((error as ApiError).message).toContain('not found')
  })

  it('rejects a page that is not JSON, like a proxy error page', async () => {
    const fetchImpl = server({ '/api/services': () => new Response('<html>Bad gateway</html>', { status: 502 }) })
    await expect(fetchServices(fetchImpl)).rejects.toThrow('did not return JSON (HTTP 502)')
  })

  it('rejects an unexpected shape', async () => {
    const fetchImpl = server({ '/api/services': () => json({ services: [] }) })
    await expect(fetchServices(fetchImpl)).rejects.toThrow('unexpected shape')
  })

  it('encodes group ids in the path', async () => {
    const fetchImpl = server({})
    await fetchGroup('a/b?c', fetchImpl).catch(() => undefined)
    expect(fetchImpl).toHaveBeenCalledWith('/api/groups/a%2Fb%3Fc', expect.anything())
  })
})

describe('subscribeFeed', () => {
  function fakeSource() {
    const source = {
      onopen: null as ((ev: Event) => unknown) | null,
      onerror: null as ((ev: Event) => unknown) | null,
      onmessage: null as ((ev: MessageEvent) => unknown) | null,
      close: vi.fn(),
    }
    const send = (data: string) => source.onmessage?.(new MessageEvent('message', { data }))
    return { source, send }
  }

  it('reports its status, passes events on and closes', () => {
    const { source, send } = fakeSource()
    const events: FeedItem[] = []
    const statuses: FeedStatus[] = []
    const close = subscribeFeed(
      (e) => events.push(e),
      (s) => statuses.push(s),
      () => source,
    )
    source.onopen?.(new Event('open'))
    send(JSON.stringify({ id: 7, type: 'lock', message: 'locked', at: '2026-10-31T10:00:00Z' }))
    send('not json')
    send(JSON.stringify({ hello: 'world' }))
    source.onerror?.(new Event('error'))
    close()
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting'])
    expect(events.map((e) => e.id)).toEqual([7])
    expect(source.close).toHaveBeenCalled()
  })
})

describe('addFeedItem', () => {
  const item = (id: number): FeedItem => ({ id, type: 'group', message: `event ${id}`, at: '2026-10-31T10:00:00Z' })

  it('keeps each event once, in id order', () => {
    const items = [item(2), item(5)].reduce(addFeedItem, [item(1)])
    expect(addFeedItem(addFeedItem(items, item(2)), item(3)).map((i) => i.id)).toEqual([1, 2, 3, 5])
  })

  it('keeps only the newest 200', () => {
    let items: FeedItem[] = []
    for (let id = 1; id <= 250; id++) items = addFeedItem(items, item(id))
    expect(items).toHaveLength(200)
    expect(items[0].id).toBe(51)
  })
})

describe('what the page shows about its source', () => {
  it('explains a fallback to simulation and offers a retry', () => {
    const html = renderToStaticMarkup(
      <Dashboard data={sample} simulationReason="the server is unreachable" onRetry={() => {}} />,
    )
    expect(html).toContain('Reason: the server is unreachable')
    expect(html).toContain('Retry the server')
  })

  it('says when the live server has no groups or services yet', () => {
    const html = renderToStaticMarkup(
      <Dashboard data={{ services: [], groups: [], feed: [], simulation: false }} />,
    )
    expect(html).toContain('No purchase groups yet')
    expect(html).toContain('No services yet.')
    expect(html).not.toContain('Simulation.')
  })

  it('shows network, height and feed state for live data', () => {
    const html = renderToStaticMarkup(
      <SourceBar source={{ kind: 'live', health: { ok: true, network: 'mainnet', height: 973333 }, feed: 'open' }} />,
    )
    expect(html).toContain('Live')
    expect(html).toContain('mainnet · block 973,333')
    expect(html).toContain('Feed connected')
  })
})
