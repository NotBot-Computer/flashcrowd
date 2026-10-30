# apps/agent (P4)

FlashCrowd agents: each has its own BRC-100 wallet, a hard spend policy, and buys a dataset together with other
agents through the coordinator (apps/server). The plan is in [docs/FLASHCROWD_PLAN.md](../../docs/FLASHCROWD_PLAN.md).

- `src/flow.ts`: `runPurchase`, one purchase, step by step: search → intent → match → evaluate → authorize → fund →
  settle → decrypt, or refund. Deterministic: `verifyTerms` and `checkSpend` / `assertSpend` decide before anything is
  signed, and the funding is broadcast only with a valid refund signature from the seller. Once funded, the agent
  waits for the claim or the refund height; it never walks away from locked money. An LLM may narrate the steps but
  never decides an amount or a signature.
- `src/coordinator.ts`, `src/httpCoordinator.ts`: the server's API (apps/server/README.md, #13), one method per
  endpoint. Reads use plain fetch; every POST is a BRC-103 request signed by the agent's wallet (`AuthFetch`). After a
  refund the agent reports it (`POST /api/groups/:id/refunds`), retrying while the server answers 409.
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
  prints each agent's identity, deposit address and whether its balance covers its offer plus fees. Without `--check`
  every agent buys from the server at `SERVER_URL` at the same time (`runAgents`), and each result is printed with
  WhatsOnChain links; it stops first if an agent lacks funds.
- `src/receive.ts` and `npm run wallet -w @agentswap/agent -- receive <key file> <payment file>`: the web app's "Fund the
  agent" pays the agent's identity key with BRC-29 and downloads a payment file (`kind: "flashcrowd agent funding"`).
  The agent refuses a file for another agent or another network, checks the payment with SPV against Arcade and that
  it is locked to its own key (core's `acceptBrc29Payment`), takes it in and prints the sats, txid and WoC link.
- `src/narrate.ts` (optional): with `AGENT_NARRATE=1`, Claude (`claude-opus-5-5` by default, `AGENT_NARRATE_MODEL` to
  change it) turns each kind of step into one plain sentence in the terminal, about six per round. It only describes
  what the code already did: it never decides an amount, a signature or a group, the agents never wait for it, and if
  it fails (no `ANTHROPIC_API_KEY`, rate limit) it says so once and the round goes on. Off by default.
- `src/ledger.ts`: each agent's committed sats in `agent-N.<network>.spent.json` next to its key file, so `maxTotalSats` holds
  across runs. A share counts once its funding is broadcast; a refunded share stops counting.
- After funding, the agent never walks away from locked money: if the coordinator is unreachable it keeps asking, and
  above the refund height it refunds on its own. The ledger also keeps the terms and the contribution with the
  seller's refund signature, so if the process dies, `npm run wallet -w @agentswap/agent -- refund <key file>`
  (`src/recover.ts`) refunds every share still marked funded once the chain is above its refund height.
- Purchase runs start wallet-toolbox's Monitor (`openAgentWallet({ monitor: true })`): proofs for the wallet's
  transactions and rebroadcasts. Our own transactions are broadcast right away, so short commands skip it.

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

`test/server.test.ts` starts apps/server the way its own tests do and runs three agents through it over HTTP and
BRC-103, plus a refund run with a seller that never claims.

Next: the testnet run (funded agents, the server on testnet), optional LLM narration.
