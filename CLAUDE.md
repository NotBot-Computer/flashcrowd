@AGENTS.md

# AgentSwap: notes for coding agents

- Hackathon project for the BSV Association track (TUM Blockchain & AI Hackathon, 30–31 Oct 2026). Read
  docs/ARCHITECTURE.md and docs/TEAM.md before writing code.
- AGENTS.md (from the BSV developer pack) is the source of truth for the BSV stack and package versions. Prefer the
  tested code in dev-pack/BSV_STACK_COMPLETE_GUIDE.md (Appendix A) over code from memory.
- User flows go through `WalletClient` to BSV Desktop or BSV Browser. Never ask for, create in the browser, log or
  store a user's private key or recovery phrase.
- Testnet first. Broadcast through Arcade and print a WhatsOnChain link (`wocTxUrl` in packages/core) for every
  transaction.
- Keys and secrets stay out of prompts and the repo: `.env` is gitignored and wallet key files live outside the repo.
- Ownership: packages/core = P1, apps/server = P2, apps/web = P3, apps/agent = P4. `packages/core/src/types.ts` is
  the shared contract; change it only in a pull request the team knows about.
- Checks: `npm run typecheck` and `npm test` from the repo root.
