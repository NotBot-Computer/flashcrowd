# AgentSwap

**Swap-and-pay rails for AI agents on BSV.** Non-custodial atomic swap offers for BSV-21 tokens, a pay-per-call
(HTTP 402) service, and an AI agent with its own BRC-100 wallet that swaps and pays by itself. Every step is
verifiable on WhatsOnChain.

Built at the [TUM Blockchain & AI Hackathon 2026](https://hackathon.tum-blockchain.com) (Munich, 30–31 October 2026)
for the **BSV Association track: DeFi Rails for Agentic Payments**.

> **Status:** scaffold. Following the hackathon rules, the product is built during the event (from Friday 30 October, 09:00).

## The problem

AI agents pay for APIs, data and compute per call. Services want to price in a stable unit or in their own credit
token, while agents and users hold BSV. Today that takes a custodial exchange, an account or a credit card, and none
of those fit autonomous, high-frequency micropayments.

## What AgentSwap does

1. **Atomic offers.** A maker signs "N tokens for P sats" from their own wallet as a partial transaction
   (SIGHASH_SINGLE | ANYONECANPAY). A person or an agent fills it in one transaction. No escrow and no custody;
   the maker cancels by spending the token UTXO.
2. **Order book.** A key-less relay that validates offers, lists them and streams fills.
3. **Paid AI service.** An HTTP 402 endpoint priced per call (BRC-121, `@bsv/402-pay`).
4. **The agent.** An LLM agent with its own BRC-100 wallet and a hard spend policy: it finds the cheapest offer,
   swaps, then pays per call.
5. **Web app.** Connects to BSV Desktop or BSV Browser through `WalletClient` to swap, list tokens, and fund and
   watch the agent.

## Track requirements

| Requirement                                   | AgentSwap                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| BSV SDK and Wallet Toolbox (ts-stack)         | `@bsv/sdk` throughout; wallet-toolbox for the agent's and the server's wallets |
| A standard BSV wallet for user flows          | `WalletClient` → BSV Desktop / BSV Browser; keys never leave the wallet       |
| Real transactions                             | Testnet, broadcast through Arcade (links below)                               |
| Non-custodial                                 | Users sign their own swaps; the order book holds no keys or funds             |
| An AI agent pays through the project          | The agent swaps and pays the 402 service from its own wallet                  |

## Repository layout

```
packages/core   on-chain logic: demo token, atomic offers
apps/server     order book API, paid 402 service, live feed
apps/web        React app: wallet connection, Swap / Sell / Agent pages
apps/agent      AI agent: own wallet, spend policy, tools
docs/           architecture, team plan, similar projects, submission checklist
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the flows and the custody model.

## Setup

Prerequisites: Node.js 22 or newer, [BSV Desktop](https://desktop.bsvb.tech) on testnet (or
[BSV Browser](https://mobile.bsvb.tech)), testnet coins, and the BSV developer pack (`AGENTS.md` in the repo root).

```bash
npm install
cp .env.example .env
npm run dev:server   # http://localhost:8787/health
npm run dev:web      # http://localhost:5173
npm run dev:agent
```

In VS Code: **Terminal → Run Task → dev: all**. Checks: `npm run typecheck` and `npm test`.

## Example transactions (WhatsOnChain)

| Step                         | Transaction |
| ---------------------------- | ----------- |
| USDx deploy and mint         | _tbd_       |
| Offer listed by a maker      | _tbd_       |
| Offer filled by a person     | _tbd_       |
| Agent swap                   | _tbd_       |
| Agent pays the 402 service   | _tbd_       |

## Demo

Video (≤ 2:30): _tbd_

## Team

| Name | Area           |
| ---- | -------------- |
| _…_  | On-chain core  |
| _…_  | Backend        |
| _…_  | Frontend       |
| _…_  | AI agent       |
