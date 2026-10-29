# apps/server (P2)

Order book API, the paid AI service behind HTTP 402, and the live feed. It relays signed offers and holds no user
keys or funds.

Run `npm run dev:server` from the repo root, then open http://localhost:8787/health or use `requests.http`
(REST Client extension). It reads the root `.env`.

To build during the event (issue #3), following the API table in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#api-draft):

- Offers: list, submit, report a fill, withdraw, quote. Validate every offer: SPV-check `sourceBeef` with
  `@bsv/sdk`, check the maker's signature, and check that the outpoint is unspent.
- Paid service: `createPaymentMiddleware` from `@bsv/402-pay/server`, backed by the server's own wallet (key file
  outside the repo, `SERVER_KEY_FILE`).
- Feed: server-sent events at `/api/feed`, fed by the routes above and by `POST /api/events` from the agent.

Packages to add, at the versions pinned in AGENTS.md: `@bsv/402-pay`, and `@bsv/simple` (server wallet) or
`@bsv/wallet-toolbox`.
