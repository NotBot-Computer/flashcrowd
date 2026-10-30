import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isNetworkMismatch, NetworkBanner } from '../src/NetworkBanner'

describe('network mismatch', () => {
  it('is a mismatch only when both networks are known and differ', () => {
    expect(isNetworkMismatch('testnet', 'mainnet')).toBe(true)
    expect(isNetworkMismatch('mainnet', 'mainnet')).toBe(false)
    expect(isNetworkMismatch(undefined, 'mainnet')).toBe(false)
    expect(isNetworkMismatch('testnet', undefined)).toBe(false)
  })

  it('names both networks and what to do', () => {
    const html = renderToStaticMarkup(<NetworkBanner wallet="testnet" server="mainnet" />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Your wallet is on testnet, the server on mainnet')
    expect(html).toContain('Switch BSV Desktop to mainnet')
  })

  it('shows nothing while the networks agree or the wallet is not connected', () => {
    expect(renderToStaticMarkup(<NetworkBanner wallet="mainnet" server="mainnet" />)).toBe('')
    expect(renderToStaticMarkup(<NetworkBanner server="mainnet" />)).toBe('')
  })
})
