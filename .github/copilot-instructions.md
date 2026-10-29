# AgentSwap: notes for coding agents

- Read AGENTS.md (BSV developer pack), docs/ARCHITECTURE.md and docs/TEAM.md before writing code. AGENTS.md pins the
  package versions.
- User flows go through `WalletClient` to BSV Desktop or BSV Browser. Never ask for, create in the browser, log or
  store a user's private key or recovery phrase.
- Testnet first. Broadcast through Arcade and print a WhatsOnChain link for every transaction.
- Keys and secrets stay out of prompts and the repo.
- `packages/core/src/types.ts` is the shared contract between the four parts; change it only in a reviewed pull request.
- Checks: `npm run typecheck` and `npm test` from the repo root.
