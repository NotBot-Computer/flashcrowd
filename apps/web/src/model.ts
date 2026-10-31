import {
  MIN_CONTRIBUTION_SATS,
  type FeedEvent,
  type GroupParticipant,
  type GroupStatus,
  type PurchaseGroup,
} from '@agentswap/core'

// What the dashboard reads from apps/server, and the small pure helpers that turn it into what the page shows.

/** One transaction of a group, as GET /api/groups/:id lists it (apps/server/src/coordinator.ts). */
export interface GroupTransaction {
  kind: 'funding' | 'claim' | 'refund'
  txid: string
  wocUrl: string
  identityKey?: string
}

/** GET /api/groups/:id: the group plus a link for every transaction known to be sent. */
export type GroupView = PurchaseGroup & { transactions: GroupTransaction[] }

/** One event of GET /api/feed (apps/server/src/feed.ts). */
export type FeedItem = FeedEvent & { id: number; wocUrl?: string }

export type Tone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger'

const STATUS: Record<GroupStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'neutral' },
  matched: { label: 'Matched', tone: 'progress' },
  committed: { label: 'Committed', tone: 'progress' },
  funding: { label: 'Funding', tone: 'progress' },
  locked: { label: 'Locked', tone: 'progress' },
  claimed: { label: 'Claimed', tone: 'success' },
  expired: { label: 'Expired', tone: 'neutral' },
  funding_failed: { label: 'Funding failed', tone: 'danger' },
  refund_available: { label: 'Refund available', tone: 'warning' },
  refunded: { label: 'Refunded', tone: 'neutral' },
  settlement_failed: { label: 'Settlement failed', tone: 'danger' },
}

export const groupStatus = (status: GroupStatus) => STATUS[status]

const PARTICIPANT: Record<GroupParticipant['status'], string> = {
  joined: 'Joined',
  authorized: 'Accepted terms',
  funded: 'Funded',
  refunded: 'Refunded',
}

export const participantStatus = (status: GroupParticipant['status']) => PARTICIPANT[status]

/** Sats locked so far: the shares of participants whose funding is in (funded, or funded and since refunded). */
export function fundedSats(group: PurchaseGroup): number {
  return group.participants
    .filter((p) => p.status === 'funded' || p.status === 'refunded')
    .reduce((sum, p) => sum + p.shareSats, 0)
}

/** Funding progress from 0 to 1. */
export function fundingProgress(group: PurchaseGroup): number {
  return group.priceSats > 0 ? Math.min(1, fundedSats(group) / group.priceSats) : 0
}

/** The most buyers a service can split into, since every share must be at least MIN_CONTRIBUTION_SATS. */
export const maxBuyers = (priceSats: number) => Math.floor(priceSats / MIN_CONTRIBUTION_SATS)

export const formatSats = (sats: number) => `${sats.toLocaleString('en')} sats`

/** 02ab12cd…ef34: enough to tell keys apart. */
export const shortKey = (key: string) => (key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key)

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export interface DashboardStats {
  /** Sats every group's buyers have locked so far, claimed and refunded groups included. */
  fundedSats: number
  groups: number
  claimed: number
  refunded: number
  /** Distinct agents that joined any group. */
  agents: number
}

export function dashboardStats(groups: PurchaseGroup[]): DashboardStats {
  return {
    fundedSats: groups.reduce((sum, g) => sum + fundedSats(g), 0),
    groups: groups.length,
    claimed: groups.filter((g) => g.status === 'claimed').length,
    refunded: groups.filter((g) => g.status === 'refunded').length,
    agents: new Set(groups.flatMap((g) => g.participants.map((p) => p.identityKey))).size,
  }
}

/** The feed's events about one group: the server names the group's id in their message. */
export const groupEvents = (feed: FeedItem[], groupId: string) =>
  feed.filter((e) => e.message.includes(groupId))

/** "just now", "4 min ago", "2 h ago": how the feed dates its events. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** The server's ids are `group-<uuid>`: the first block is enough to tell groups apart. */
export const shortGroupId = (id: string) => /^(group-[0-9a-f]{8})-[0-9a-f-]+$/.exec(id)?.[1].concat('…') ?? id

/** The simulation chip already says so; drop a "(simulation)" the seller put in the title. */
export const serviceTitle = (title: string, simulation: boolean) =>
  simulation ? title.replace(/\s*\(simulation\)\s*$/i, '') : title
