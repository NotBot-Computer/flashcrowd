# apps/web (P3)

The React app for people: connect BSV Desktop or BSV Browser, swap, list tokens, and fund and watch the agent.

Run `npm run dev:web` from the repo root and open http://localhost:5173. Requests to `/api` are proxied to
apps/server.

Already here:

- `src/wallet.ts`: Connect wallet through `WalletClient`, following the official sample in
  [bsv-ai-toolkit](https://github.com/bsv-blockchain/bsv-ai-toolkit/tree/main/samples/tipping-shape-a).
- `public/manifest.json`: BRC-73 group permissions, so the user approves once at Connect wallet. Update its
  protocols, baskets and allowance to match what packages/core uses. Protocol and basket names take lowercase
  letters, digits and single spaces only.

To build during the event (issue #4): the Swap, Sell and Agent pages, a network mismatch banner, and the live
transaction feed from `/api/feed`.
