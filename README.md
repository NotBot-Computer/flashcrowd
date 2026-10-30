# FlashCrowd

**AI agents buy a dataset together that none of them could afford alone, and the seller is paid only by revealing
the decryption key on chain.** Every agent locks its share in its own HTLC output, from its own wallet. Nobody in the
middle holds keys or money, and every step is a BSV transaction on WhatsOnChain.

> FlashCrowd coordinates autonomous agents into temporary purchasing groups and combines multi-party non-custodial
> funding with delivery-conditional settlement on BSV.

Built at the [TUM Blockchain & AI Hackathon 2026](https://hackathon.tum-blockchain.com) (Munich, 30–31 October 2026)
for the **BSV Association track: DeFi Rails for Agentic Payments**. The repository is still named `agentswap-bsv`
after our first idea; the team switched to FlashCrowd on 30 October.

## The problem

AI agents increasingly need paid data: market history, research datasets, model outputs. Many agents need the same
reusable dataset, but its price is too high for any single one of them. Pooling money today means trusting someone
to hold it, and paying first means trusting the seller to deliver.

## How it works

1. **Intents.** Each agent posts what it wants to buy and the most it will pay.
2. **Group.** The coordinator matches compatible intents into a group and splits the price into shares (exact integer
   sats, never above an agent's maximum). The seller signs the terms: shares, the hash `H = sha256(K)` of a fresh key
   `K`, the hash of the encrypted dataset, and a refund height.
3. **Check.** Each agent verifies the terms and its spend policy in code. An agent whose policy says no signs nothing.
4. **Refund first.** Each agent signs its funding transaction without broadcasting it and sends the seller only the
   outpoint. The seller pre-signs that output's refund, valid from the refund height. The agent checks the signature.
5. **Fund.** Only then does the agent broadcast its funding: one HTLC output per agent.
6. **Claim.** The seller spends all the outputs in one transaction by revealing `K`. Its wallet needs no funds; the
   claim's fee comes out of the HTLC value.
7. **Decrypt.** Every agent reads `K` from the claim transaction and decrypts the dataset.

If the seller does not claim, each agent takes its share back after the refund height with the pre-signed refund.

```
OP_IF   OP_SHA256 <H> OP_EQUALVERIFY <seller> OP_CHECKSIG          claim:  <seller sig> <K> OP_1
OP_ELSE <seller> OP_CHECKSIGVERIFY <buyer> OP_CHECKSIG              refund: <buyer sig> <seller pre-sig> OP_0
OP_ENDIF
```

BSV has no `OP_CHECKLOCKTIMEVERIFY` (it is a NOP since Genesis), so the timeout is not in the script. It is the
refund's nLockTime: the seller pre-signs the refund with `SIGHASH_NONE | ANYONECANPAY | FORKID`, and the network does
not accept the refund before its nLockTime. We checked this on mainnet (table below). Claims stop 2 blocks before the
refund height, so a claim has time to be mined before a refund can be.

## Track requirements

| Requirement                           | FlashCrowd                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| BSV SDK and Wallet Toolbox (ts-stack) | `@bsv/sdk` 3.2.1 for the scripts, keys and signatures; `@bsv/wallet-toolbox` 2.14.9 for the agents' and the seller's wallets |
| A standard BSV wallet for user flows  | `WalletClient` → BSV Desktop. BSV Desktop 3.3.1 signs and broadcasts an HTLC funding exactly as an agent does (issue #2)     |
| Real transactions                     | On mainnet, broadcast through Arcade (table below). The organizers had no testnet coins; `BSV_NETWORK` switches networks     |
| Non-custodial                         | Each share sits in its buyer's own HTLC output. The coordinator holds no keys and no money                                   |
| An AI agent pays through the project  | Three agents fund one group from their own wallets, within a spend policy enforced in code                                   |

## Repository layout

```
packages/core   on-chain logic: HTLC (htlc.ts), purchase groups (collective.ts), spend policy (spendPolicy.ts),
                the on-chain check script (scripts/testnet-htlc.ts); also the earlier BSV-21 swap code, not used here
apps/server     coordinator API with BRC-103 auth, mock seller with its own wallet, live feed (SSE)
apps/web        dashboard (services, groups, funding, WoC links, live feed) and BSV Desktop wallet checks
apps/agent      the agents: own wallet each, spend policy, the purchase flow, command line
docs/           plan, architecture, team, submission checklist
```

[docs/FLASHCROWD_TASK.md](docs/FLASHCROWD_TASK.md) has the design and its constraints,
[docs/FLASHCROWD_PLAN.md](docs/FLASHCROWD_PLAN.md) the plan (in Turkish). Each app's README has the details.

## Setup

Prerequisites: Node.js 22 or newer, [BSV Desktop](https://desktop.bsvb.tech) for the web app, and a few thousand
sats per agent. Keys live in files outside the repo, never in `.env`.

```bash
npm install
cp .env.example .env    # BSV_NETWORK=mainnet or testnet; see the comments in the file
```

Coordinator and seller (apps/server). `wallet:init` creates two key files and prints the lines to paste into `.env`:

```bash
npm run wallet:init -w @agentswap/server
npm run dev:server      # http://localhost:8787/health
```

Agents (apps/agent). Create a key per agent, send sats to its deposit address, then sweep them in after one
confirmation:

```bash
npm run wallet:init -w @agentswap/agent -- ~/.agentswap/agent-1.key
npm run wallet -w @agentswap/agent -- address ~/.agentswap/agent-1.key
npm run wallet -w @agentswap/agent -- sweep ~/.agentswap/agent-1.key <txid>.<vout>
npm run dev:agent -- --agents 3 --check   # until every agent is ready
```

Web app (apps/web):

```bash
npm run dev:web         # http://localhost:5173
```

In VS Code: **Terminal → Run Task → dev: all**. Checks: `npm run typecheck` and `npm test` (mock chain, no coins).

## Run the demo

1. Start the server and the web app, open http://localhost:5173 and connect BSV Desktop.
2. `npm run dev:agent -- --agents 3`: three agents post intents, form a group, fund their shares and wait.
3. The seller claims as soon as the group is fully funded. Each agent prints its share, the decrypted dataset's size and WoC links; the
   dashboard shows the group, the funding bar and the links.
4. Refund path: restart the server with `SELLER_NO_CLAIM=true`, run the agents again and wait `SELLER_LOCK_BLOCKS`
   blocks (about 10 minutes each). The agents refund themselves.

On-chain check of the HTLC alone, without the server: `BSV_NETWORK=mainnet npm run testnet:htlc -w @agentswap/core --
init | run | refund` (header of `packages/core/scripts/testnet-htlc.ts`).

## Example transactions (WhatsOnChain)

Mainnet, 30 October 2026. The first six are from the HTLC check (`packages/core/scripts/testnet-htlc.ts`, start
height 973331, fundings and claims in block 973332); details in issue #2. The last four are a full run through the
server: three agents bought the 12,000-sat dataset as group `group-de38ed6a…`, all in block 973335 (#21). After
them, a refund round (`group-cd001ff3…`, server started with `SELLER_NO_CLAIM=true`).

| Step                                                                                   | Transaction                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buyer 1 funds its HTLC share (group A)                                                 | [cc88b393…](https://whatsonchain.com/tx/cc88b393308432becf12c66bcf6c1d4713601585ca0fa7cdbc036fffe997a35c)                                                                                                                                                                                                                         |
| Buyer 2 funds its HTLC share (group A)                                                 | [233452df…](https://whatsonchain.com/tx/233452df45ced2061c88d5fd0f627cca7212b4ccfb5b2f628da1286d24357dfa)                                                                                                                                                                                                                         |
| Seller claims both shares in one transaction and reveals the key (empty seller wallet) | [4262eb55…](https://whatsonchain.com/tx/4262eb55d451028c2af27549bcbe0134fe366cbc07db05e0182c08c9d482571f)                                                                                                                                                                                                                         |
| Refund before refundHeight: refused by the network (nLockTime in the future)           | `edf04c52…`, never accepted                                                                                                                                                                                                                                                                                                       |
| Seller's claim after the refused refund (group B)                                      | [ab6cf9da…](https://whatsonchain.com/tx/ab6cf9da48402af97a9ccd10d826904b361ad78866e47892702963f58e8ec505)                                                                                                                                                                                                                         |
| Buyer refunds its share after refundHeight (group C)                                   | [99de9895…](https://whatsonchain.com/tx/99de9895b6f1e2214341f0a5055e3ff379737d05a7853f615365aa53043601d0)                                                                                                                                                                                                                         |
| BSV Desktop funds an HTLC (signed with `noSend`, then sent with `sendWith`)            | [30bf87f5…](https://whatsonchain.com/tx/30bf87f56a73ebc9ec3440c96900dd7c1a18b731c7e64a5f60ddf650c54c8aba)                                                                                                                                                                                                                         |
| User funds agent 1 from BSV Desktop (BRC-29, 2,000 sats); the agent takes it in        | [87f3eb85…](https://whatsonchain.com/tx/87f3eb85ff40d37fb92cb1020a04babf996c1b0cbcdbdf0514727d80c650dca7)                                                                                                                                                                                                                         |
| Agent 1 funds its share, 3,000 sats (demo group)                                       | [4c643186…](https://whatsonchain.com/tx/4c6431861b686fe8d894c18dc1a9a606c298235b318088676b89daec83d5ddf0)                                                                                                                                                                                                                         |
| Agent 2 funds its share, 4,000 sats (demo group)                                       | [227d3627…](https://whatsonchain.com/tx/227d3627044cf119784de324d8794b13895459dae2fed9f097e8bdc8d0e1642e)                                                                                                                                                                                                                         |
| Agent 3 funds its share, 5,000 sats (demo group)                                       | [f376e2a9…](https://whatsonchain.com/tx/f376e2a90e1b1b5d64b51214d207606aa9ecaee2d65f86d1783011e054c44dd2)                                                                                                                                                                                                                         |
| Seller claims all three in one transaction and reveals the key: 11,947 sats, 53 fee    | [40f2a9a4…](https://whatsonchain.com/tx/40f2a9a40caad926020e276b77e0bafdf22d24cf8d3e54fa43af01b9248afa25)                                                                                                                                                                                                                         |
| Refund round: agents 1–3 lock 4,000 sats each (the seller never claims)                | [569cf5e0…](https://whatsonchain.com/tx/569cf5e04e121a972b3853c5c8396a0c5d6c576f23f2e13faa5278430924090a) · [6241c3d7…](https://whatsonchain.com/tx/6241c3d77a6a813c9c5a9e24a6f13514df8271bfae973305f867e2c892366403) · [15ff76b8…](https://whatsonchain.com/tx/15ff76b8a95e39757ed9ed8bacb253f54452729f6eb8c7de0b817d06a61e87f0) |
| Each agent refunds its own share above block 973340 (nLockTime 973340)                 | [06b89627…](https://whatsonchain.com/tx/06b89627add350917a20293fe26d3e9f05222b3c34aff678752e97bb7808673a) · [bb20c853…](https://whatsonchain.com/tx/bb20c85362f5419852c8f78e6c75d92f5507cc65dac7fb2b42918e0384f65db3) · [7902e261…](https://whatsonchain.com/tx/7902e26110774478fc7971a852dbd61d23f1d954ec847032f4e86a24e53078f3) |

## Security and limits

- **Keys.** Users' keys stay in BSV Desktop; the web app asks it for signatures and actions only. Agent and seller
  keys are files outside the repo, never logged.
- **Spend policy in code.** Price, total budget, allowed services and the longest lock are checked before every
  signature. A language model, if one is added, may narrate but never decides an amount or a signature.
- **Key reveal proves disclosure, not quality.** The terms commit to the ciphertext's hash, so the agents get exactly
  the data they agreed to, but nothing on chain says the data is any good.
- **Funding is not atomic.** Each agent funds its own output. If one never funds, the seller cannot claim, and the
  others wait until the refund height to take their shares back: they lose time, not money.
- **Simulation data.** The mock seller sells a generated BSV/USD dataset labelled `simulation: true`.
- **Not yet tested:** a user's refund from BSV Desktop (needed before a "Join group" button in the web app; agents
  refund with wallet-toolbox, tested above). On `localhost`, BSV Desktop does not load the manifest's group
  permissions and asks for each protocol separately.

## Demo

Video (≤ 2:30): _tbd_

## Team

| Name                    | Area                                    |
| ----------------------- | --------------------------------------- |
| @NotBot-Computer        | On-chain core                           |
| @efekaansalici07-design | Backend                                 |
| @Metehan02              | Frontend                                |
| @efeberkinaslan07-rgb   | AI agent, and the FlashCrowd core (#12) |
