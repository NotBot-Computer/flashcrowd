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

| Requirement                           | AgentSwap                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| BSV SDK and Wallet Toolbox (ts-stack) | `@bsv/sdk` throughout; wallet-toolbox for the agent's and the server's wallets |
| A standard BSV wallet for user flows  | `WalletClient` → BSV Desktop / BSV Browser; keys never leave the wallet        |
| Real transactions                     | Testnet, broadcast through Arcade (links below)                                |
| Non-custodial                         | Users sign their own swaps; the order book holds no keys or funds              |
| An AI agent pays through the project  | The agent swaps and pays the 402 service from its own wallet                   |

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

Mainnet, from the FlashCrowd HTLC check on 30 October 2026 (`packages/core/scripts/testnet-htlc.ts`, start height
973331; details in issue #2). The fundings and claims are in block 973332.

| Step                                                                                   | Transaction                                                                                               |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Buyer 1 funds its HTLC share (group A)                                                 | [cc88b393…](https://whatsonchain.com/tx/cc88b393308432becf12c66bcf6c1d4713601585ca0fa7cdbc036fffe997a35c) |
| Buyer 2 funds its HTLC share (group A)                                                 | [233452df…](https://whatsonchain.com/tx/233452df45ced2061c88d5fd0f627cca7212b4ccfb5b2f628da1286d24357dfa) |
| Seller claims both shares in one transaction and reveals the key (empty seller wallet) | [4262eb55…](https://whatsonchain.com/tx/4262eb55d451028c2af27549bcbe0134fe366cbc07db05e0182c08c9d482571f) |
| Refund before refundHeight: refused by the network (nLockTime in the future)           | `edf04c52…`, never accepted                                                                               |
| Seller's claim after the refused refund (group B)                                      | [ab6cf9da…](https://whatsonchain.com/tx/ab6cf9da48402af97a9ccd10d826904b361ad78866e47892702963f58e8ec505) |
| Buyer refunds its share after refundHeight (group C)                                   | [99de9895…](https://whatsonchain.com/tx/99de9895b6f1e2214341f0a5055e3ff379737d05a7853f615365aa53043601d0) |
| User funds the agent from BSV Desktop                                                  | _tbd_                                                                                                     |
| Three agents fund one group (demo)                                                     | _tbd_                                                                                                     |

## Demo

Video (≤ 2:30): _tbd_

## Team

| Name                    | Area          |
| ----------------------- | ------------- |
| @NotBot-Computer        | On-chain core |
| @efekaansalici07-design | Backend       |
| @efeberkinaslan07-rgb   | Frontend      |
| 4th member (tbd)        | AI agent      |
