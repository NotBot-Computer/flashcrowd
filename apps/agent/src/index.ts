// npm run dev:agent -- --agents 3 [--check]
// Settings come from the root .env (src/config.ts). --check reports each agent's wallet and stops; a purchase run
// needs the coordinator client for apps/server (P4 part 5), which comes once the server has the API.
import { readSettings } from './config'
import { checkAgents } from './runner'
import { openAgentWallet } from './wallet'

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

if (!settings.check) {
  console.error(
    'purchase runs need the apps/server coordinator client (P4 part 5); only --check works for now',
  )
  process.exit(1)
}
