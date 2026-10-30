// Getting test coins into an agent's wallet. A faucet or BSV Desktop pays a plain P2PKH address; the agent then takes
// those outputs into its BRC-100 wallet. The address belongs to a deposit key derived from the root key, so the
// identity key is never used as a payment key.
//
// Not wallet-toolbox's Setup.fundWalletFromP2PKHOutpoints: it leaves the broadcast to the wallet's Monitor
// (delayed broadcast), so without a running Monitor the sweep is counted in the balance but never sent.
import {
  Beef,
  CachedKeyDeriver,
  MerklePath,
  P2PKH,
  Transaction,
  type PrivateKey,
  type WalletProtocol,
} from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import type { Network } from '@agentswap/core'

const DEPOSIT_PROTOCOL: WalletProtocol = [1, 'flashcrowd deposit']
/** <signature> <public key> */
const P2PKH_UNLOCK_LENGTH = 108

/** The agent's deposit key: [1, 'flashcrowd deposit'], keyID '1', counterparty 'self'. */
export function depositKey(rootKey: PrivateKey): PrivateKey {
  return new CachedKeyDeriver(rootKey).derivePrivateKey(DEPOSIT_PROTOCOL, '1', 'self')
}

/** The P2PKH address to send test coins to. */
export function depositAddress(rootKey: PrivateKey, network: Network): string {
  return depositKey(rootKey).toAddress(network === 'mainnet' ? 'mainnet' : 'testnet')
}

export interface SweepResult {
  outpoint: string
  success: boolean
  txid?: string
  error?: string
}

/**
 * Takes P2PKH outputs paid to the deposit address (`<txid>.<vout>`) into the wallet, one transaction each, broadcast
 * right away. The deposit must be mined: its transaction and proof come from the wallet's services (WhatsOnChain
 * and Arcade on testnet). An output that does not pay the deposit key, or is already spent, fails on its own.
 */
export async function sweepDeposits(
  wallet: Wallet,
  rootKey: PrivateKey,
  outpoints: string[],
): Promise<SweepResult[]> {
  const key = depositKey(rootKey)
  const expected = new P2PKH().lock(key.toAddress()).toHex()
  const services = wallet.getServices()
  const results: SweepResult[] = []
  for (const outpoint of outpoints) {
    let reference: string | undefined
    try {
      const match = /^([0-9a-f]{64})\.(\d+)$/.exec(outpoint)
      if (match === null) throw new Error('not an outpoint (<txid>.<vout>)')
      const [, txid, voutText] = match
      const vout = Number(voutText)
      const { rawTx } = await services.getRawTx(txid)
      if (rawTx === undefined) throw new Error('transaction not found')
      const { merklePath } = await services.getMerklePath(txid)
      if (merklePath === undefined) throw new Error('not mined yet; try again after one confirmation')
      const tx = Transaction.fromBinary(rawTx)
      // wallet-toolbox builds its MerklePath with its own (CommonJS) copy of the SDK; rebuild it with ours.
      tx.merklePath = MerklePath.fromBinary(merklePath.toBinary())
      const output = tx.outputs[vout]
      if (output?.lockingScript.toHex() !== expected)
        throw new Error('the output does not pay the deposit address')
      const beef = new Beef()
      beef.mergeTransaction(tx)

      const created = await wallet.createAction({
        description: 'Sweep a FlashCrowd deposit',
        inputBEEF: beef.toBinaryAtomic(txid),
        inputs: [{ outpoint, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: 'Deposit' }],
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
      const signed = await wallet.signAction({
        reference,
        spends: { [index]: { unlockingScript: unlockingScript.toHex() } },
        options: { acceptDelayedBroadcast: false },
      })
      results.push({ outpoint, success: true, txid: signed.txid })
    } catch (e) {
      if (reference !== undefined) await wallet.abortAction({ reference }).catch(() => undefined)
      results.push({ outpoint, success: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return results
}
