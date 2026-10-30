// What an agent has committed, kept next to its key file (agent-1.spent.json), so maxTotalSats holds across runs and
// not only within one. A share counts from the moment its funding is broadcast; a refunded share stops counting.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface LedgerEntry {
  groupId: string
  fundingTxid: string
  shareSats: number
  status: 'funded' | 'decrypted' | 'refunded'
  /** The claim or the refund. */
  settledTxid?: string
  /** ISO 8601 */
  at: string
}

export const ledgerFileFor = (keyFile: string): string => keyFile.replace(/\.key$/, '') + '.spent.json'

export function readLedger(file: string): LedgerEntry[] {
  if (!existsSync(file)) return []
  const entries = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (
    !Array.isArray(entries) ||
    !entries.every((e) => typeof e?.fundingTxid === 'string' && Number.isSafeInteger(e?.shareSats))
  ) {
    throw new Error(`${file} is not an agent ledger; fix or remove it`)
  }
  return entries as LedgerEntry[]
}

/** The sats still counting against maxTotalSats. */
export const spentSats = (entries: LedgerEntry[]): number =>
  entries.filter((e) => e.status !== 'refunded').reduce((sum, e) => sum + e.shareSats, 0)

/** Adds or updates the entry for `fundingTxid`; written to a temporary file first, so a crash leaves the old ledger. */
export function recordInLedger(
  file: string,
  entry: Omit<LedgerEntry, 'at'> | (Partial<LedgerEntry> & { fundingTxid: string }),
): void {
  const entries = readLedger(file)
  const i = entries.findIndex((e) => e.fundingTxid === entry.fundingTxid)
  const at = new Date().toISOString()
  if (i >= 0) entries[i] = { ...entries[i], ...entry, at }
  else entries.push({ ...(entry as Omit<LedgerEntry, 'at'>), at })
  writeFileSync(`${file}.tmp`, JSON.stringify(entries, null, 2))
  renameSync(`${file}.tmp`, file)
}
