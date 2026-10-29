# apps/agent (P4)

The AI agent: its own BRC-100 wallet, a hard spend policy, and tools to find offers, swap and pay per call.

Run `npm run dev:agent` from the repo root. It reads the root `.env`.

To build during the event (issue #5):

- **Wallet:** a server-side wallet from the agent's own root key (`@bsv/simple/server` or `@bsv/wallet-toolbox`, at
  the versions pinned in AGENTS.md). The key file lives outside the repo (`AGENT_KEY_FILE`). The user funds it from
  BSV Desktop on the web app's Agent page.
- **Spend policy:** `SpendPolicy` from packages/core, checked in code before every signature (per-transaction cap,
  per-task cap, host allowlist). The LLM cannot override it.
- **Tools:** `get_balance`, `find_offers` (`GET /api/quote`), `swap` (core `fillOffer`), `call_paid_api`
  (`create402Fetch` from `@bsv/402-pay/client`), `report` (`POST /api/events`).
- **LLM loop:** the Claude API Tool Runner, `client.beta.messages.toolRunner()` with tools defined through
  `betaZodTool` from `@anthropic-ai/sdk/helpers/beta/zod`. Model `claude-opus-5-5` with adaptive thinking; set
  `output_config.effort` explicitly (its default is `medium`). Turn on server-side refusal fallbacks
  (`fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta).
- **First goal (M1):** the agent pays the 402 service in sats, which gives the first agent-payment WoC link.
