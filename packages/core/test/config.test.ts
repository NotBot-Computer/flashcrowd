import { describe, expect, it } from 'vitest'
import { parseNetwork, wocTxUrl } from '../src/config'

describe('config', () => {
  it('defaults to testnet', () => {
    expect(parseNetwork(undefined)).toBe('testnet')
    expect(parseNetwork('test')).toBe('testnet')
    expect(parseNetwork('mainnet')).toBe('mainnet')
  })

  it('links transactions on the explorer of their network', () => {
    expect(wocTxUrl('ab12', 'testnet')).toBe('https://test.whatsonchain.com/tx/ab12')
    expect(wocTxUrl('ab12', 'mainnet')).toBe('https://whatsonchain.com/tx/ab12')
  })
})
