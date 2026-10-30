// The coordinator's state: in memory, and written to one JSON file on every change when a file is given. A write
// goes to a temporary file first, so a crash cannot leave half a state behind.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IntentStatus, PurchaseGroup, PurchaseIntent } from '@agentswap/core'

/** Owner-only: the seller's secrets go through here too. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** undefined if the file does not exist; a corrupt file throws, so a restart never overwrites it with an empty state. */
export function readJson<T>(file: string): T | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${file} is not valid JSON; fix or move it before starting the server`)
  }
}

interface StateFile {
  intents: PurchaseIntent[]
  groups: PurchaseGroup[]
  claimTxs: [string, string][]
}

export class Store {
  private readonly intents = new Map<string, PurchaseIntent>()
  private readonly groups = new Map<string, PurchaseGroup>()
  /** Group id → hex AtomicBEEF of its claim, for the buyers' secretFromClaim. */
  private readonly claimTxs = new Map<string, string>()

  constructor(private readonly file?: string) {
    if (file === undefined) return
    const state = readJson<StateFile>(file)
    for (const intent of state?.intents ?? []) this.intents.set(intent.id, intent)
    for (const group of state?.groups ?? []) this.groups.set(group.id, group)
    for (const [id, tx] of state?.claimTxs ?? []) this.claimTxs.set(id, tx)
  }

  private save(): void {
    if (this.file === undefined) return
    const state: StateFile = {
      intents: [...this.intents.values()],
      groups: [...this.groups.values()],
      claimTxs: [...this.claimTxs],
    }
    writeJsonAtomic(this.file, state)
  }

  intent(id: string): PurchaseIntent | undefined {
    return this.intents.get(id)
  }

  allIntents(): PurchaseIntent[] {
    return [...this.intents.values()]
  }

  putIntent(intent: PurchaseIntent): void {
    this.intents.set(intent.id, intent)
    this.save()
  }

  setIntentStatus(ids: string[], status: IntentStatus): void {
    for (const id of ids) {
      const intent = this.intents.get(id)
      if (intent !== undefined) this.intents.set(id, { ...intent, status })
    }
    this.save()
  }

  group(id: string): PurchaseGroup | undefined {
    return this.groups.get(id)
  }

  allGroups(): PurchaseGroup[] {
    return [...this.groups.values()]
  }

  /** Keeps the new object advanceGroup returned; the function never changes the old one. */
  putGroup(group: PurchaseGroup): void {
    this.groups.set(group.id, group)
    this.save()
  }

  claimTx(groupId: string): string | undefined {
    return this.claimTxs.get(groupId)
  }

  putClaim(group: PurchaseGroup, claimTx: string): void {
    this.groups.set(group.id, group)
    this.claimTxs.set(group.id, claimTx)
    this.save()
  }
}
