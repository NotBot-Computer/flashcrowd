# packages/core (P1)

On-chain logic shared by web, server and agent: the USDx demo token, atomic offers (create, verify, fill, cancel),
the link to our BSV-21 overlay and explorer links.

- `src/types.ts`: the contract between the four parts (`Offer`, `Quote`, `FeedEvent`, `SpendPolicy`).
- `src/config.ts`: network, Arcade hosts and WhatsOnChain links.

Tests: `npm test -w @agentswap/core`.

## API

Agreed design for issue #2; the code is written during the event. Every function takes a `CoreContext`, so the same
code runs against BSV Desktop in the browser (`new WalletClient('auto')`) and against the agent's wallet-toolbox
wallet:

```ts
interface CoreContext {
  wallet: WalletInterface // from @bsv/sdk
  network: Network // 'testnet' by default (parseNetwork)
  overlayUrl: string // our BSV-21 overlay, apps/overlay
  originator?: string // Node only: the app's domain
}
```

| Function                                                | Returns                                                  | Called by                                           |
| ------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `deployToken(ctx, { sym, supply, dec, icon? })`         | `{ txid, tokenId, wocUrl }`                              | P1's USDx script                                    |
| `getBalances(ctx)`                                      | per token: the overlay's and the wallet basket's amounts | web, agent                                          |
| `syncTokens(ctx)`                                       | the outputs taken into or dropped from the basket        | web, agent                                          |
| `sendTokens(ctx, tokenId, amount, to, { exclude? })`    | `{ txid, wocUrl }`                                       | web, agent                                          |
| `createOffer(ctx, { tokenId, tokenAmount, priceSats })` | `{ offer: NewOffer, splitTxid? }`                        | web (Sell)                                          |
| `verifyOffer(offer, { chainTracker, overlayUrl })`      | nothing; throws with the reason                          | server before listing; web and agent before filling |
| `fillOffer(ctx, offer, { tokenRecipient? })`            | `{ txid, wocUrl }`                                       | web (Swap), agent                                   |
| `cancelOffer(ctx, offer)`                               | `{ txid, wocUrl }`                                       | web                                                 |
| `claimOfferPayment(ctx, offer, fillTxid)`               | nothing                                                  | web, for the maker after a fill                     |
| `swapAndPay(ctx, offer, serviceIdentityKey)` (stretch)  | `{ txid, wocUrl }`                                       | agent                                               |

- BSV-21 has no separate mint: `deploy+mint` creates the whole supply in one output, so `deployToken` replaces the
  planned `mintToken`.
- `syncTokens` is the only way received tokens (a fill, a transfer) reach the wallet basket.
- `verifyOffer` checks the SPV proof of `sourceBeef`, the token id and amount of the UTXO, the signature and its
  sighash type, and that the overlay still lists the UTXO as unspent.
- `sendTokens` skips the token UTXOs behind the maker's open offers (`exclude`), so a transfer never cancels an offer
  by accident.
- `swapAndPay` is `fillOffer` with the token output going to the service instead of the taker.
- Amounts are `bigint` inside core and decimal strings in `types.ts`, which does not change.

## Layout

- `src/kit/`: the developer pack's `starter/bsv21-token-kit` (`core/` and `client/`, guide Appendix A), copied with a
  source note. The only change: `signWalletP2pkhInput` takes an optional sighash `scope`.
- `src/tokens.ts`, `src/offers.ts`: the functions above, on top of the kit's `TokenKit`.
- Tests: Vitest on wallet-toolbox's mock chain with the overlay in-process, like the kit (create → verify → fill, a
  changed price is refused, a fill after a cancel fails, the maker claims the payment). They need
  `@bsv/wallet-toolbox`, `@bsv/overlay` and `@bsv/overlay-express` at the versions in AGENTS.md, plus knex and
  better-sqlite3, as devDependencies.
- A testnet script deploys USDx and prints the WhatsOnChain links.

The transaction layout, the overlay and the key choices are in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#atomic-offer).
