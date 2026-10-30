// An agent's own BRC-100 wallet: wallet-toolbox with the agent's root key from a key file outside the repo, SQLite
// storage next to it, and Arcade as the broadcaster. Built like wallet-toolbox's Setup.createWallet, which has no
// Arcade option. The key never leaves this process and is never logged.
import { readFileSync } from 'node:fs'
import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import {
  Monitor,
  randomBytesHex,
  Services,
  Setup,
  StorageKnex,
  Wallet,
  WalletStorageManager,
} from '@bsv/wallet-toolbox'
import { ARCADE_URL, type Network } from '@agentswap/core'

export interface AgentWallet {
  wallet: Wallet
  identityKey: string
  close: () => Promise<void>
}

/** Reads a key file: 64 hex characters, the agent's root private key. */
export function readKeyFile(keyFile: string): PrivateKey {
  const hex = readFileSync(keyFile, 'utf8').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${keyFile} does not hold a 32-byte hex key`)
  return PrivateKey.fromHex(hex)
}

/** Opens the agent's wallet; `dbFile` defaults to the key file's path with `.sqlite`. */
export async function openAgentWallet(args: {
  keyFile: string
  network: Network
  dbFile?: string
}): Promise<AgentWallet> {
  const rootKey = readKeyFile(args.keyFile)
  const chain = args.network === 'mainnet' ? 'main' : 'test'
  const identityKey = rootKey.toPublicKey().toString()
  const knex = Setup.createSQLiteKnex(args.dbFile ?? args.keyFile.replace(/\.key$/, '') + '.sqlite')
  const active = new StorageKnex({
    chain,
    knex,
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: 100 },
  })
  await active.migrate('flashcrowd-agent', randomBytesHex(33))
  await active.makeAvailable()
  const storage = new WalletStorageManager(identityKey, active)
  await storage.makeAvailable()
  const options = Services.createDefaultOptions(chain)
  options.arcadeUrl = ARCADE_URL[args.network]
  const services = new Services(options)
  const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions(chain, storage, services))
  const wallet = new Wallet({ chain, keyDeriver: new CachedKeyDeriver(rootKey), storage, services, monitor })
  return {
    wallet,
    identityKey,
    close: async () => {
      await wallet.destroy()
      await knex.destroy()
    },
  }
}
