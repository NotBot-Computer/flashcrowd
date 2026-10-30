// npm run wallet -w @agentswap/agent -- <command> <key file> [outpoints…]
//   address  the agent's identity key and the deposit address to send test coins to
//   sweep    takes mined deposits (<txid>.<vout>) into the wallet, printing a WhatsOnChain link for each
//   balance  the wallet's spendable sats
//   refund   refunds every share a run left locked, once the chain is above its refund height (from the ledger)
// The network comes from BSV_NETWORK (testnet unless "mainnet"). The key itself is never printed.
import { parseNetwork, wocTxUrl } from '@agentswap/core'
import { depositAddress, sweepDeposits } from './funding'
import { httpCoordinator } from './httpCoordinator'
import { ledgerFileFor } from './ledger'
import { recoverRefunds } from './recover'
import { openAgentWallet, readKeyFile } from './wallet'

const [command, keyFile, ...rest] = process.argv.slice(2)
const network = parseNetwork(process.env.BSV_NETWORK)
const usage =
  'usage: npm run wallet -w @agentswap/agent -- address|sweep|balance|refund <key file> [<txid>.<vout> …]'

if (keyFile === undefined || !['address', 'sweep', 'balance', 'refund'].includes(command)) {
  console.error(usage)
  process.exit(1)
}

const rootKey = readKeyFile(keyFile)
if (command === 'address') {
  const address = depositAddress(rootKey, network)
  const host = network === 'mainnet' ? 'whatsonchain.com' : 'test.whatsonchain.com'
  console.log(`network: ${network}`)
  console.log(`identity key: ${rootKey.toPublicKey().toString()}`)
  console.log(`deposit address: ${address}`)
  console.log(`https://${host}/address/${address}`)
  process.exit(0)
}

const agent = await openAgentWallet({ keyFile, network })
try {
  if (command === 'sweep') {
    if (rest.length === 0) throw new Error(usage)
    for (const r of await sweepDeposits(agent.wallet, rootKey, rest)) {
      console.log(
        r.success ? `${r.outpoint}: swept ${wocTxUrl(r.txid!, network)}` : `${r.outpoint}: ${r.error}`,
      )
    }
  }
  if (command === 'refund') {
    const server = process.env.SERVER_URL
    const coordinator = server === undefined ? undefined : httpCoordinator(server, agent.wallet)
    const results = await recoverRefunds(
      { wallet: agent.wallet, network },
      ledgerFileFor(keyFile, network),
      coordinator && (async (groupId, txid) => await coordinator.reportRefund(groupId, txid)),
    )
    if (results.length === 0) console.log('nothing locked: every funded share is settled')
    for (const r of results) console.log(`${r.groupId} ${r.fundingTxid}: ${r.status} · ${r.message}`)
  }
  console.log(`balance: ${await agent.wallet.balance()} sats (${network})`)
} finally {
  await agent.close()
}
