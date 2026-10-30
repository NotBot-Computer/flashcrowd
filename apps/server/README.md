# apps/server (P2)

The FlashCrowd coordinator and the mock seller. The coordinator keeps intents and groups, calls core in the right
order and publishes the live feed. It never holds a buyer's key or money. The mock seller is a separate module with
its own wallet, and it receives the claims.

## Setup

```sh
npm install
cp .env.example .env
npm run wallet:init -w @agentswap/server   # creates two key files outside the repo; paste the printed lines in .env
npm run dev:server                         # http://localhost:8787/health
```

| Variable             | Default                    | Meaning                                                                 |
| -------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `SERVER_KEY_FILE`    | required                   | The coordinator's BRC-103 identity. It only signs messages, no coins    |
| `SELLER_KEY_FILE`    | required                   | The mock seller's wallet. It needs no funds: a claim pays from the HTLC |
| `SERVER_DATA_DIR`    | `~/.agentswap/server-data` | State, the seller's secrets and the seller's wallet database            |
| `SERVER_PORT`        | `8787`                     |                                                                         |
| `SELLER_LOCK_BLOCKS` | `6`                        | `refundHeight` = height at matching + this. Must be above 2             |
| `SELLER_NO_CLAIM`    | `false`                    | `true` for the refund demo: the seller never claims                     |

For a public demo URL: `cloudflared tunnel --url http://localhost:8787`.

Tests: `npm test -w @agentswap/server` (mock chain, real wallets, real HTTP and BRC-103). `requests.http` has the open
routes for the REST Client extension.

## API

**Proposal: P1 and P4 still have to approve it** (plan, P2 step 3). Types are from `packages/core/src/types.ts`.

Reading is open. Every `POST` needs a BRC-103 request (`AuthFetch`): the caller's identity is always the signed one,
and any identity in a body is ignored or refused. `AuthFetch` also works on the open routes, except the SSE feed. Errors
are `{ "error": string }`: 400 bad input, 401 not signed, 403 not yours, 404 unknown, 409 wrong state, 422 failed a
core check, 503 chain unreachable.

| Endpoint                             | Body                                                               | Reply                                                                           |
| ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /health`                        |                                                                    | `{ ok, service, network, height }`                                              |
| `GET /api/services`                  |                                                                    | `ServiceOffer[]`                                                                |
| `POST /api/intents`                  | `NewIntent`                                                        | 201 `{ intent: PurchaseIntent, group?: Group }`: `group` once matched           |
| `GET /api/intents`                   |                                                                    | `PurchaseIntent[]`                                                              |
| `GET /api/groups?intentId=`          |                                                                    | `PurchaseGroup[]`, without ciphertext and BEEFs                                 |
| `GET /api/groups/:id`                |                                                                    | `Group` = `PurchaseGroup` + `transactions` (see below)                          |
| `POST /api/groups/:id/authorize`     | `{}`                                                               | `PurchaseGroup`                                                                 |
| `POST /api/groups/:id/contributions` | `FundingContribution` from `prepareContribution`, **without BEEF** | `{ refundSignature, contribution }`                                             |
| `POST /api/groups/:id/funding`       | `FundingContribution` from `broadcastContribution`, with BEEF      | `PurchaseGroup`                                                                 |
| `GET /api/groups/:id/settlement`     |                                                                    | `{ groupId, status, refundHeight, refundAvailable, claim?, claimTx?, refunds }` |
| `POST /api/groups/:id/refunds`       | `{ txid }`                                                         | `PurchaseGroup`                                                                 |
| `GET /api/feed`                      |                                                                    | SSE, see below                                                                  |
| `GET /api/feed/history?after=<id>`   |                                                                    | The feed's events after `id` (all without it), oldest first, as JSON            |
| `POST /api/events`                   | `{ message, txid? }`                                               | 201 the published event                                                         |

Three routes go beyond the plan's table, because the flow needs them:

- `GET /api/groups?intentId=`: an agent finds its group. It may not be the group named after its own intent.
- `POST /api/groups/:id/refunds`: nothing else tells the server about a refund. It looks the transaction up on the
  network and checks that it spends the caller's contribution with the refund's nLockTime.
- `claimTx` in the settlement: `secretFromClaim` reads K from this transaction, so a buyer need not trust the server.

`transactions` is `{ kind: 'funding' | 'claim' | 'refund', txid, wocUrl, identityKey? }[]`, only for sent transactions.

Feed events are `FeedEvent` plus `id` and, with a `txid`, `wocUrl`. They arrive as plain SSE messages
(`EventSource.onmessage`), the last 200 first. `POST /api/events` always publishes type `agent` under the caller's key,
so an agent cannot fake a claim in the feed. A `trycloudflare` quick tunnel holds back the event stream, so clients behind one poll `/api/feed/history`. Never take a `wocUrl` from a client.

### An agent's calls

1. `POST /api/intents`, then poll `GET /api/groups?intentId=` until a group appears.
2. `GET /api/groups/:id` until it has `terms`; `verifyTerms` and `assertSpend`; `POST .../authorize`.
3. Poll until the status is `committed`: until everyone has accepted, contributions get a 409.
4. `prepareContribution`; `POST .../contributions`; `verifyRefundSignature`; `broadcastContribution`; `POST .../funding`.
5. Poll `GET .../settlement`. On `claimed`: `secretFromClaim(terms, claimTx)`, `decryptResource(terms, K, ciphertext)`.
6. On `refundAvailable`: `refundContribution`, then `POST .../refunds`. A 409 means the network does not know it yet:
   retry.

## Behaviour worth knowing

- **Group ids and intents.** A matched intent stays in its group; if the group expires, its intents expire and the
  agents post new ones.
- **Small intents.** `matchIntents` fails outright when a share would fall below 1,000 sats. The server leaves the
  smallest intent out and tries again, so it cannot block a service. It stays open for a later group.
- **`refund_available` comes one block after `refundHeight`.** core's state machine waits for it, because wallet-toolbox
  refuses a transaction until `nLockTime < height`.
- **Claim margin.** `claimContributions` stops 2 blocks before `refundHeight` (`CLAIM_MARGIN_BLOCKS` in core).
- **Claim failures.** Network errors are retried by the 30-second ticker, 3 attempts in all; then `settlement_failed`.
- **Expiry.** With no refund signature issued the group is `expired`. After one, a buyer may have broadcast, so the group
  becomes `funding_failed` and waits for the refund height.
- **Restart.** State is written to `state-<network>.json` on every change and read at startup. K is in a separate
  owner-only file and never in the state, a reply or the log. A locked group with no claim is claimed after a restart.

## Limits

- The money path has run on mainnet through this server: a claim and three refunds, in the root README's table.
- If the process dies between the claim's broadcast and saving it, the retry fails and the group shows
  `settlement_failed` even though the claim is on chain.
- BRC-103 identities are free, so auth does not stop spam: there are no rate limits, and every change rewrites the state
  file. Fine for a demo, not for an open deployment.
- A revealed key proves disclosure, not data quality. The dataset is labelled as a simulation.
