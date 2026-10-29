# packages/core (P1)

On-chain logic shared by web, server and agent: the USDx demo token, atomic offers (create, fill, cancel), broadcast
and explorer links.

- `src/types.ts`: the contract between the four parts (`Offer`, `Quote`, `FeedEvent`, `SpendPolicy`).
- `src/config.ts`: network, Arcade hosts and WhatsOnChain links.

Tests: `npm test -w @agentswap/core`.

To build during the event (issue #2): `deployToken`, `mintToken`, `createOffer`, `fillOffer`, `cancelOffer`, and
the stretch goal `swapAndPay`. Each takes a `WalletInterface` from `@bsv/sdk`, so the same code runs against BSV
Desktop in the browser and against the agent's wallet-toolbox wallet. Follow the developer pack's
`starter/bsv21-token-kit` and `BSV_STACK_COMPLETE_GUIDE.md`; the transaction layout is in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#atomic-offer).
