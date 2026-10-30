# packages/core (P1)

On-chain logic shared by web, server and agent: the USDx demo token, atomic offers (create, verify, fill, cancel),
the link to our BSV-21 overlay and explorer links.

- `src/types.ts`: the contract between the four parts (`Offer`, `Quote`, `FeedEvent`, `SpendPolicy`, and the
  FlashCrowd types: `ServiceOffer`, `PurchaseIntent`, `PurchaseGroup`, `HtlcTerms`, `FundingContribution`, …).
- `src/config.ts`: network, Arcade hosts and WhatsOnChain links.

Tests: `npm test -w @agentswap/core`.

## API

Issue #2: `src/context.ts`, `src/tokens.ts` and `src/offers.ts`, all exported from the package. Every function takes a
`CoreContext`, so the same code runs against BSV Desktop in the browser (`new WalletClient('auto')`) and against the
agent's wallet-toolbox wallet:

```ts
interface CoreContext {
  wallet: WalletInterface // from @bsv/sdk
  network: Network // 'testnet' by default (parseNetwork)
  overlayUrl: string // our BSV-21 overlay, apps/overlay
  originator?: string // Node only: the app's domain
}
```

| Function                                                          | Returns                                                  | Called by                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `deployToken(ctx, { sym, supply, dec, icon? })`                   | `{ txid, tokenId, wocUrl }`                              | P1's USDx script                                    |
| `getBalances(ctx)`                                                | per token: the overlay's and the wallet basket's amounts | web, agent                                          |
| `syncTokens(ctx)`                                                 | the outputs taken into or dropped from the basket        | web, agent                                          |
| `sendTokens(ctx, tokenId, amount, to, { exclude? })`              | `{ txid, wocUrl }`                                       | web, agent                                          |
| `createOffer(ctx, { tokenId, tokenAmount, priceSats, exclude? })` | `{ offer: NewOffer, splitTxid? }`                        | web (Sell)                                          |
| `verifyOffer(offer, { chainTracker, overlayUrl })`                | nothing; throws `InvalidOfferError` with the reason      | server before listing; web and agent before filling |
| `fillOffer(ctx, offer, { tokenRecipient? })`                      | `{ txid, wocUrl }`                                       | web (Swap), agent                                   |
| `cancelOffer(ctx, offer)`                                         | `{ txid, wocUrl }`                                       | web                                                 |
| `claimOfferPayment(ctx, offer, fillTxid)`                         | nothing                                                  | web, for the maker after a fill                     |
| `swapAndPay(ctx, offer, serviceIdentityKey)` (stretch)            | `{ txid, wocUrl }`                                       | agent                                               |

- BSV-21 has no separate mint: `deploy+mint` creates the whole supply in one output, so `deployToken` replaces the
  planned `mintToken`.
- `syncTokens` is the only way received tokens (a fill, a transfer) reach the wallet basket.
- `tokenKit(ctx)` returns the kit's `TokenKit` for a context, one per context object, so overlay submissions still
  queued for a retry carry over between calls.
- `createOffer` and `sendTokens` skip the outpoints in `exclude`, the token UTXOs behind the maker's open offers, so
  neither a split nor a transfer cancels an offer by accident.
- `verifyOffer` checks the SPV proof of `sourceBeef`, the token id and exact amount of the UTXO, the signature and its
  sighash type (0xC3), and that the overlay lists the UTXO as unspent among the maker's receive keys. A bad offer
  throws `InvalidOfferError`; network failures (overlay, chain tracker) are thrown as they are, so the server can tell
  a 400 from a 503.
- `fillOffer` runs the overlay and signature checks before it asks the wallet anything. It calls `createAction`
  without the maker's unlocking script, so the wallet hands the transaction back unsigned. If input 0, its sequence,
  output 0, output 1, the version or the lockTime differ from what the maker signed, it calls `abortAction`;
  otherwise `signAction` adds the maker's unlocking script and the wallet broadcasts.
- The maker's payment key: BRC-29 (`[2, '3241645161d8']`), keyID `<base64("agentswap offer")> <base64(offer.id)>`,
  counterparty the maker's own identity key. `claimOfferPayment` fetches the fill from the overlay through its token
  output (output 1) and takes output 0 in as a `wallet payment`; wallet-toolbox also marks the sold UTXO spent.
- `swapAndPay` is `fillOffer` with the token output going to the service instead of the taker.
- Amounts are `bigint` inside core and decimal strings in `types.ts`, which does not change.

## Layout

- `src/kit/`: the developer pack's `starter/bsv21-token-kit` (`core/`, `client/` and `overlay/`, guide Appendix A),
  copied with a source note. The only change: `signWalletP2pkhInput` takes an optional sighash `scope`.
- `src/context.ts`, `src/tokens.ts`, `src/offers.ts`: the functions above, on top of the kit's `TokenKit`.
- Tests: Vitest on wallet-toolbox's mock chain with the overlay in-process, like the kit. `test/offers.test.ts`:
  create → verify → fill, a changed price or payee is refused, a fill after a cancel fails, the maker claims the
  payment, an exact UTXO is listed without a split, `sendTokens` leaves open offers alone, and a fill is aborted when
  the wallet changes the layout. They need `@bsv/wallet-toolbox`, `@bsv/overlay` and `@bsv/overlay-express` at the
  versions in AGENTS.md, plus knex and better-sqlite3, as devDependencies.
- A testnet script deploys USDx and prints the WhatsOnChain links.

## FlashCrowd

`src/htlc.ts`, `src/collective.ts` and `src/spendPolicy.ts` (docs/FLASHCROWD_TASK.md). HTLC functions take an
`HtlcContext` (`wallet`, `network`, `originator?`): no overlay.

| Function                                                           | Who               | What                                                                                    |
| ------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------- |
| `newSecret()`, `encryptResource(K, data)`                          | seller            | fresh K, H = sha256(K); AES-256-GCM ciphertext and its hash                             |
| `signTerms(ctx, terms)` / `verifyTerms(terms)`                     | seller / everyone | seller identity signature over the terms, incl. the shares                              |
| `prepareContribution(ctx, terms)`                                  | buyer             | `{ contribution, beef }`: funding signed, not sent (noSend)                             |
| `signRefund(ctx, terms, contribution)`                             | seller            | refund pre-signature, sighash 0xC2, nLockTime = refundHeight                            |
| `verifyRefundSignature(terms, c, sig)`                             | buyer             | local check, no wallet                                                                  |
| `broadcastContribution(ctx, terms, c, beef)`                       | buyer             | sends only with a valid refund signature; `BroadcastError` otherwise                    |
| `abandonContribution(ctx, c)`                                      | buyer             | `abortAction` when no refund signature comes                                            |
| `verifyFunding(terms, c, chainTracker?)`                           | seller, server    | SPV (Arcade by default) + the agreed output                                             |
| `claimContributions(ctx, terms, K, contributions)`                 | seller            | one transaction, one input per share; refused from `refundHeight - CLAIM_MARGIN_BLOCKS` |
| `secretFromClaim(terms, claimTx)`, `decryptResource(terms, K, ct)` | buyer             | K from the claim, then the data                                                         |
| `refundContribution(ctx, terms, c)`                                | buyer             | after refundHeight; before it the wallet refuses (not final)                            |
| `splitPrice`, `openGroup`, `matchIntents`, `advanceGroup`          | server            | pure matching and state machine (`IllegalTransitionError`)                              |
| `checkSpend`, `assertSpend`                                        | agent             | hard limits before every funding signature (`SpendPolicyError`)                         |

- HTLC keys: `[1, 'flashcrowd htlc']`, keyID = groupId, counterparty `'anyone'`, so anyone derives a party's key
  from its identity key (`htlcKeyOf`). Terms: `[1, 'flashcrowd terms']`, same keyID and counterparty.
- Each buyer funds its own output; the claim is atomic, funding is not. If a buyer never funds, the seller does not
  claim and the funded buyers refund after refundHeight. A revealed key proves disclosure, not data quality.
- Claim margin: `claimContributions` refuses from `refundHeight - CLAIM_MARGIN_BLOCKS` (2 blocks), so a claim has
  `CLAIM_MARGIN_BLOCKS + 1` blocks to be mined before a refund can be. The seller (the server) picks `refundHeight`
  above the current height + `CLAIM_MARGIN_BLOCKS` + the blocks the buyers need to fund.
- Tests on the mock chain only (`test/htlc.test.ts`, `test/collective.test.ts`, `test/spendPolicy.test.ts`); no
  testnet transaction yet.

The transaction layout, the overlay and the key choices are in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#atomic-offer).

## Testnet check

`scripts/testnet-htlc.ts` runs the HTLC on chain with three wallet-toolbox wallets (seller, buyer-1, buyer-2) whose
key files and SQLite databases live in `~/.agentswap/htlc`, outside the repo. Arcade is the first broadcaster.

It runs on testnet unless the shell sets `BSV_NETWORK=mainnet` (the root `.env` is not read). The BSV Association
funds teams with mainnet sats, so the check can run there too: mainnet keeps its own keys and state in
`~/.agentswap/htlc-mainnet`, and `run` says what it will spend and waits 10 s before the first transaction. Send the
script's wallets only what a run needs, not the team's funds.

```bash
npm run testnet:htlc -w @agentswap/core -- init                  # key files, identity keys, buyer-1's deposit address
npm run testnet:htlc -w @agentswap/core -- sweep <txid>.<vout>   # a mined deposit into buyer-1's wallet
npm run testnet:htlc -w @agentswap/core -- run                   # a), b) and c) below, then a table for issue #2
npm run testnet:htlc -w @agentswap/core -- refund                # refunds what is left, after refundHeight
BSV_NETWORK=mainnet npm run testnet:htlc -w @agentswap/core -- init   # the same on mainnet
```

- a) Two buyers fund group A and the seller, with an empty wallet, claims it.
- b) buyer-1 funds group B and sends its refund to Arcade before refundHeight: rejected, or held with the claim
  still passing or blocked. The refund pays ten times the wallets' fee rate; a refusal for the fee is reported as
  inconclusive, not as rejected.
- c) buyer-2 refunds group C after its refundHeight (start height + 1).

`run` needs about 5,500 sats in buyer-1's wallet and pays buyer-2 its part over BRC-29. Every step updates
`state.json` in the network's folder (terms, contributions, txids; no keys or secrets).
