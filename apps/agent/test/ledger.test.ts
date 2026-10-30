import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ledgerFileFor, readLedger, recordInLedger, spentSats } from '../src/ledger'

const dir = mkdtempSync(join(tmpdir(), 'flashcrowd-ledger-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('ledger', () => {
  it('lives next to the key file, one per network', () => {
    expect(ledgerFileFor('/keys/agent-1.key', 'mainnet')).toBe('/keys/agent-1.mainnet.spent.json')
    expect(ledgerFileFor('/keys/agent-1.key', 'testnet')).toBe('/keys/agent-1.testnet.spent.json')
  })

  it('counts funded and decrypted shares, not refunded ones', () => {
    const file = join(dir, 'a.spent.json')
    expect(readLedger(file)).toEqual([])
    recordInLedger(file, { groupId: 'g1', fundingTxid: 'f1', shareSats: 3_000, status: 'funded' })
    recordInLedger(file, { groupId: 'g2', fundingTxid: 'f2', shareSats: 4_000, status: 'funded' })
    expect(spentSats(readLedger(file))).toBe(7_000)
    recordInLedger(file, { fundingTxid: 'f1', status: 'decrypted', settledTxid: 'c1' })
    recordInLedger(file, { fundingTxid: 'f2', status: 'refunded', settledTxid: 'r2' })
    const entries = readLedger(file)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      groupId: 'g1',
      shareSats: 3_000,
      status: 'decrypted',
      settledTxid: 'c1',
    })
    expect(spentSats(entries)).toBe(3_000)
  })

  it('refuses a file that is not a ledger', () => {
    const file = join(dir, 'bad.spent.json')
    writeFileSync(file, JSON.stringify([{ shareSats: '3000' }]))
    expect(() => readLedger(file)).toThrow(/not an agent ledger/)
  })
})
