// Server-side wallets from a key file outside the repo. Built by hand rather than with Setup.createWalletSQLite,
// which ignores options.arcadeUrl and would broadcast through its default providers (AGENTS.md: Arcade first).
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { ARCADE_URL, type Network } from '@agentswap/core'
import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import {
  randomBytesHex,
  Services,
  Setup,
  StorageKnex,
  Wallet,
  WalletStorageManager,
} from '@bsv/wallet-toolbox'

const KEY = /^[0-9a-f]{64}$/

/** Reads a hex root key. The error messages name the file, never its contents. */
export function readKeyFile(file: string): PrivateKey {
  if (!existsSync(file))
    throw new Error(`no key file at ${file}; run: npm run wallet:init -w @agentswap/server`)
  if ((statSync(file).mode & 0o077) !== 0) {
    console.warn(`warning: ${file} is readable by other users; run: chmod 600 ${file}`)
  }
  const hex = readFileSync(file, 'utf8').trim().toLowerCase()
  if (!KEY.test(hex)) throw new Error(`${file} does not hold a 64-character hex key`)
  return PrivateKey.fromHex(hex)
}

export interface ServerWallet {
  wallet: Wallet
  services: Services
  destroy(): Promise<void>
}

export async function createServerWallet(
  network: Network,
  rootKey: PrivateKey,
  databaseFile: string,
): Promise<ServerWallet> {
  const chain = network === 'mainnet' ? 'main' : 'test'
  const options = Services.createDefaultOptions(chain)
  options.arcadeUrl = ARCADE_URL[network]
  const services = new Services(options)
  mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 })
  const knex = Setup.createSQLiteKnex(databaseFile)
  const provider = new StorageKnex({
    chain,
    knex,
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: 100 },
  })
  await provider.migrate('flashcrowd-seller', randomBytesHex(33))
  await provider.makeAvailable()
  const storage = new WalletStorageManager(rootKey.toPublicKey().toString(), provider)
  await storage.makeAvailable()
  storage.setServices(services)
  const wallet = new Wallet({ chain, keyDeriver: new CachedKeyDeriver(rootKey), storage, services })
  return {
    wallet,
    services,
    async destroy() {
      await wallet.destroy()
      await knex.destroy()
    },
  }
}
