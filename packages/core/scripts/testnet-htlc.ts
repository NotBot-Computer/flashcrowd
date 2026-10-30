// npm run testnet:htlc -w @agentswap/core -- init | sweep <txid>.<vout> | run | refund
//
// Checks the FlashCrowd HTLC on testnet (docs/FLASHCROWD_PLAN.md, P1 step 3) with three wallet-toolbox wallets whose
// key files live in ~/.agentswap/htlc, outside the repo:
//   a) two buyers fund group A and the seller, with an empty wallet, claims it;
//   b) buyer-1 funds group B and sends its refund to Arcade before refundHeight; then the seller claims B;
//   c) buyer-2 refunds group C after its refundHeight.
// The wallets are built by hand rather than with Setup.createWalletSQLite, which ignores options.arcadeUrl (guide
// §14.2). Testnet only. Keys are never printed; state.json holds terms, contributions and txids, no keys or secrets.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Beef,
  CachedKeyDeriver,
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PrivateKey,
  Signature,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type WalletProtocol,
} from '@bsv/sdk'
import {
  randomBytesHex,
  Services,
  Setup,
  StorageKnex,
  Wallet,
  WalletStorageManager,
} from '@bsv/wallet-toolbox'
import { ARCADE_URL, parseNetwork, wocTxUrl } from '../src/config'
import {
  abandonContribution,
  broadcastContribution,
  CLAIM_MARGIN_BLOCKS,
  claimContributions,
  encryptResource,
  HTLC_PROTOCOL,
  htlcKey,
  MIN_CONTRIBUTION_SATS,
  newSecret,
  prepareContribution,
  refundContribution,
  signRefund,
  signTerms,
  verifyFunding,
  verifyRefundSignature,
  type HtlcContext,
} from '../src/htlc'
import { ArcadeChainTracker } from '../src/kit/client/arcadeChainTracker'
import { acceptBrc29Payment, createBrc29Payment } from '../src/kit/client/payments'
import type { ClaimProof, FundingContribution, HtlcTerms, RefundProof } from '../src/types'

const NETWORK = 'testnet' as const
const ARCADE = ARCADE_URL[NETWORK]
const DIR = join(homedir(), '.agentswap', 'htlc')
const STATE_FILE = join(DIR, 'state.json')
const ROLES = ['seller', 'buyer-1', 'buyer-2'] as const
type Role = (typeof ROLES)[number]

const SHARE = MIN_CONTRIBUTION_SATS
/** What buyer-1 sends buyer-2 when it cannot fund C and A: two shares plus fees. */
const BUYER_2_FUNDING = 3 * SHARE
/** Kept back for fees on top of the shares when checking balances. */
const FEE_ROOM = 500
/** The wallets' fee rate. */
const SATS_PER_KB = 100
/** Ten times the wallets' rate (~240 sats), so Arcade cannot refuse the early refund for its fee. */
const EARLY_REFUND_SATS_PER_KB = 10 * SATS_PER_KB
const HEIGHT_POLL_MS = 60_000
const STATUS_DELAY_MS = 30_000

/** The agent's deposit key (apps/agent/src/funding.ts): [1, 'flashcrowd deposit'], keyID '1', counterparty 'self'. */
const DEPOSIT_PROTOCOL: WalletProtocol = [1, 'flashcrowd deposit']
const ALL = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
/** Like htlc.ts: below 0xffffffff, so nLockTime applies. */
const REFUND_SEQUENCE = 0xfffffffe
/** <signature> <public key> */
const P2PKH_UNLOCK_LENGTH = 108
/** <buyer signature> <seller signature> OP_0 */
const REFUND_UNLOCK_LENGTH = 74 + 74 + 1

// Key files and wallets

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const keyFile = (role: Role): string => join(DIR, `${role}.key`)

/** Reads a hex root key. The error messages name the file, never its contents. */
function readKeyFile(file: string): PrivateKey {
  if (!existsSync(file))
    throw new Error(`no key file at ${file}; run: npm run testnet:htlc -w @agentswap/core -- init`)
  if ((statSync(file).mode & 0o077) !== 0)
    console.warn(`warning: ${file} is readable by other users; chmod 600 it`)
  const hex = readFileSync(file, 'utf8').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${file} does not hold a 64-character hex key`)
  return PrivateKey.fromHex(hex)
}

const depositKey = (root: PrivateKey): PrivateKey =>
  new CachedKeyDeriver(root).derivePrivateKey(DEPOSIT_PROTOCOL, '1', 'self')

interface Party {
  role: Role
  wallet: Wallet
  ctx: HtlcContext
  identityKey: string
  depositAddress: string
  close(): Promise<void>
}

/** wallet-toolbox with SQLite next to the key file and Arcade first among the broadcasters (guide §14.2). */
async function openWallet(role: Role): Promise<Party> {
  const rootKey = readKeyFile(keyFile(role))
  const identityKey = rootKey.toPublicKey().toString()
  const options = Services.createDefaultOptions('test')
  options.arcadeUrl = ARCADE
  const services = new Services(options)
  const knex = Setup.createSQLiteKnex(join(DIR, `${role}.sqlite`))
  const provider = new StorageKnex({
    chain: 'test',
    knex,
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: SATS_PER_KB },
  })
  await provider.migrate(`flashcrowd-${role}`, randomBytesHex(33))
  await provider.makeAvailable()
  const storage = new WalletStorageManager(identityKey, provider)
  await storage.makeAvailable()
  storage.setServices(services)
  const wallet = new Wallet({ chain: 'test', keyDeriver: new CachedKeyDeriver(rootKey), storage, services })
  return {
    role,
    wallet,
    ctx: { wallet, network: NETWORK },
    identityKey,
    depositAddress: depositKey(rootKey).toAddress('testnet'),
    async close() {
      await wallet.destroy()
      await knex.destroy()
    },
  }
}

async function openAll(): Promise<Record<Role, Party>> {
  const [seller, buyer1, buyer2] = await Promise.all(ROLES.map(openWallet))
  return { seller, 'buyer-1': buyer1, 'buyer-2': buyer2 }
}

const heightOf = async (p: Party): Promise<number> => (await p.wallet.getHeight({})).height

// State

interface GroupRecord {
  terms: HtlcTerms
  contributions: FundingContribution[]
  /** Without K: the record holds no secrets. */
  claim?: Omit<ClaimProof, 'secret'> & { sellerSats: number }
  claimError?: string
  refunds: RefundProof[]
}

interface EarlyRefund {
  txid: string
  httpStatus: number
  txStatus?: string
  extraInfo?: string
  laterHttpStatus?: number
  laterTxStatus?: string
  verdict?: Verdict
}

type Verdict = 'rejected' | 'held, claim passed' | 'held, claim blocked' | 'inconclusive: refused for its fee'

interface RunRecord {
  startedAt: string
  startHeight: number
  sellerBalanceAtStart: number
  groups: Partial<Record<'A' | 'B' | 'C', GroupRecord>>
  earlyRefund?: EarlyRefund
}

interface ScriptState {
  network: typeof NETWORK
  runs: RunRecord[]
}

function loadState(): ScriptState {
  if (!existsSync(STATE_FILE)) return { network: NETWORK, runs: [] }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ScriptState
}

function saveState(state: ScriptState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  chmodSync(STATE_FILE, 0o600)
}

// Commands

async function cmdInit(): Promise<void> {
  if (!relative(repoRoot, DIR).startsWith('..'))
    throw new Error(`refusing to put keys inside the repo: ${DIR}`)
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  for (const role of ROLES) {
    const file = keyFile(role)
    if (existsSync(file)) {
      console.log(`kept the existing ${file}`)
    } else {
      writeFileSync(file, `${PrivateKey.fromRandom().toHex()}\n`, { mode: 0o600, flag: 'wx' })
      console.log(`created ${file}`)
    }
  }
  console.log('')
  for (const role of ROLES)
    console.log(`${role} identity key: ${readKeyFile(keyFile(role)).toPublicKey().toString()}`)
  const address = depositKey(readKeyFile(keyFile('buyer-1'))).toAddress('testnet')
  console.log(
    `\nbuyer-1 deposit address (send at least ${2 * SHARE + FEE_ROOM + BUYER_2_FUNDING} sats of test coins here):`,
  )
  console.log(`  ${address}\n  https://test.whatsonchain.com/address/${address}`)
  console.log(
    '\nThen, after one confirmation: npm run testnet:htlc -w @agentswap/core -- sweep <txid>.<vout>',
  )
}

/**
 * Takes a mined P2PKH output paid to buyer-1's deposit address into buyer-1's wallet, broadcast right away. The
 * logic of sweepDeposits in apps/agent/src/funding.ts (PR #15), for one outpoint.
 */
async function cmdSweep(outpoint: string | undefined): Promise<void> {
  const match = /^([0-9a-f]{64})\.(\d+)$/.exec(outpoint ?? '')
  if (match === null) throw new Error('usage: sweep <txid>.<vout>')
  const [, txid, voutText] = match
  const vout = Number(voutText)
  const key = depositKey(readKeyFile(keyFile('buyer-1')))
  const expected = new P2PKH().lock(key.toAddress('testnet')).toHex()
  const buyer = await openWallet('buyer-1')
  let reference: string | undefined
  try {
    const services = buyer.wallet.getServices()
    const { rawTx } = await services.getRawTx(txid)
    if (rawTx === undefined) throw new Error('transaction not found')
    const { merklePath } = await services.getMerklePath(txid)
    if (merklePath === undefined) throw new Error('not mined yet; try again after one confirmation')
    const tx = Transaction.fromBinary(rawTx)
    tx.merklePath = merklePath
    const output = tx.outputs[vout]
    if (output?.lockingScript.toHex() !== expected)
      throw new Error('the output does not pay the deposit address')
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const created = await buyer.wallet.createAction({
      description: 'Sweep a FlashCrowd deposit',
      inputBEEF: beef.toBinaryAtomic(txid),
      inputs: [
        { outpoint: outpoint!, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: 'Deposit' },
      ],
      labels: ['flashcrowd-deposit'],
      options: { acceptDelayedBroadcast: false },
    })
    const signable = created.signableTransaction
    if (signable === undefined) throw new Error('the wallet did not return a signable sweep')
    reference = signable.reference
    const sweep = Transaction.fromAtomicBEEF(signable.tx)
    const index = sweep.inputs.findIndex(
      (i) => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === txid && i.sourceOutputIndex === vout,
    )
    const unlockingScript = await new P2PKH()
      .unlock(key, 'all', false, output.satoshis, output.lockingScript)
      .sign(sweep, index)
    const signed = await buyer.wallet.signAction({
      reference,
      spends: { [index]: { unlockingScript: unlockingScript.toHex() } },
      options: { acceptDelayedBroadcast: false },
    })
    console.log(`swept ${outpoint}: ${wocTxUrl(signed.txid!, NETWORK)}`)
    console.log(`buyer-1 balance: ${await buyer.wallet.balance()} sats`)
  } catch (e) {
    if (reference !== undefined) await buyer.wallet.abortAction({ reference }).catch(() => undefined)
    throw e
  } finally {
    await buyer.close()
  }
}

async function cmdRun(): Promise<void> {
  const state = loadState()
  const parties = await openAll()
  const { seller } = parties
  const buyer1 = parties['buyer-1']
  const buyer2 = parties['buyer-2']
  try {
    const T = await heightOf(seller)
    const run: RunRecord = {
      startedAt: new Date().toISOString(),
      startHeight: T,
      sellerBalanceAtStart: await seller.wallet.balance(),
      groups: {},
    }
    const save = (): void => saveState(state)
    console.log(`testnet height T = ${T}; Arcade ${ARCADE}`)

    // 0. Balances
    if (run.sellerBalanceAtStart !== 0) {
      const note = state.runs.length === 0 ? 'on the first run' : 'from an earlier run'
      console.warn(
        `warning: the seller holds ${run.sellerBalanceAtStart} sats ${note}; the unfunded claim is not tested`,
      )
    }
    const b1 = await buyer1.wallet.balance()
    const b2 = await buyer2.wallet.balance()
    console.log(`balances: seller ${run.sellerBalanceAtStart}, buyer-1 ${b1}, buyer-2 ${b2} sats`)
    const payBuyer2 = b2 < 2 * SHARE + FEE_ROOM
    const needed = 2 * SHARE + FEE_ROOM + (payBuyer2 ? BUYER_2_FUNDING : 0)
    if (b1 < needed) {
      throw new Error(
        `buyer-1 has ${b1} sats and needs ${needed}; send test coins to its deposit address and sweep them`,
      )
    }
    state.runs.push(run)
    save()
    if (payBuyer2) {
      const payment = await createBrc29Payment(
        buyer1.wallet,
        buyer2.identityKey,
        BUYER_2_FUNDING,
        'Fund buyer-2',
      )
      await acceptBrc29Payment(buyer2.wallet, payment, new ArcadeChainTracker(ARCADE), 'Funding from buyer-1')
      console.log(`buyer-1 paid buyer-2 ${BUYER_2_FUNDING} sats (BRC-29): ${wocTxUrl(payment.txid, NETWORK)}`)
    }

    // 1. Group C, funded first so its refund height comes early.
    const c = await makeTerms(seller, 'C', [buyer2], T, T + 1)
    run.groups.C = { terms: c.terms, contributions: [], refunds: [] }
    save()
    await fund(seller, buyer2, run.groups.C, save)

    // 2. a) Group A: two buyers, the unfunded seller claims.
    const refundHeight = T + CLAIM_MARGIN_BLOCKS + 4
    const a = await makeTerms(seller, 'A', [buyer1, buyer2], T, refundHeight)
    run.groups.A = { terms: a.terms, contributions: [], refunds: [] }
    save()
    await fund(seller, buyer1, run.groups.A, save)
    await fund(seller, buyer2, run.groups.A, save)
    await claim(seller, run.groups.A, a.secret, save)

    // 3. b) Group B: an early refund, then the seller's claim.
    const b = await makeTerms(seller, 'B', [buyer1], T, refundHeight)
    run.groups.B = { terms: b.terms, contributions: [], refunds: [] }
    save()
    const contributionB = await fund(seller, buyer1, run.groups.B, save)
    run.earlyRefund = await sendEarlyRefund(buyer1, b.terms, contributionB)
    save()
    const claimB = await claim(seller, run.groups.B, b.secret, save)
    run.earlyRefund.verdict = classify(run.earlyRefund, claimB)
    save()
    console.log(`b) verdict: ${run.earlyRefund.verdict}`)

    // 4. c) Refund C once the chain is above its refund height.
    const groupC = run.groups.C
    await waitForHeight(seller, groupC.terms.refundHeight)
    const refund = await refundContribution(buyer2.ctx, groupC.terms, groupC.contributions[0])
    groupC.refunds.push(refund)
    save()
    console.log(`c) refund of C: ${refund.wocUrl}`)

    console.log(
      `\nbalances: seller ${await seller.wallet.balance()}, buyer-1 ${await buyer1.wallet.balance()}, ` +
        `buyer-2 ${await buyer2.wallet.balance()} sats`,
    )
    console.log('\n--- for issue #2 ---\n')
    console.log(issueTable(run))
  } finally {
    await Promise.all(Object.values(parties).map((p) => p.close()))
  }
}

/** Refunds every contribution of every run that was neither claimed nor refunded, once above its refundHeight. */
async function cmdRefund(): Promise<void> {
  const state = loadState()
  const parties = await openAll()
  try {
    const height = await heightOf(parties.seller)
    const byIdentity = new Map(Object.values(parties).map((p) => [p.identityKey, p]))
    let pending = 0
    for (const run of state.runs) {
      for (const [label, group] of Object.entries(run.groups)) {
        for (const c of group.contributions) {
          const outpoint = `${c.txid}.${c.vout}`
          if (c.beef === undefined) continue
          if (group.claim?.outpoints.includes(outpoint)) continue
          if (group.refunds.some((r) => r.outpoint === outpoint)) continue
          pending++
          if (height <= group.terms.refundHeight) {
            console.log(
              `${label} ${outpoint}: waits until the height is above ${group.terms.refundHeight} (now ${height})`,
            )
            continue
          }
          const buyer = byIdentity.get(c.identityKey)
          if (buyer === undefined) {
            console.log(`${label} ${outpoint}: not one of our buyers`)
            continue
          }
          try {
            const refund = await refundContribution(buyer.ctx, group.terms, c)
            group.refunds.push(refund)
            saveState(state)
            console.log(`${label} ${outpoint}: refunded to ${buyer.role}, ${refund.wocUrl}`)
          } catch (e) {
            console.log(`${label} ${outpoint}: ${message(e)}`)
          }
        }
      }
    }
    if (pending === 0) console.log('nothing to refund')
  } finally {
    await Promise.all(Object.values(parties).map((p) => p.close()))
  }
}

// Steps of the run

async function makeTerms(
  seller: Party,
  label: 'A' | 'B' | 'C',
  buyers: Party[],
  T: number,
  refundHeight: number,
): Promise<{ terms: HtlcTerms; secret: number[] }> {
  const groupId = `testnet-${label.toLowerCase()}-${T}-${Date.now().toString(36)}`
  const { secret, hash } = newSecret()
  const { ciphertextHash } = encryptResource(
    secret,
    Utils.toArray(`FlashCrowd testnet check, group ${label}`, 'utf8'),
  )
  const shares = buyers
    .map((b) => ({ identityKey: b.identityKey, shareSats: SHARE }))
    .sort((x, y) => (x.identityKey < y.identityKey ? -1 : 1))
  const terms = await signTerms(seller.ctx, {
    groupId,
    network: NETWORK,
    serviceId: 'testnet-htlc-check',
    resourceId: groupId,
    sellerIdentityKey: seller.identityKey,
    sellerKey: await htlcKey(seller.ctx, groupId),
    priceSats: SHARE * buyers.length,
    shares,
    hash,
    ciphertextHash,
    refundHeight,
  })
  console.log(
    `\ngroup ${label}: ${groupId}, ${buyers.map((b) => b.role).join(' + ')}, refundHeight ${refundHeight}`,
  )
  return { terms, secret }
}

/** prepareContribution → signRefund → verifyRefundSignature → broadcastContribution → verifyFunding. */
async function fund(
  seller: Party,
  buyer: Party,
  group: GroupRecord,
  save: () => void,
): Promise<FundingContribution> {
  const { terms } = group
  const { contribution, beef } = await prepareContribution(buyer.ctx, terms)
  const refundSignature = await signRefund(seller.ctx, terms, contribution)
  if (!verifyRefundSignature(terms, contribution, refundSignature)) {
    await abandonContribution(buyer.ctx, contribution)
    throw new Error("the seller's refund signature does not verify")
  }
  const sent = await broadcastContribution(
    buyer.ctx,
    terms,
    { ...contribution, refundSignature, status: 'refund_signed' },
    beef,
  )
  group.contributions.push(sent.contribution)
  save()
  await verifyFunding(terms, sent.contribution, new ArcadeChainTracker(ARCADE))
  sent.contribution.status = 'verified'
  save()
  console.log(`  ${buyer.role} funded ${sent.contribution.satoshis} sats: ${sent.wocUrl}`)
  return sent.contribution
}

/** The seller claims every contribution of the group. Returns false when the wallet or Arcade refuse the claim. */
async function claim(
  seller: Party,
  group: GroupRecord,
  secret: number[],
  save: () => void,
): Promise<boolean> {
  const before = await seller.wallet.balance()
  try {
    const {
      secret: _revealed,
      beef,
      ...proof
    } = await claimContributions(seller.ctx, group.terms, secret, group.contributions)
    const sellerSats = Transaction.fromAtomicBEEF(Utils.toArray(beef, 'hex')).outputs.reduce(
      (sum, o) => sum + (o.satoshis ?? 0),
      0,
    )
    group.claim = { ...proof, sellerSats }
    save()
    const status = await arcadeStatus(proof.txid)
    console.log(`  claim: ${proof.wocUrl}`)
    console.log(
      `  the seller (balance ${before} before) received ${sellerSats} sats; Arcade: ${status.txStatus ?? status.httpStatus}`,
    )
    if (/REJECTED|DOUBLE_SPEND/i.test(status.txStatus ?? '')) {
      group.claimError = `Arcade: ${status.txStatus}${status.extraInfo ? `, ${status.extraInfo}` : ''}`
      save()
      return false
    }
    return true
  } catch (e) {
    group.claimError = message(e)
    save()
    console.log(`  claim refused: ${group.claimError}`)
    return false
  }
}

/**
 * Builds buyer-1's refund of `c` by hand, valid but for its nLockTime (= refundHeight, still in the future), checks
 * it locally with Spend, sends it to Arcade as EF and asks for its status STATUS_DELAY_MS later.
 */
async function sendEarlyRefund(buyer: Party, terms: HtlcTerms, c: FundingContribution): Promise<EarlyRefund> {
  const source = Transaction.fromAtomicBEEF(Utils.toArray(c.beef!, 'hex'))
  const lockingScript = LockingScript.fromHex(c.lockingScript)
  // version 4 + 1 input (36 + 1 + unlock + 4) + 1 output (8 + 1 + 25) + nLockTime 4, with the counts
  const bytes = 4 + 1 + 36 + 1 + REFUND_UNLOCK_LENGTH + 4 + 1 + 34 + 4
  const fee = Math.ceil((bytes * EARLY_REFUND_SATS_PER_KB) / 1000)
  const tx = new Transaction(
    1,
    [{ sourceTransaction: source, sourceOutputIndex: c.vout, sequence: REFUND_SEQUENCE }],
    [{ lockingScript: new P2PKH().lock(buyer.depositAddress), satoshis: c.satoshis - fee }],
    terms.refundHeight,
  )
  const preimage = TransactionSignature.format({
    sourceTXID: c.txid,
    sourceOutputIndex: c.vout,
    sourceSatoshis: c.satoshis,
    transactionVersion: tx.version,
    otherInputs: [],
    inputIndex: 0,
    outputs: tx.outputs,
    inputSequence: REFUND_SEQUENCE,
    subscript: lockingScript,
    lockTime: tx.lockTime,
    scope: ALL,
  })
  const { signature } = await buyer.wallet.createSignature({
    hashToDirectlySign: Hash.hash256(preimage),
    protocolID: HTLC_PROTOCOL,
    keyID: terms.groupId,
    counterparty: 'anyone',
  })
  const der = Signature.fromDER(signature)
  const buyerSig = new TransactionSignature(der.r, der.s, ALL).toChecksigFormat()
  const sellerSig = Utils.toArray(c.refundSignature!, 'hex')
  const unlockingScript = new UnlockingScript([
    { op: buyerSig.length, data: buyerSig },
    { op: sellerSig.length, data: sellerSig },
    { op: OP.OP_0 },
  ])
  const spend = new Spend({
    sourceTXID: c.txid,
    sourceOutputIndex: c.vout,
    sourceSatoshis: c.satoshis,
    lockingScript,
    transactionVersion: tx.version,
    otherInputs: [],
    outputs: tx.outputs,
    unlockingScript,
    inputSequence: REFUND_SEQUENCE,
    inputIndex: 0,
    lockTime: tx.lockTime,
  })
  if (!spend.validate()) throw new Error('the early refund does not verify locally')
  tx.inputs[0].unlockingScript = unlockingScript
  const txid = tx.id('hex')
  console.log(`  early refund ${txid}: verified locally, nLockTime ${tx.lockTime}, fee ${fee} sats`)

  const res = await fetch(`${ARCADE}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: tx.toHexEF() }),
  })
  const body = await jsonOf(res)
  const early: EarlyRefund = {
    txid,
    httpStatus: res.status,
    txStatus: stringOf(body.txStatus),
    extraInfo: stringOf(body.extraInfo) ?? stringOf(body.detail) ?? stringOf(body.title),
  }
  console.log(
    `  POST /tx: HTTP ${early.httpStatus}, txStatus ${early.txStatus ?? '-'}, extraInfo ${early.extraInfo ?? '-'}`,
  )
  await sleep(STATUS_DELAY_MS)
  const later = await arcadeStatus(txid)
  early.laterHttpStatus = later.httpStatus
  early.laterTxStatus = later.txStatus
  console.log(
    `  GET /tx after ${STATUS_DELAY_MS / 1000} s: HTTP ${later.httpStatus}, txStatus ${later.txStatus ?? '-'}`,
  )
  return early
}

/** A refusal for the fee says nothing about nLockTime, so it is inconclusive rather than 'rejected'. */
function classify(early: EarlyRefund, claimPassed: boolean): Verdict {
  const refused = (status?: string): boolean => /REJECTED|INVALID|NON.?FINAL/i.test(status ?? '')
  if (early.httpStatus >= 400 || refused(early.txStatus) || refused(early.laterTxStatus)) {
    return /fee/i.test(early.extraInfo ?? '') ? 'inconclusive: refused for its fee' : 'rejected'
  }
  return claimPassed ? 'held, claim passed' : 'held, claim blocked'
}

async function waitForHeight(p: Party, above: number): Promise<number> {
  for (;;) {
    const height = await heightOf(p)
    if (height > above) return height
    console.log(`  height ${height}; waiting for a height above ${above}`)
    await sleep(HEIGHT_POLL_MS)
  }
}

// Arcade and output

async function arcadeStatus(
  txid: string,
): Promise<{ httpStatus: number; txStatus?: string; extraInfo?: string }> {
  const res = await fetch(`${ARCADE}/tx/${txid}`)
  const body = await jsonOf(res)
  return { httpStatus: res.status, txStatus: stringOf(body.txStatus), extraInfo: stringOf(body.extraInfo) }
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return text === '' ? {} : { extraInfo: text.slice(0, 200) }
  }
}

const stringOf = (v: unknown): string | undefined =>
  v === undefined || v === null || v === '' ? undefined : String(v)
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const link = (txid: string): string => `[${txid.slice(0, 12)}…](${wocTxUrl(txid, NETWORK)})`

/** The run's results as an English Markdown table for issue #2. */
function issueTable(run: RunRecord): string {
  const rows: string[][] = []
  const { A, B, C } = run.groups
  for (const [label, group] of [
    ['C', C],
    ['A', A],
    ['B', B],
  ] as const) {
    for (const c of group?.contributions ?? []) {
      rows.push([
        `Fund group ${label}`,
        link(c.txid),
        `${c.satoshis} sats, refundHeight ${group!.terms.refundHeight}, SPV ok`,
      ])
    }
  }
  if (A?.claim) {
    rows.push([
      'a) Claim A, seller wallet empty',
      link(A.claim.txid),
      `seller balance before: ${run.sellerBalanceAtStart} sats; received ${A.claim.sellerSats} sats`,
    ])
  } else if (A) rows.push(['a) Claim A', '-', `failed: ${A.claimError ?? 'not run'}`])
  const e = run.earlyRefund
  if (e) {
    rows.push([
      'b) Refund B before refundHeight',
      `\`${e.txid.slice(0, 12)}…\``,
      `POST /tx: HTTP ${e.httpStatus}, ${e.txStatus ?? '-'}, ${e.extraInfo ?? '-'}; after 30 s: ${e.laterTxStatus ?? `HTTP ${e.laterHttpStatus}`}`,
    ])
  }
  if (B?.claim)
    rows.push(['b) Claim B after the early refund', link(B.claim.txid), `passed, ${B.claim.sellerSats} sats`])
  else if (B) rows.push(['b) Claim B after the early refund', '-', `blocked: ${B.claimError ?? 'not run'}`])
  for (const r of C?.refunds ?? [])
    rows.push([`c) Refund C above height ${C!.terms.refundHeight}`, link(r.txid), 'refunded'])
  const cell = (s: string): string => s.replace(/\|/g, '\\|')
  return [
    `Testnet HTLC check, start height ${run.startHeight}, CLAIM_MARGIN_BLOCKS = ${CLAIM_MARGIN_BLOCKS}.`,
    '',
    '| Step | Transaction | Result |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
    '',
    `**b) verdict: ${e?.verdict ?? 'not reached'}**`,
  ].join('\n')
}

// Entry point

const [command, ...args] = process.argv.slice(2)
try {
  if (parseNetwork(process.env.BSV_NETWORK) !== NETWORK) throw new Error('this script runs on testnet only')
  if (command !== 'init') mkdirSync(DIR, { recursive: true, mode: 0o700 })
  if (command === 'init') await cmdInit()
  else if (command === 'sweep') await cmdSweep(args[0])
  else if (command === 'run') await cmdRun()
  else if (command === 'refund') await cmdRefund()
  else
    throw new Error(
      'usage: npm run testnet:htlc -w @agentswap/core -- init | sweep <txid>.<vout> | run | refund',
    )
} catch (e) {
  console.error(`error: ${message(e)}`)
  process.exitCode = 1
}
