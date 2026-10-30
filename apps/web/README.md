# apps/web (P3)

The FlashCrowd web app for people. Anyone can watch the groups form, fund and settle; a person with BSV Desktop can
also fund an agent. It reads apps/server and never holds a key: every signature and payment comes from the user's
wallet through `WalletClient`.

## Run it

```bash
npm run dev:web         # from the repo root; http://localhost:5173
```

`/api` and `/health` are proxied to apps/server, so the page and the API share an origin. The target is
`SERVER_URL` from the root `.env` when it is set (for example a teammate's server behind a cloudflared tunnel),
otherwise `http://localhost:SERVER_PORT`.

Checks: `npm test -w @agentswap/web`, `npm run typecheck -w @agentswap/web`, `npm run build -w @agentswap/web`.

## Pages

**Dashboard** (`#/`), reading needs no wallet:

- Services, with price, how many buyers it can split into and the minimum share.
- One card per purchase group: status, funding bar, each buyer's share and status, and a WhatsOnChain link for every
  funding, claim and refund transaction.
- The live feed from `GET /api/feed` (server-sent events, resumed with `Last-Event-ID`).
- The cards reload on every feed event and every 5 s, so they move even when a tunnel holds the feed back.
- When the server cannot be read, the page shows sample data labelled **Simulation**, with the reason and a retry
  button. Sample data never contains a txid, so the page never shows a transaction that does not exist.

**Fund an agent** (on the dashboard, after Connect wallet): the user's wallet pays an agent's identity key with
BRC-29 (`createBrc29Payment` from core). The page then downloads a payment file and keeps a copy in the browser; the
agent takes the payment in with `npm run wallet -w @agentswap/agent -- receive <key file> <payment file>`. Without the
file the agent cannot see the payment. Amounts are 1,000 to 100,000 sats.

**Wallet checks** (`#/checks`): the four wallet calls FlashCrowd needs, made exactly as core makes them. All four pass
in BSV Desktop 3.3.1:

| Check                                                        | Used by core for                         |
| ------------------------------------------------------------ | ---------------------------------------- |
| `createSignature({ hashToDirectlySign })`, `flashcrowd htlc` | the seller's refund and claim signatures |
| `createSignature({ data })`, `flashcrowd terms`              | the seller's signed terms                |
| `createAction` with an HTLC output and `noSend`              | a buyer's funding, signed but not sent   |
| `createAction({ sendWith })`                                 | broadcasting that funding                |

A banner on every page warns when the wallet and the server are on different networks; the page reads the wallet's
network again whenever the user comes back to it.

## Files

| File                                    | What                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `src/wallet.ts`                         | Connect wallet through `WalletClient` (BSV Desktop or BSV Browser)       |
| `src/api.ts`                            | Every request to apps/server, and the feed subscription                  |
| `src/useDashboard.ts`                   | Live data, reloads, and the fallback to simulation data                  |
| `src/model.ts`                          | The API's shapes and the helpers that turn them into what the page shows |
| `src/mock.ts`                           | Simulation data, same shapes as the API, no txids                        |
| `src/funding.ts`, `src/FundAgent.tsx`   | Fund an agent and its payment file                                       |
| `src/checks.ts`, `src/WalletChecks.tsx` | The wallet checks                                                        |
| `public/manifest.json`                  | BRC-73 group permissions: `flashcrowd htlc`, `flashcrowd terms`, BRC-29  |

## Limits

- On `localhost` BSV Desktop does not load the manifest's group permissions and asks for each protocol on first
  use, likely because the SDK drops the port from the app's origin. Not yet tried on an address without a port.
- No "Join group" button yet: a user's refund from BSV Desktop is still to be tested first.
- Through a cloudflared tunnel the feed opens but delivers no events; the 5 s reload keeps the cards current.
