import { WalletClient, type WalletInterface } from '@bsv/sdk'
import type { Network } from '@agentswap/core'

// Shape A: the user's BRC-100 wallet (BSV Desktop or BSV Browser) holds every key. The app asks it for public
// keys, signatures and actions only, never for a private key or recovery phrase.
// The connect flow follows the official sample in bsv-blockchain/bsv-ai-toolkit (samples/tipping-shape-a/web/wallet.ts).

export interface Session {
  wallet: WalletInterface
  identityKey: string
  network: Network
}

type Connectable = WalletInterface & { connectToSubstrate?: () => Promise<void> }

/** The wallet originator: the host serving this app and /manifest.json (the SDK drops the port). */
const originator = () => window.location.host

export async function connectWallet(): Promise<Session> {
  const wallet: Connectable = new WalletClient('auto', originator())
  if (typeof wallet.connectToSubstrate === 'function') await wallet.connectToSubstrate()
  // waitForAuthentication rather than isAuthenticated, which throws on a locked wallet in @bsv/sdk 3.2.1
  await wallet.waitForAuthentication({})
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
  const { network } = await wallet.getNetwork({})
  return { wallet, identityKey, network }
}
