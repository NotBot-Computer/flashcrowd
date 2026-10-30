// The coordinator over HTTP: apps/server's API. Reads are open and use plain fetch; every POST is a BRC-103 request
// signed by the agent's wallet (AuthFetch), so the server knows the caller without the agent sending its key.
import { AuthFetch, type WalletInterface } from '@bsv/sdk'
import { CoordinatorError, type Coordinator } from './coordinator'

const TIMEOUT_MS = 30_000

export function httpCoordinator(
  serverUrl: string,
  wallet: WalletInterface,
  originator?: string,
): Coordinator {
  const auth = new AuthFetch(wallet, undefined, undefined, originator)
  const url = (path: string): string => new URL(path, serverUrl).toString()

  const reply = async <T>(res: Response): Promise<T> => {
    const text = await res.text()
    let body: unknown
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      body = undefined
    }
    if (!res.ok) {
      const error = (body as { error?: unknown } | undefined)?.error
      throw new CoordinatorError(res.status, typeof error === 'string' ? error : `HTTP ${res.status}`)
    }
    return body as T
  }
  const get = async <T>(path: string): Promise<T> =>
    await reply<T>(await fetch(url(path), { signal: AbortSignal.timeout(TIMEOUT_MS) }))
  const post = async <T>(path: string, body: unknown): Promise<T> =>
    await reply<T>(
      await auth.fetch(url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  const id = encodeURIComponent

  return {
    services: async () => await get('/api/services'),
    createIntent: async (intent) => await post('/api/intents', intent),
    groupsForIntent: async (intentId) => await get(`/api/groups?intentId=${id(intentId)}`),
    group: async (groupId) => await get(`/api/groups/${id(groupId)}`),
    authorize: async (groupId) => await post(`/api/groups/${id(groupId)}/authorize`, {}),
    submitContribution: async (groupId, contribution) =>
      await post(`/api/groups/${id(groupId)}/contributions`, contribution),
    submitFunding: async (groupId, contribution) =>
      await post(`/api/groups/${id(groupId)}/funding`, contribution),
    settlement: async (groupId) => await get(`/api/groups/${id(groupId)}/settlement`),
    reportRefund: async (groupId, txid) => await post(`/api/groups/${id(groupId)}/refunds`, { txid }),
    report: async (event) => {
      await post('/api/events', event)
    },
  }
}
