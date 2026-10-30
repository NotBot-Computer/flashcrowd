// The live feed behind GET /api/feed. Keeps the last events so a dashboard that connects late still sees them.
import { wocTxUrl, type FeedEvent, type Network } from '@agentswap/core'

/** A FeedEvent plus what the feed adds: an id for Last-Event-ID, and a WhatsOnChain link when there is a txid. */
export type PublishedEvent = FeedEvent & { id: number; wocUrl?: string }

const HISTORY = 200

export class Feed {
  private readonly history: PublishedEvent[] = []
  private readonly listeners = new Set<(event: PublishedEvent) => void>()
  private nextId = 1

  constructor(private readonly network: Network) {}

  publish(event: Pick<FeedEvent, 'type' | 'message' | 'txid'>): PublishedEvent {
    const published: PublishedEvent = {
      ...event,
      id: this.nextId++,
      at: new Date().toISOString(),
      ...(event.txid !== undefined && { wocUrl: wocTxUrl(event.txid, this.network) }),
    }
    this.history.push(published)
    if (this.history.length > HISTORY) this.history.shift()
    for (const listener of this.listeners) listener(published)
    return published
  }

  /** Events after `afterId`, oldest first. */
  since(afterId = 0): PublishedEvent[] {
    return this.history.filter((e) => e.id > afterId)
  }

  subscribe(listener: (event: PublishedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
