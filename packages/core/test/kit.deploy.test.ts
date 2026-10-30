// The token kit in src/kit, end to end on wallet-toolbox's mock chain: a real wallet-toolbox wallet (the wallet
// engine BSV Desktop runs) deploys a BSV-21 token, and the kit's overlay, running in-process, admits it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OverlayClient } from '../src/kit/client/overlayApi'
import { TokenKit } from '../src/kit/client/token'
import { startOverlay, type RunningOverlay } from '../src/kit/overlay/server'
import { createMockChain, type MockChain } from './helpers/mockchain'

let dir: string
let chain: MockChain
let overlay: RunningOverlay

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentswap-core-'))
  chain = await createMockChain()
  overlay = await startOverlay({
    port: 18091,
    dbFile: join(dir, 'overlay.db'),
    chainTracker: chain.chainTracker,
    quiet: true,
  })
})

afterAll(async () => {
  await overlay?.close()
  await chain?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('token kit on the mock chain', () => {
  it('deploys a BSV-21 token that the overlay admits', async () => {
    const wallet = await chain.makeWallet()
    await chain.fund(wallet)
    const kit = new TokenKit(wallet, new OverlayClient(overlay.url))

    const { txid, tokenId } = await kit.deploy({ sym: 'USDx', amt: 1_000_000n, dec: 2 })

    expect(tokenId).toBe(`${txid}_0`)
    const [deploy] = await kit.overlay.lookup({ op: 'token', tokenId })
    expect(deploy.ctx).toMatchObject({
      op: 'deploy+mint',
      amt: '1000000',
      sym: 'USDx',
      dec: '2',
      spent: false,
    })
    expect(await kit.balances()).toEqual([
      { tokenId, sym: 'USDx', dec: '2', overlay: 1_000_000n, basket: 1_000_000n, utxos: 1 },
    ])
  })
})
