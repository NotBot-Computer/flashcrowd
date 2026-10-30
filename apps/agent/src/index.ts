// npm run dev:agent -- --agents 3 [--check]
// Settings come from the root .env (src/config.ts). --check reports each agent's wallet and stops. Without it, every
// agent that can cover its offer buys from the coordinator at SERVER_URL at the same time, and each one's result is
// printed with WhatsOnChain links.
import { readSettings } from './config'
import { httpCoordinator } from './httpCoordinator'
import { ledgerFileFor } from './ledger'
import { checkAgents, runAgents, summarize } from './runner'
import { openAgentWallet, type AgentWallet } from './wallet'

let settings
try {
  settings = readSettings(process.env, process.argv.slice(2))
} catch (e) {
  console.error(`settings: ${(e as Error).message} (see .env.example)`)
  process.exit(1)
}

console.log(`FlashCrowd agents · ${settings.network} · server ${settings.serverUrl}`)
console.log(
  `policy: ≤ ${settings.policy.maxPerPurchaseSats} sats per purchase, ≤ ${settings.policy.maxTotalSats} in total, ` +
    `≤ ${settings.policy.maxLockBlocks} blocks locked, services ${settings.policy.allowedServiceIds.join(', ')}`,
)

const network = settings.network
const report = await checkAgents(
  settings.agents,
  network,
  async (agent) => await openAgentWallet({ keyFile: agent.keyFile, network }),
)
for (const r of report) {
  console.log(
    `${r.name}: ${r.ready ? 'ready' : 'needs funds'} · balance ${r.balance} / ${r.needed} sats · ` +
      `identity ${r.identityKey} · deposit ${r.depositAddress}`,
  )
}

if (settings.check) process.exit(0)
const notReady = report.filter((r) => !r.ready).map((r) => r.name)
if (notReady.length > 0) {
  console.error(`not enough funds: ${notReady.join(', ')}. Fund them first (npm run wallet -- address/sweep)`)
  process.exit(1)
}

const open: AgentWallet[] = []
try {
  for (const agent of settings.agents)
    open.push(await openAgentWallet({ keyFile: agent.keyFile, network, monitor: true }))
  const outcomes = await runAgents(
    settings.agents.map((agent, i) => ({
      ctx: { wallet: open[i].wallet, network },
      coordinator: httpCoordinator(settings.serverUrl, open[i].wallet),
      spentSats: 0,
      ledgerFile: ledgerFileFor(agent.keyFile, network),
      config: {
        name: agent.name,
        policy: settings.policy,
        serviceId: settings.serviceId,
        resourceId: settings.resourceId,
        maxContributionSats: agent.maxContributionSats,
        intentTtlMs: settings.intentTtlMs,
        pollMs: settings.pollMs,
        matchTimeoutMs: settings.matchTimeoutMs,
      },
    })),
  )
  console.log('')
  outcomes.forEach((o, i) => console.log(summarize(settings.agents[i].name, o, network)))
} finally {
  for (const w of open) await w.close()
}
