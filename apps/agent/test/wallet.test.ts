// The agent's wallet from a key file: one database per network, so testnet and mainnet never share one.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { afterAll, describe, expect, it } from 'vitest'
import { openAgentWallet, readKeyFile, walletFileFor } from '../src/wallet'

const dir = mkdtempSync(join(tmpdir(), 'flashcrowd-wallet-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('openAgentWallet', () => {
  it('keeps a separate database per network for the same key', async () => {
    const key = PrivateKey.fromRandom()
    const keyFile = join(dir, 'agent-1.key')
    writeFileSync(keyFile, key.toHex())
    expect(walletFileFor(keyFile, 'mainnet')).toBe(join(dir, 'agent-1.mainnet.sqlite'))

    for (const network of ['testnet', 'mainnet'] as const) {
      const w = await openAgentWallet({ keyFile, network })
      expect(w.identityKey).toBe(key.toPublicKey().toString())
      expect(await w.wallet.balance()).toBe(0)
      await w.close()
    }
    expect(existsSync(walletFileFor(keyFile, 'testnet'))).toBe(true)
    expect(existsSync(walletFileFor(keyFile, 'mainnet'))).toBe(true)
  })

  it('refuses a key file that is not a 32-byte hex key', () => {
    const bad = join(dir, 'bad.key')
    writeFileSync(bad, 'not a key')
    expect(() => readKeyFile(bad)).toThrow(/32-byte hex key/)
  })
})
