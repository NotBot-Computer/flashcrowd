import type { Network } from '@agentswap/core'

/** Both sides must be on one network: a testnet payment never reaches a mainnet agent, and the other way round. */
export const isNetworkMismatch = (wallet?: Network, server?: Network) =>
  wallet !== undefined && server !== undefined && wallet !== server

/** Shown on every page while the connected wallet and the server are on different networks. */
export function NetworkBanner({ wallet, server }: { wallet?: Network; server?: Network }) {
  if (!isNetworkMismatch(wallet, server)) return null
  return (
    <div className="network-banner" role="alert">
      <strong>Network mismatch.</strong> Your wallet is on {wallet}, the server on {server}. Switch BSV Desktop to{' '}
      {server}; this page notices when you come back to it.
    </div>
  )
}
