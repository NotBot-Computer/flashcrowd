// npm run wallet -w @agentswap/agent -- <command> <key file> [outpoints…]
//   address  the agent's identity key and the deposit address to send test coins to
//   sweep    takes mined deposits (<txid>.<vout>) into the wallet, printing a WhatsOnChain link for each
//   balance  the wallet's spendable sats
// The network comes from BSV_NETWORK (testnet unless "mainnet"). The key itself is never printed.
import { parseNetwork, wocTxUrl } from '@agentswap/core'
import { depositAddress, sweepDeposits } from './funding'
import { openAgentWallet, readKeyFile } from './wallet'

const [command, keyFile, ...rest] = process.argv.slice(2)
const network = parseNetwork(process.env.BSV_NETWORK)
const usage =
  'usage: npm run wallet -w @agentswap/agent -- address|sweep|balance <key file> [<txid>.<vout> …]'

if (keyFile === undefined || !['address', 'sweep', 'balance'].includes(command)) {
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
  console.log(`balance: ${await agent.wallet.balance()} sats (${network})`)
} finally {
  await agent.close()
}
