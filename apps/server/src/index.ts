import cors from 'cors'
import express from 'express'
import { parseNetwork } from '@agentswap/core'

// Scaffold only: P2 builds the order book, the paid 402 service and the feed during the event
// (apps/server/README.md, issue #3). This server never holds user keys or funds.

const network = parseNetwork(process.env.BSV_NETWORK)
const port = Number(process.env.SERVER_PORT ?? 8787)

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'agentswap-server', network })
})

app.listen(port, () => {
  console.log(`agentswap server on http://localhost:${port} (${network})`)
})
