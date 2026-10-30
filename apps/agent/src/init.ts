// npm run wallet:init -w @agentswap/agent -- <key file outside the repo>
// Writes a fresh root key (mode 600), never over an existing file, and prints the agent's identity key. The key
// itself is never printed.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrivateKey } from '@bsv/sdk'

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: npm run wallet:init -w @agentswap/agent -- ~/.agentswap/agent-1.key')
  process.exit(1)
}
const file = resolve(target)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
if (!relative(repo, file).startsWith('..')) {
  console.error(`refusing to write a key inside the repo (${repo}); use a path like ~/.agentswap/agent-1.key`)
  process.exit(1)
}
if (existsSync(file)) {
  console.error(`${file} exists; not overwriting a key`)
  process.exit(1)
}
const key = PrivateKey.fromRandom()
mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
writeFileSync(file, key.toHex(), { mode: 0o600, flag: 'wx' })
console.log(`key file: ${file}`)
console.log(`identity key: ${key.toPublicKey().toString()}`)
