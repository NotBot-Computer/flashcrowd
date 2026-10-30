# apps/agent (P4)

FlashCrowd agents: each has its own BRC-100 wallet, a hard spend policy, and buys a dataset together with other
agents through the coordinator (apps/server). The plan is in [docs/FLASHCROWD_PLAN.md](../../docs/FLASHCROWD_PLAN.md).

- `src/flow.ts`: `runPurchase`, one purchase, step by step: search → intent → match → evaluate → authorize → fund →
  settle → decrypt, or refund. Deterministic: `verifyTerms` and `checkSpend` / `assertSpend` decide before anything is
  signed, and the funding is broadcast only with a valid refund signature from the seller. Once funded, the agent
  waits for the claim or the refund height; it never walks away from locked money. An LLM may narrate the steps but
  never decides an amount or a signature.
- `src/coordinator.ts`: what the agent needs from the server, one method per endpoint of the plan's API table
  (`GET /api/intents/:id` is added so the agent finds its group). To agree with P2; the HTTP client with `AuthFetch`
  (BRC-103) comes once the server has the endpoints.
- `src/wallet.ts`: `openAgentWallet({ keyFile, network })`, a wallet-toolbox wallet from a key file outside the repo,
  SQLite storage next to the key file, Arcade (`ARCADE_URL`) as the broadcaster.
- `npm run wallet:init -w @agentswap/agent -- ~/.agentswap/agent-1.key`: writes a fresh key (mode 600), refuses paths
  inside the repo and existing files, prints the identity key.
- `src/funding.ts` and `npm run wallet -w @agentswap/agent -- address|sweep|balance <key file> [<txid>.<vout> …]`:
  test coins go to a deposit address (P2PKH of a key derived from the root key under `[1, 'flashcrowd deposit']`, not
  the identity key); `sweep` takes mined deposits into the wallet and broadcasts right away, printing WoC links.
  Not wallet-toolbox's `fundWalletFromP2PKHOutpoints`: it leaves the broadcast to the wallet's Monitor, so without one
  the sweep shows in the balance but never reaches the network.

- `src/config.ts`, `src/runner.ts`, `src/index.ts`: the command line. `npm run dev:agent -- --agents 3 --check` reads
  the agent settings from the root `.env` (see `.env.example`: key files, offers, spend policy; whole sats only) and
  prints each agent's identity, deposit address and whether its balance covers its offer plus fees. Without
  `--check` it will run the agents together (`runAgents`) once the server client exists; until then it says so and
  stops.

Tests: `npm test -w @agentswap/agent`, on wallet-toolbox's mock chain with a test-only in-process coordinator and mock
seller (`test/helpers/localCoordinator.ts`, not the server): three agents buy a 12,000-sat dataset and decrypt it; an
agent whose policy rejects the terms signs nothing; the budget caps the offer; with no claim, two agents refund after
the refund height; deposits are swept, an output to another address, a second sweep and an unmined deposit are
refused. No testnet transaction yet.

Funding an agent on testnet:

```bash
npm run wallet:init -w @agentswap/agent -- ~/.agentswap/agent-1.key
npm run wallet -w @agentswap/agent -- address ~/.agentswap/agent-1.key   # send test coins here
npm run wallet -w @agentswap/agent -- sweep ~/.agentswap/agent-1.key <txid>.<vout>   # after one confirmation
```

Then `npm run dev:agent -- --agents 3 --check` until every agent is ready.

Next: the `AuthFetch` coordinator against apps/server (purchase runs), feed events with WoC links, optional LLM
narration.
