// Our one change to the token kit: signWalletP2pkhInput's sighash `scope`. An offer signs input 0 with
// SIGHASH_SINGLE | SIGHASH_ANYONECANPAY | SIGHASH_FORKID (0xC3), so a taker can add inputs and outputs but cannot
// change output 0, the maker's price.
import {
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Spend,
  Transaction,
  TransactionSignature,
  type LockingScript,
  type UnlockingScript,
  type WalletInterface,
} from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { signWalletP2pkhInput } from '../src/kit/client/signer'
import { keyIdFor, receivePkh, TOKEN_PROTOCOL } from '../src/kit/core/addresses'
import { buildBsv21Script } from '../src/kit/core/inscription'

const { SIGHASH_ALL, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY, SIGHASH_FORKID } = TransactionSignature
const OFFER_SCOPE = SIGHASH_SINGLE | SIGHASH_ANYONECANPAY | SIGHASH_FORKID
const key = { protocolID: TOKEN_PROTOCOL, keyID: keyIdFor(0) }

const p2pkh = (): LockingScript => new P2PKH().lock(PrivateKey.fromRandom().toAddress())

/** The maker's side, unsigned: a token UTXO as input 0 and the payment for it as output 0. */
async function makeOffer(priceSats = 5_000): Promise<{ maker: WalletInterface; tx: Transaction }> {
  // signWalletP2pkhInput only calls getPublicKey and createSignature, which ProtoWallet has.
  const maker = new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface
  const { publicKey: identityKey } = await maker.getPublicKey({ identityKey: true })
  const tokenId = `${'ab'.repeat(32)}_0`
  const source = new Transaction()
  source.addOutput({
    lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: '100' }, receivePkh(identityKey, 0)),
    satoshis: 1,
  })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, sequence: 0xffffffff })
  tx.addOutput({ lockingScript: p2pkh(), satoshis: priceSats })
  return { maker, tx }
}

/** Runs input 0's unlocking script against the token output it spends. */
function input0IsValid(tx: Transaction, unlockingScript: UnlockingScript): boolean {
  const input = tx.inputs[0]
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  try {
    return new Spend({
      sourceTXID: input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis!,
      lockingScript: source.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.slice(1),
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript,
      inputSequence: input.sequence!,
      lockTime: tx.lockTime,
    }).validate()
  } catch {
    return false
  }
}

/** The sighash type is the last byte of the signature push. */
const sighashType = (unlockingScript: UnlockingScript): number | undefined =>
  unlockingScript.chunks[0].data?.at(-1)

describe('signWalletP2pkhInput scope', () => {
  it('signs with SIGHASH_ALL | SIGHASH_FORKID by default, as in the kit', async () => {
    const { maker, tx } = await makeOffer()
    const unlockingScript = await signWalletP2pkhInput(maker, tx, 0, key)
    expect(sighashType(unlockingScript)).toBe(SIGHASH_ALL | SIGHASH_FORKID)
    expect(input0IsValid(tx, unlockingScript)).toBe(true)
  })

  it('with 0xC3, input 0 stays valid after the taker adds inputs and outputs', async () => {
    const { maker, tx } = await makeOffer()
    const unlockingScript = await signWalletP2pkhInput(maker, tx, 0, key, undefined, OFFER_SCOPE)
    expect(sighashType(unlockingScript)).toBe(0xc3)

    tx.addInput({ sourceTXID: 'cd'.repeat(32), sourceOutputIndex: 1, sequence: 0xffffffff }) // taker's funding
    tx.addOutput({ lockingScript: p2pkh(), satoshis: 1 }) // tokens to the taker
    tx.addOutput({ lockingScript: p2pkh(), satoshis: 900 }) // taker's change
    expect(input0IsValid(tx, unlockingScript)).toBe(true)
  })

  it('with 0xC3, changing the price or the payee in output 0 makes input 0 invalid', async () => {
    const { maker, tx } = await makeOffer(5_000)
    const unlockingScript = await signWalletP2pkhInput(maker, tx, 0, key, undefined, OFFER_SCOPE)
    const payee = tx.outputs[0].lockingScript

    tx.outputs[0] = { lockingScript: payee, satoshis: 4_000 }
    expect(input0IsValid(tx, unlockingScript)).toBe(false)
    tx.outputs[0] = { lockingScript: p2pkh(), satoshis: 5_000 }
    expect(input0IsValid(tx, unlockingScript)).toBe(false)
    tx.outputs[0] = { lockingScript: payee, satoshis: 5_000 }
    expect(input0IsValid(tx, unlockingScript)).toBe(true)
  })
})
