# Team plan: AgentSwap (BSV Association track)

> **Superseded.** This is the plan for our first idea, AgentSwap. On 30 October the team switched to FlashCrowd:
> see the [README](../README.md), [FLASHCROWD_TASK.md](FLASHCROWD_TASK.md) and
> [FLASHCROWD_PLAN.md](FLASHCROWD_PLAN.md). The folders, owners and issues below still hold; the product work does
> not.

> **Hackathon rule** (FAQ): "Can I start building before the event? No. Build during the hackathon."
> Libraries and starter templates are allowed, but the core build has to happen during the event. This repo
> therefore holds only the scaffold, this plan and the task split. Product code starts **Fri 30 Oct, 09:00**.

## 1. The idea (confirm as a team by 09:30 on Friday)

**AgentSwap: swap-and-pay rails for AI agents on BSV.**

- **Problem.** AI agents pay for APIs, data and compute per call. Services want to price in a stable unit or in
  their own credit token, while agents and users hold BSV. Today that takes a custodial exchange, an account or a
  credit card, and none of those fit autonomous, high-frequency micropayments.
- **DeFi layer.** Non-custodial atomic swap offers for BSV-21 tokens. A maker signs "N tokens for P sats" as a
  partial transaction (SIGHASH_SINGLE | ANYONECANPAY). A person or an agent fills it in one transaction. No escrow
  and no funds on our server; the maker cancels by spending the token UTXO.
- **Agent payment.** An LLM agent with its own wallet and a hard spend limit buys tokens on AgentSwap when a service
  asks for them, then pays the service per call over HTTP 402. Stretch goal: swap and payment in **one**
  transaction ("swap-and-pay").
- **Why BSV.** Fees low enough for per-call payments, BRC-100 wallets that keep keys with their owner, and every
  payment verifiable on WhatsOnChain.

How it maps to the judging criteria: a DeFi product (the swap) · brings liquidity (makers list tokens) · the
official TypeScript stack (`@bsv/sdk`, wallet-toolbox, `@bsv/402-pay`) · non-custodial · a real agent payment ·
original (no BRC-100 agent swap exists on GitHub, see [SIMILAR_PROJECTS.md](SIMILAR_PROJECTS.md)) · an easy demo.

If the team picks another idea, the split below still holds: it follows the layers, not the feature.

## 2. Four equal parts

|                 | **P1: On-chain core**                                                     | **P2: Backend**                                               | **P3: Frontend**                                               | **P4: AI agent**                                                    |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Folder          | `packages/core`                                                           | `apps/server`                                                 | `apps/web`                                                     | `apps/agent`                                                        |
| Owner (GitHub)  | @NotBot-Computer                                                          | @efekaansalici07-design                                       | @Metehan02                                                     | @efeberkinaslan07-rgb                                               |
| Product work    | USDx demo token, BSV-21 overlay, create / fill / cancel offers, broadcast | Order book API, offer validation, paid 402 service, live feed | Wallet connection, Swap / Sell / Agent pages, transaction feed | Agent wallet, spend policy, tools (find offer, swap, pay), LLM loop |
| Submission work | WhatsOnChain link table in the README                                     | README setup section, demo environment                        | Demo video (≤ 2:30)                                            | Devfolio description, pitch for the judges                          |
| Rough effort    | ~18 h                                                                     | ~18 h                                                         | ~18 h                                                          | ~18 h                                                               |
| Issue           | #2                                                                        | #3                                                            | #4                                                             | #5                                                                  |

Shared: #1 (setup, everyone) and #6 (submission, everyone).

### P1: On-chain core (`packages/core`)

Goal: tested on-chain functions the other three call.

- [ ] Copy `AGENTS.md` from the developer pack to the repo root; align package versions with it (now `@bsv/sdk 3.2.1`).
- [ ] Study `starter/bsv21-token-kit` (38 tests) and adapt its deploy, mint and transfer flows.
- [ ] Run the kit's BSV-21 overlay as `apps/overlay` on testnet (Arcade block headers): token balances and offer checks read from it.
- [ ] Deploy and mint **USDx** (demo token, no real value) on testnet → first WhatsOnChain link.
- [ ] `createOffer()`: the maker's SIGHASH_SINGLE | ANYONECANPAY signature over the token UTXO through `wallet.createSignature` → `Offer`.
- [ ] `fillOffer()`: the taker's `wallet.createAction` (input 0 = the maker's UTXO with its ready unlocking script, output 0 = payment to the maker, token output to the taker, `randomizeOutputs: false`).
- [ ] `cancelOffer()`: the maker spends the UTXO back to themselves.
- [ ] Stretch: `swapAndPay()`, one transaction that sends the bought tokens straight to the service.
- [ ] Vitest unit tests (scripts, sighash) and a testnet script that prints WoC links.

Provides `@agentswap/core` ([API](../packages/core/README.md#api)) and the contract in `packages/core/src/types.ts`.
Uses a `WalletInterface`: BSV Desktop in the browser, wallet-toolbox in the agent.

### P2: Backend (`apps/server`)

- [ ] Friday 09:00: request test coins from the BSV support contact (Telegram) with the team name and a BSV address.
- [ ] `GET/POST /api/offers`, `GET /api/quote`, `POST /api/offers/:id/filled`, `DELETE /api/offers/:id` (in memory first, then SQLite or a JSON file).
- [ ] Offer validation: SPV check of `sourceBeef` with `@bsv/sdk`, the maker's signature, and that the outpoint is unspent.
- [ ] Paid AI service `POST /api/service/summarize` behind `@bsv/402-pay` (sats); stretch: priced in USDx.
- [ ] Server wallet that receives the 402 payments (`@bsv/simple/server` or wallet-toolbox), key file outside the repo.
- [ ] `GET /api/feed` (server-sent events): offers, fills, payments and agent steps, each with a WoC link.
- [ ] README "Setup" section; a reachable demo environment (deploy, or local plus a tunnel).

### P3: Frontend (`apps/web`)

- [ ] Install BSV Desktop on **testnet**; check that the scaffold's Connect wallet works.
- [ ] `public/manifest.json` (BRC-73 group permissions): protocols, baskets and the monthly allowance core needs.
- [ ] **Swap** page: open offers, Buy → `core.fillOffer` → WoC link.
- [ ] **Sell** page: token balance, create an offer → `core.createOffer` → `POST /api/offers`.
- [ ] **Agent** page: fund the agent from the user's wallet, give it a task and a budget, live feed from `/api/feed`.
- [ ] Network mismatch banner, loading and error states, a clean look for the video.
- [ ] Record and cut the demo video (screen recording + voice-over), at most 2:30.

### P4: AI agent (`apps/agent`)

- [ ] Agent wallet: a server-side wallet with its own root key (`@bsv/simple/server` or wallet-toolbox), key file outside the repo (`AGENT_KEY_FILE`).
- [ ] Spend policy (`SpendPolicy` in core): per-transaction and per-task caps and a host allowlist, enforced in code before signing.
- [ ] Tools: `get_balance`, `find_offers`, `swap`, `call_paid_api` (`create402Fetch` from `@bsv/402-pay/client`), `report`.
- [ ] LLM loop with the Claude API Tool Runner (`@anthropic-ai/sdk`, model `claude-opus-5-5`); every step goes to `/api/events`.
- [ ] First goal (M1): the agent pays the 402 service **in sats** → the first agent-payment WoC link.
- [ ] Devfolio description (problem, target users, usage, what it brings to BSV) and the pitch flow.

## 3. Timeline (Munich time, CET)

| When               | Milestone                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Fri 09:00          | Start: confirm the idea, `npm install`, `.env`, BSV Desktop on testnet                                               |
| Fri 11:30–12:00    | **BSV workshop** (everyone; bring questions about BSV-21 on testnet and `createSignature`)                           |
| **Fri 12:00 · M0** | Everyone runs `dev: all`; `AGENTS.md` in the root; test coins requested                                              |
| **Fri 18:00 · M1** | Each part works alone: USDx minted, `/api/offers` up, wallet connect + a BSV payment, the agent pays the 402 service |
| **Sat 02:00 · M2** | End-to-end swap: create an offer in the web app, fill it from the web app and from the agent                         |
| **Sat 10:00 · M3** | Full demo flow integrated; **feature freeze at 12:00**                                                               |
| Sat 12:00–14:30    | Video, README, Devfolio, WoC links, make the repo **public**                                                         |
| **Sat 15:00**      | Submission deadline on Devfolio; live judging 15:00–17:00; winners at 17:30                                          |

The venue stays open on Friday night (bring a sleeping bag).

## 4. How we work

- `main` is always demoable. One branch per task: `p1/mint-usdx`, `p3/swap-page`, …
- Small pull requests with `Closes #N`. Squash-merge when CI is green; a teammate looks if there is time.
- The shared contract is `packages/core/src/types.ts` plus the API table in [ARCHITECTURE.md](ARCHITECTURE.md).
  Change it in a PR and say so in the team chat.
- Pull `main` often and resolve conflicts in your own branch.
- Never commit `.env`, keys or the developer pack (`dev-pack/` is gitignored). Wallet keys live outside the repo.
- Every new transaction: put its WoC link in the PR description. P1 collects them for the README.

## 5. First run in VS Code

1. `git clone https://github.com/NotBot-Computer/agentswap-bsv.git`, then File → Open Folder.
2. Install the recommended extensions when VS Code offers them.
3. `npm install`, then `cp .env.example .env`.
4. Download the [BSV developer pack](https://drive.google.com/drive/folders/179lAsiQEiV1Fpf9SY8b0y4456-3QfxfG) into `dev-pack/`
   and read `START-HERE.md`. P1 copies `AGENTS.md` to the root and commits it.
5. Terminal → Run Task → **dev: all** starts server, web and agent in split terminals. For breakpoints use Run and Debug:
   "Server (debug)", "Agent (debug)", "Web (Chrome)".
6. Install [BSV Desktop](https://desktop.bsvb.tech), switch it to testnet, open http://localhost:5173 and press Connect wallet.

## 6. Demo script (draft, ≤ 2:30)

| Time      | Scene                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | The problem in one sentence, AgentSwap in one sentence                                                                                               |
| 0:15–0:45 | A maker connects BSV Desktop and lists 100 USDx for N sats → WoC                                                                                     |
| 0:45–1:35 | The user funds the agent and gives it a task; the agent hits a 402, finds an offer, swaps, pays and returns the result; the feed shows each WoC link |
| 1:35–2:05 | A person buys USDx in the web app (BSV Desktop prompt) → WoC                                                                                         |
| 2:05–2:30 | Architecture and custody slide, what AgentSwap brings to BSV                                                                                         |

## 7. Risks and fallbacks

| Risk                                                                      | Fallback (decide by M1)                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| No BSV-21 indexer on testnet                                              | Our server checks USDx lineage itself (we are the only issuer), or switch to wallet-native tokens (`@bsv/btms`, or PushDrop tokens via `@bsv/simple`) |
| BSV Desktop will not produce the maker's SINGLE \| ANYONECANPAY signature | Interactive two-step swap relayed by the server: the taker builds, the maker co-signs. Still non-custodial                                            |
| Test coins arrive late                                                    | Ask in the Telegram support group at 09:00; mainnet with a few cents is allowed by the rules                                                          |
| LLM API problems                                                          | Keep every tool callable from a script so the payment flow still runs; the final video uses the LLM                                                   |
| Integration crunch                                                        | M2 is the hard integration point; after M3 only fixes                                                                                                 |
