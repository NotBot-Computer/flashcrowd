import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseNetwork } from '@agentswap/core'
import { ProtoWallet, type WalletInterface } from '@bsv/sdk'
import { createApp } from './app'
import { arcadeChain } from './chain'
import { Coordinator } from './coordinator'
import { Feed } from './feed'
import { MockSeller } from './seller'
import { Store } from './store'
import { createServerWallet, readKeyFile } from './wallet'

// The FlashCrowd coordinator and the mock seller. It never holds a buyer's key or money.

const TICK_MS = 30_000

const network = parseNetwork(process.env.BSV_NETWORK)
const port = Number(process.env.SERVER_PORT ?? 8787)
const dataDir = process.env.SERVER_DATA_DIR || join(homedir(), '.agentswap', 'server-data')
const lockBlocks = Number(process.env.SELLER_LOCK_BLOCKS ?? 6)
const noClaim = process.env.SELLER_NO_CLAIM === 'true'

const missing = ['SERVER_KEY_FILE', 'SELLER_KEY_FILE'].filter((name) => !process.env[name])
if (missing.length > 0) {
  console.error(`not set in .env: ${missing.join(', ')}; run: npm run wallet:init -w @agentswap/server`)
  process.exit(1)
}

const sellerWallet = await createServerWallet(
  network,
  readKeyFile(process.env.SELLER_KEY_FILE!),
  join(dataDir, `seller-${network}.sqlite`),
)
const seller = await MockSeller.create(
  { wallet: sellerWallet.wallet, network },
  { lockBlocks, noClaim, secretsFile: join(dataDir, `seller-secrets-${network}.json`) },
)
const feed = new Feed(network)
const coordinator = new Coordinator(
  network,
  new Store(join(dataDir, `state-${network}.json`)),
  feed,
  seller,
  arcadeChain(network, (txid) => sellerWallet.services.getRawTx(txid)),
)
const app = createApp({
  network,
  coordinator,
  feed,
  // BRC-103 only signs and verifies messages, which is all ProtoWallet does; it has no coins to spend.
  authWallet: new ProtoWallet(readKeyFile(process.env.SERVER_KEY_FILE!)) as unknown as WalletInterface,
})

const server = app.listen(port, () => {
  console.log(`agentswap server on http://localhost:${port} (${network})`)
  console.log(
    `seller ${seller.services()[0].sellerIdentityKey}${noClaim ? ' · SELLER_NO_CLAIM: never claims' : ''}`,
  )
  coordinator.start(TICK_MS)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    coordinator.stop()
    server.close()
    server.closeAllConnections()
    void sellerWallet.destroy().finally(() => process.exit(0))
  })
}
