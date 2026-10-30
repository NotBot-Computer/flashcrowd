// npm run wallet:init -w @agentswap/server
// Creates the two key files the server needs, outside the repo, and prints only their public identity keys.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrivateKey } from '@bsv/sdk'
import { readKeyFile } from './wallet'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function ensureKey(file: string): string {
  const path = resolve(file)
  const fromRepo = relative(repoRoot, path)
  if (!fromRepo.startsWith('..')) throw new Error(`refusing to put a key inside the repo: ${path}`)
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${PrivateKey.fromRandom().toHex()}\n`, { mode: 0o600, flag: 'wx' })
    console.log(`created ${path}`)
  } else {
    console.log(`kept the existing ${path}`)
  }
  return readKeyFile(path).toPublicKey().toString()
}

const dir = join(homedir(), '.agentswap')
const serverFile = resolve(process.env.SERVER_KEY_FILE || join(dir, 'server.key'))
const sellerFile = resolve(process.env.SELLER_KEY_FILE || join(dir, 'seller.key'))

const serverIdentity = ensureKey(serverFile)
const sellerIdentity = ensureKey(sellerFile)

console.log(`\ncoordinator identity (auth only, holds no money): ${serverIdentity}`)
console.log(`mock seller identity (receives the claims):       ${sellerIdentity}`)
console.log(`\nPut these in the root .env:\nSERVER_KEY_FILE=${serverFile}\nSELLER_KEY_FILE=${sellerFile}`)
