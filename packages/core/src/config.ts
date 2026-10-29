export type Network = 'testnet' | 'mainnet'

/** Reads a BSV_NETWORK-style value; anything other than "mainnet" means testnet. */
export function parseNetwork(value: string | undefined): Network {
  return value === 'mainnet' ? 'mainnet' : 'testnet'
}

/**
 * BSV Broadcaster (Arcade) hosts. The track page names the mainnet v2 host; the testnet host comes from
 * bsv-blockchain/bsv-ai-toolkit content/versions.json (verified 2026-10-28). Check both against AGENTS.md.
 */
export const ARCADE_URL: Record<Network, string> = {
  testnet: 'https://arcade-v2-testnet-us-1.bsvblockchain.tech',
  mainnet: 'https://arcade-v2-us-1.bsvblockchain.tech',
}

export function wocTxUrl(txid: string, network: Network): string {
  const host = network === 'mainnet' ? 'whatsonchain.com' : 'test.whatsonchain.com'
  return `https://${host}/tx/${txid}`
}
