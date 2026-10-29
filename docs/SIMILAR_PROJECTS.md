# Similar projects on GitHub

Searched on 29 Oct 2026 for: "bsv agent payment", "bsv ai agent", "bsv agentic", "bsv defi", "bsv swap",
"bsv-21 token", "bsv x402", "bsv mcp", "BRC-100 wallet agent", "bsv dex", "bsv amm", "bsv atomic swap", "ordlock",
"bsv launchpad", "bsv stablecoin", "bsv bridge", plus the bsv-blockchain and b-open-io organisations.

**Bottom line:** nothing on GitHub combines a non-custodial swap with agent payments through BRC-100 wallets.
Existing projects are payments only (x402 paywalls, agent-to-agent payments) or developer tooling. The DeFi layer for
agents is open, which helps on originality.

## Closest projects

| Repo                                                                                                                                                                                         | What it does                                                                                           | Difference from AgentSwap                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [l44k/bsv-agent-payments](https://github.com/l44k/bsv-agent-payments)                                                                                                                        | Agents negotiate prices and pay each other with BSV testnet micropayments (bachelor's thesis prototype) | Payments only, no DeFi; key-based wallets instead of BRC-100            |
| [BSVKey/x402-paywall](https://github.com/BSVKey/x402-paywall)                                                                                                                                | x402 paywall for any HTTP API, settled in BSV through a facilitator                                    | Payments only; we use the official BRC-121 package `@bsv/402-pay`       |
| [ruidasilva/x402-gateway](https://github.com/ruidasilva/x402-gateway), [sgbett/bsv-x402](https://github.com/sgbett/bsv-x402), [Ruthheasman/BSV-x402-Starter](https://github.com/Ruthheasman/BSV-x402-Starter) | More x402 gateways and clients for BSV                                                                 | Same as above                                                            |
| [Calhooon/DolphinMilkShake](https://github.com/Calhooon/DolphinMilkShake)                                                                                                                    | Earlier hackathon project: 90 autonomous agents, 1.6M+ mainnet transactions, a BRC-100 identity each   | A scale demo without DeFi; a good model for a WoC-linked demo dashboard |
| [kryp2/bitcoin-agent-wallet](https://github.com/kryp2/bitcoin-agent-wallet)                                                                                                                  | BRC-100 wallet primitive for agents that wraps `@bsv/wallet-toolbox` (npm package)                     | A possible building block for P4; check its versions against AGENTS.md  |
| [Nikitich2033/BSV_AMM](https://github.com/Nikitich2033/BSV_AMM)                                                                                                                              | Small AMM experiment from 2024 with an almost empty README                                             | Inactive; no wallet or agent integration                                 |
| [ORDNET/ORDnet-Swap](https://github.com/ORDNET/ORDnet-Swap)                                                                                                                                  | Self-hosted DOGE/LTC → BSV swap with a deposit address per order                                       | Cross-chain, and the operator holds deposits                             |

## Useful tooling (not competitors)

| Repo                                                                                   | Use                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [bsv-blockchain/ts-stack](https://github.com/bsv-blockchain/ts-stack)                  | The official TypeScript stack: SDK, wallet-toolbox, `@bsv/402-pay`, overlays, `create-bsv-app`               |
| [bsv-blockchain/bsv-ai-toolkit](https://github.com/bsv-blockchain/bsv-ai-toolkit)      | Official BSV AI DevKit: `@bsv/mcp`, the `bsv-dev` skill, guardrails, and the `tipping-shape-a` sample our wallet connection follows |
| [b-open-io/1sat-sdk](https://github.com/b-open-io/1sat-sdk)                            | 1Sat Ordinals and BSV-21 SDK and CLI (community)                                                             |
| [opldotdev/bsv-mcp](https://github.com/opldotdev/bsv-mcp)                              | MCP server so coding assistants can look up transactions and addresses (community)                           |
| [b-open-io/bsv-skills](https://github.com/b-open-io/bsv-skills)                        | Claude Code plugin for BSV (community)                                                                       |

The track page says the community bOpen tools are optional and that the developer pack wins when they disagree.
