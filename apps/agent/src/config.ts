// The agents' settings from the environment (root .env) and the command line. Every amount must be a whole number
// of sats; anything else stops the run before a wallet is opened.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseNetwork, type Network, type SpendPolicy } from '@agentswap/core'

export interface AgentSettings {
  name: string
  keyFile: string
  maxContributionSats: number
}

export interface RunSettings {
  network: Network
  serverUrl: string
  serviceId: string
  resourceId: string
  policy: SpendPolicy
  agents: AgentSettings[]
  /** --check: report each agent's wallet and stop. */
  check: boolean
  intentTtlMs: number
  pollMs: number
  matchTimeoutMs: number
}

const sats = (name: string, value: string | undefined, fallback?: number): number => {
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`${name} is not set`)
  }
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a whole number of sats, not "${value}"`)
  const n = Number(value.trim())
  if (!Number.isSafeInteger(n)) throw new Error(`${name} is too large`)
  return n
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

/**
 * Reads the settings. Key files: AGENT_KEY_FILES (comma-separated), or `--agents N` with AGENT_KEY_DIR (default
 * ~/.agentswap) holding agent-1.key … agent-N.key. AGENT_MAX_CONTRIBUTIONS gives one offer per agent, or one for all.
 */
export function readSettings(env: Record<string, string | undefined>, argv: string[]): RunSettings {
  let count: number | undefined
  let check = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true
    else if (argv[i] === '--agents') count = sats('--agents', argv[++i])
    else throw new Error(`unknown argument ${argv[i]}`)
  }

  let keyFiles = list(env.AGENT_KEY_FILES).map((f) => resolve(f.replace(/^~(?=\/)/, homedir())))
  if (keyFiles.length === 0) {
    const dir = resolve((env.AGENT_KEY_DIR ?? '~/.agentswap').replace(/^~(?=\/|$)/, homedir()))
    keyFiles = Array.from({ length: count ?? 1 }, (_, i) => join(dir, `agent-${i + 1}.key`))
  } else if (count !== undefined && count !== keyFiles.length) {
    throw new Error(`--agents ${count} but AGENT_KEY_FILES names ${keyFiles.length} files`)
  }
  if (keyFiles.length === 0 || keyFiles.length > 10) throw new Error('run between 1 and 10 agents')
  if (new Set(keyFiles).size !== keyFiles.length) throw new Error('two agents share a key file')

  const offers = list(env.AGENT_MAX_CONTRIBUTIONS).map((v) => sats('AGENT_MAX_CONTRIBUTIONS', v))
  if (offers.length === 0) throw new Error('AGENT_MAX_CONTRIBUTIONS is not set')
  if (offers.length !== 1 && offers.length !== keyFiles.length) {
    throw new Error(`AGENT_MAX_CONTRIBUTIONS has ${offers.length} values for ${keyFiles.length} agents`)
  }

  const serviceId = env.AGENT_SERVICE_ID ?? 'bsv-usd-closes'
  const allowed = list(env.AGENT_ALLOWED_SERVICES)
  return {
    network: parseNetwork(env.BSV_NETWORK),
    serverUrl: env.SERVER_URL ?? 'http://localhost:8787',
    serviceId,
    resourceId: env.AGENT_RESOURCE_ID ?? 'bsvusd-2026-10',
    policy: {
      maxPerPurchaseSats: sats('AGENT_MAX_PER_PURCHASE_SATS', env.AGENT_MAX_PER_PURCHASE_SATS),
      maxTotalSats: sats('AGENT_MAX_TOTAL_SATS', env.AGENT_MAX_TOTAL_SATS),
      allowedServiceIds: allowed.length > 0 ? allowed : [serviceId],
      requireMatchingResource: true,
      maxLockBlocks: sats('AGENT_MAX_LOCK_BLOCKS', env.AGENT_MAX_LOCK_BLOCKS, 30),
    },
    agents: keyFiles.map((keyFile, i) => ({
      name: `agent-${i + 1}`,
      keyFile,
      maxContributionSats: offers.length === 1 ? offers[0] : offers[i],
    })),
    check,
    intentTtlMs: 30 * 60_000,
    pollMs: sats('AGENT_POLL_MS', env.AGENT_POLL_MS, 3_000),
    matchTimeoutMs: 15 * 60_000,
  }
}
