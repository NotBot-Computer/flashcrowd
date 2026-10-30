// Funding an agent with the web app's payment file (BRC-29 to its identity key), on wallet-toolbox's mock chain.
import { createBrc29Payment } from '@agentswap/core'
import type { Wallet } from '@bsv/wallet-toolbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMockChain, type MockChain } from '../../../packages/core/test/helpers/mockchain'
import { FUNDING_KIND, parseFundingFile, receiveFunding, type AgentFundingFile } from '../src/receive'

let chain: MockChain
let sender: Wallet
let agent: Wallet
let other: Wallet

/** What the funding page downloads after a BRC-29 payment from the sender to `recipient`. */
async function fundingFile(recipient: Wallet, satoshis: number): Promise<AgentFundingFile> {
  const payment = await createBrc29Payment(sender, recipient.identityKey, satoshis, 'Fund a FlashCrowd agent')
  return {
    ...payment,
    kind: FUNDING_KIND,
    version: 1,
    network: 'testnet',
    recipientIdentityKey: recipient.identityKey,
    wocUrl: `https://test.whatsonchain.com/tx/${payment.txid}`,
    createdAt: new Date().toISOString(),
  }
}

/** The file as it comes back from disk. */
const roundTrip = (f: unknown): unknown => JSON.parse(JSON.stringify(f))

beforeAll(async () => {
  chain = await createMockChain()
  sender = await chain.makeWallet()
  await chain.fund(sender)
  agent = await chain.makeWallet()
  other = await chain.makeWallet()
})

afterAll(async () => {
  await chain?.close()
})

describe('receive', () => {
  it('takes a payment file for this agent into its wallet; the second time adds nothing', async () => {
    const file = await fundingFile(agent, 5_000)
    expect(await agent.balance()).toBe(0)
    const received = await receiveFunding(agent, 'testnet', roundTrip(file), chain.chainTracker)
    expect(received).toEqual({
      satoshis: 5_000,
      txid: file.txid,
      wocUrl: `https://test.whatsonchain.com/tx/${file.txid}`,
    })
    expect(await agent.balance()).toBe(5_000)

    await receiveFunding(agent, 'testnet', roundTrip(file), chain.chainTracker).catch(() => undefined)
    expect(await agent.balance()).toBe(5_000)
  })

  it('refuses a file for another agent, even one that claims to be for this agent', async () => {
    const forOther = await fundingFile(other, 3_000)
    await expect(receiveFunding(agent, 'testnet', roundTrip(forOther), chain.chainTracker)).rejects.toThrow(
      /not this agent/,
    )
    const relabelled = { ...forOther, recipientIdentityKey: agent.identityKey }
    await expect(receiveFunding(agent, 'testnet', roundTrip(relabelled), chain.chainTracker)).rejects.toThrow(
      /not locked to our key/,
    )
    expect(await agent.balance()).toBe(5_000)
  })

  it('refuses a file from another network, of another kind, or with a mismatched amount or txid', async () => {
    const file = await fundingFile(agent, 2_000)
    await expect(
      receiveFunding(agent, 'testnet', roundTrip({ ...file, network: 'mainnet' }), chain.chainTracker),
    ).rejects.toThrow(/on mainnet, this agent runs on testnet/)
    await expect(receiveFunding(agent, 'mainnet', roundTrip(file), chain.chainTracker)).rejects.toThrow(
      /on testnet, this agent runs on mainnet/,
    )
    await expect(
      receiveFunding(agent, 'testnet', roundTrip({ ...file, kind: 'something else' }), chain.chainTracker),
    ).rejects.toThrow(/kind/)
    await expect(
      receiveFunding(agent, 'testnet', roundTrip({ ...file, satoshis: 20_000 }), chain.chainTracker),
    ).rejects.toThrow(/2000 sats, not 20000/)
    await expect(
      receiveFunding(agent, 'testnet', roundTrip({ ...file, txid: 'ab'.repeat(32) }), chain.chainTracker),
    ).rejects.toThrow(/tx and txid differ/)
    expect(await agent.balance()).toBe(5_000)
  })

  it('parseFundingFile refuses malformed files', () => {
    expect(() => parseFundingFile(null)).toThrow(/JSON object/)
    expect(() => parseFundingFile({ kind: FUNDING_KIND, version: 2 })).toThrow(/version/)
    expect(() => parseFundingFile({ kind: FUNDING_KIND, version: 1, network: 'regtest' })).toThrow(/network/)
  })
})
