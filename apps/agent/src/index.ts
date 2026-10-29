import { parseNetwork } from '@agentswap/core'

// Scaffold only: P4 builds the agent during the event (apps/agent/README.md, issue #5).

const network = parseNetwork(process.env.BSV_NETWORK)
const serverUrl = process.env.SERVER_URL ?? 'http://localhost:8787'
const unset = ['AGENT_KEY_FILE', 'ANTHROPIC_API_KEY'].filter((name) => !process.env[name])

console.log(`agentswap agent scaffold · ${network} · server ${serverUrl}`)
if (unset.length > 0) console.log(`not set in .env yet: ${unset.join(', ')}`)
