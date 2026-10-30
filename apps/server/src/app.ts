// The HTTP layer. Reading is open, so the dashboard needs no wallet; everything that writes needs a signed BRC-103
// request, and the caller's identity is only ever req.auth.identityKey.
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'
import type { Network } from '@agentswap/core'
import type { WalletInterface } from '@bsv/sdk'
import { isClientError, HttpError, type Coordinator } from './coordinator'
import type { Feed, PublishedEvent } from './feed'

const IDENTITY = /^0[23][0-9a-f]{64}$/
const HEARTBEAT_MS = 25_000

export interface AppDeps {
  network: Network
  coordinator: Coordinator
  feed: Feed
  /** The coordinator's own identity for BRC-103. It only signs messages and holds no money. */
  authWallet: WalletInterface
}

/** The caller's verified identity. 'unknown' (an unsigned request) and anything else fails here. */
function identityOf(req: Request): string {
  const key = (req as AuthRequest).auth?.identityKey
  if (key === undefined || !IDENTITY.test(key))
    throw new HttpError(401, 'this route needs a BRC-103 signed request')
  return key
}

const param = (req: Request, name: string): string => String(req.params[name])

export function createApp({ network, coordinator, feed, authWallet }: AppDeps): express.Express {
  const app = express()
  app.use(cors())
  // Before the auth middleware: it signs over the parsed body. Funding BEEFs carry their ancestors.
  app.use(express.json({ limit: '4mb' }))
  app.use(createAuthMiddleware({ wallet: authWallet, allowUnauthenticated: true }))

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'agentswap-server', network, height: coordinator.height })
  })

  app.get('/api/services', (_req, res) => {
    res.json(coordinator.services())
  })
  app.get('/api/intents', (_req, res) => {
    res.json(coordinator.intents())
  })
  app.get('/api/groups', (req, res) => {
    const { intentId } = req.query
    res.json(coordinator.groups(typeof intentId === 'string' ? intentId : undefined))
  })
  app.get('/api/groups/:id', (req, res) => {
    res.json(coordinator.group(param(req, 'id')))
  })
  app.get('/api/groups/:id/settlement', (req, res) => {
    res.json(coordinator.settlement(param(req, 'id')))
  })

  app.get('/api/feed', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (event: PublishedEvent): void => {
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    const lastId = Number(req.get('Last-Event-ID') ?? 0)
    feed.since(Number.isSafeInteger(lastId) ? lastId : 0).forEach(send)
    const unsubscribe = feed.subscribe(send)
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  app.post('/api/intents', async (req, res) => {
    res.status(201).json(await coordinator.submitIntent(identityOf(req), req.body))
  })
  app.post('/api/groups/:id/authorize', async (req, res) => {
    res.json(await coordinator.authorize(identityOf(req), param(req, 'id')))
  })
  app.post('/api/groups/:id/contributions', async (req, res) => {
    res.json(await coordinator.submitContribution(identityOf(req), param(req, 'id'), req.body))
  })
  app.post('/api/groups/:id/funding', async (req, res) => {
    res.json(await coordinator.submitFunding(identityOf(req), param(req, 'id'), req.body))
  })
  app.post('/api/groups/:id/refunds', async (req, res) => {
    res.json(await coordinator.reportRefund(identityOf(req), param(req, 'id'), req.body))
  })
  app.post('/api/events', (req, res) => {
    res.status(201).json(coordinator.postEvent(identityOf(req), req.body))
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error)
      return
    }
    const parserStatus = (error as { status?: unknown }).status
    const status =
      isClientError(error) ??
      (typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500 ? parserStatus : 500)
    // Client errors explain themselves; anything else stays in the log.
    if (status === 500) console.error(error)
    res.status(status).json({ error: status === 500 ? 'internal error' : (error as Error).message })
  })
  return app
}
