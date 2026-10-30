import { HTLC_PROTOCOL, TERMS_PROTOCOL } from '@agentswap/core'
import { describe, expect, it } from 'vitest'
import manifest from '../public/manifest.json'

// The wallet reads public/manifest.json at Connect wallet, so the user approves every protocol core uses up front.
const BRC29_PROTOCOL = [2, '3241645161d8']

interface GroupPermissions {
  spendingAuthorization: { amount: number; description: string }
  protocolPermissions: { protocolID: [number, string]; counterparty?: string; description: string }[]
  basketAccess?: { basket: string; description: string }[]
}

const groups = [
  ['metanet', manifest.metanet.groupPermissions],
  ['babbage', manifest.babbage.groupPermissions],
] as [string, GroupPermissions][]

describe('manifest.json', () => {
  it('gives BSV Desktop (metanet) and older wallets (babbage) the same permissions', () => {
    expect(manifest.babbage).toEqual(manifest.metanet)
  })

  describe.each(groups)('%s', (_, permissions) => {
    const protocols = permissions.protocolPermissions.map(p => p.protocolID)

    it('asks for the FlashCrowd protocols core signs with', () => {
      expect(protocols).toContainEqual(HTLC_PROTOCOL)
      expect(protocols).toContainEqual(TERMS_PROTOCOL)
    })

    it('asks for BRC-29, which funding the agent uses', () => {
      expect(protocols).toContainEqual(BRC29_PROTOCOL)
    })

    it('uses protocol and basket names the wallet accepts', () => {
      const names = [...protocols.map(([, name]) => name), ...(permissions.basketAccess ?? []).map(b => b.basket)]
      for (const name of names) expect(name).toMatch(/^[a-z0-9]+( [a-z0-9]+)*$/)
    })

    it('sets a positive monthly allowance', () => {
      expect(permissions.spendingAuthorization.amount).toBeGreaterThan(0)
    })
  })
})
