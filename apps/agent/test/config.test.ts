import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { readSettings } from '../src/config'

const env = {
  AGENT_MAX_CONTRIBUTIONS: '3000,4000,5000',
  AGENT_MAX_PER_PURCHASE_SATS: '6000',
  AGENT_MAX_TOTAL_SATS: '20000',
}

describe('readSettings', () => {
  it('runs N agents from the key directory, one offer each', () => {
    const s = readSettings({ ...env, AGENT_KEY_DIR: '/keys' }, ['--agents', '3'])
    expect(s.agents).toEqual([
      { name: 'agent-1', keyFile: '/keys/agent-1.key', maxContributionSats: 3_000 },
      { name: 'agent-2', keyFile: '/keys/agent-2.key', maxContributionSats: 4_000 },
      { name: 'agent-3', keyFile: '/keys/agent-3.key', maxContributionSats: 5_000 },
    ])
    expect(s.network).toBe('testnet')
    expect(s.check).toBe(false)
    expect(s.policy).toEqual({
      maxPerPurchaseSats: 6_000,
      maxTotalSats: 20_000,
      allowedServiceIds: ['bsv-usd-closes'],
      requireMatchingResource: true,
      maxLockBlocks: 30,
    })
  })

  it('defaults to ~/.agentswap, takes AGENT_KEY_FILES and --check, and one offer for all', () => {
    expect(readSettings({ ...env, AGENT_MAX_CONTRIBUTIONS: '4000' }, []).agents).toEqual([
      { name: 'agent-1', keyFile: `${homedir()}/.agentswap/agent-1.key`, maxContributionSats: 4_000 },
    ])
    const s = readSettings({ ...env, AGENT_KEY_FILES: '/a.key, /b.key,/c.key' }, ['--check'])
    expect(s.agents.map((a) => a.keyFile)).toEqual(['/a.key', '/b.key', '/c.key'])
    expect(s.check).toBe(true)
  })

  it('refuses amounts that are not whole sats', () => {
    const one = { ...env, AGENT_MAX_CONTRIBUTIONS: '3000' }
    expect(() => readSettings({ ...one, AGENT_MAX_TOTAL_SATS: '2000.5' }, [])).toThrow(/whole number/)
    expect(() =>
      readSettings({ ...env, AGENT_MAX_CONTRIBUTIONS: '3000,-1,5000' }, ['--agents', '3']),
    ).toThrow(/whole number/)
    expect(() => readSettings({ ...one, AGENT_MAX_PER_PURCHASE_SATS: '' }, [])).toThrow(/not set/)
    expect(() => readSettings({ ...one, AGENT_MAX_TOTAL_SATS: '99999999999999999999' }, [])).toThrow(
      /too large/,
    )
  })

  it('refuses mismatched counts, shared key files and unknown arguments', () => {
    expect(() => readSettings(env, ['--agents', '2'])).toThrow(/3 values for 2 agents/)
    expect(() => readSettings({ ...env, AGENT_KEY_FILES: '/a.key,/b.key' }, ['--agents', '3'])).toThrow(
      /names 2/,
    )
    expect(() => readSettings({ ...env, AGENT_KEY_FILES: '/a.key,/a.key,/b.key' }, [])).toThrow(/share a key/)
    expect(() => readSettings(env, ['--agents', '0'])).toThrow(/between 1 and 10/)
    expect(() => readSettings(env, ['--fast'])).toThrow(/unknown argument/)
  })
})
