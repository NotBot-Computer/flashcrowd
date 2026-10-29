# Submission checklist

Deadline: **Saturday 31 October, 15:00**, on Devfolio. Only what is submitted by then is judged.

## Every team

- [ ] Demo video, at most 2:30 (P3)
- [ ] Devfolio description: problem, what we built, how it works (P4)
- [ ] Public repository with a README covering setup and running (P2)

## BSV track

- [ ] Links to example transactions on WhatsOnChain (P1, table in the README)
- [ ] The video shows the project end to end, including the agent payment (P3)
- [ ] The description covers the problem, target users, usage and what it brings to BSV (P4)

## Qualification (judges check these first)

- [ ] Built with the BSV SDK (and Wallet Toolbox where needed) from ts-stack, at the versions in AGENTS.md
- [ ] User flows connect to BSV Desktop or BSV Browser through `WalletClient`
- [ ] Real transactions on BSV (testnet or mainnet), broadcast through Arcade
- [ ] Non-custodial wherever user funds are involved
- [ ] At least one AI agent makes a payment through the project

## Before 14:30

- [ ] No keys or secrets in the repo or its history: `git log -p | grep -inE "xprv|mnemonic|seed phrase|private key|sk-ant"`
- [ ] Make the repo public: `gh repo edit NotBot-Computer/agentswap-bsv --visibility public --accept-visibility-change-consequences`
- [ ] Choose up to three tracks on Devfolio (BSV Association, plus any other that fits)
- [ ] Rehearse the live demo for judging (15:00–17:00) and keep the video as a backup

## Devfolio text skeleton

- **Problem:** …
- **What we built:** …
- **How it works:** …
- **Target users:** …
- **What it brings to BSV:** …
- **Transactions:** WhatsOnChain links …
- **Video and repository:** …
