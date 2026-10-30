# TASK: Convert the agentswap-bsv repo to FlashCrowd (BSV track, TUM Blockchain & AI Hackathon 2026)

Repo: NotBot-Computer/agentswap-bsv (local checkout). Read AGENTS.md, CLAUDE.md, docs/ARCHITECTURE.md, docs/TEAM.md
first. AGENTS.md package versions are fixed (@bsv/sdk 3.2.1, @bsv/wallet-toolbox 2.14.9). Testnet only. Never ask
for, log or commit private keys; key files live outside the repo. Do not add AI co-author lines to commits/PRs.

## Actual repo state (verified, do not assume otherwise)

- packages/core: BSV-21 token kit (src/kit), tokens.ts, offers.ts (atomic swap), 13 mock-chain tests. Works only on
  wallet-toolbox's mock chain; no testnet transaction exists yet. KEEP IT, isolated, not on the demo path.
- apps/server: only GET /health. No offers API, no server wallet, no 402 service.
- apps/web: only "Connect wallet" via WalletClient (src/wallet.ts). Keep that flow.
- apps/agent: empty scaffold.
- Branch p1/flashcrowd-htlc holds an uncommitted spike: packages/core/test/htlc.spike.test.ts (8 passing tests).
  Use it as the reference for the HTLC mechanics below.

## Product

FlashCrowd: several AI agents need the same reusable dataset, none can afford it alone. They publish purchase
intents, a coordinator matches them into a group, each pays its share into its own conditional (HTLC) output, and
the seller gets paid only by revealing the decryption key on chain in one claim transaction. If the seller does not
claim, each buyer refunds after a block height. Originality claim (use exactly): "FlashCrowd coordinates autonomous
agents into temporary purchasing groups and combines multi-party non-custodial funding with delivery-conditional
settlement on BSV."

## Hard technical facts (from the spike — do not redesign around them)

1. BSV has NO OP_CHECKLOCKTIMEVERIFY (NOP since Genesis; @bsv/sdk's interpreter treats it as NOP). A CLTV HTLC's
   refund branch would be spendable immediately. Do not use CLTV/CSV.
2. Timeout = nLockTime of a refund transaction the SELLER PRE-SIGNS before the buyer broadcasts its funding, with
   sighash 0xC2 (NONE|ANYONECANPAY|FORKID), input sequence 0xfffffffe. wallet-toolbox refuses non-final txs
   (nLockTimeIsFinal), also on the mock chain; the network must refuse them on testnet (verify this).
3. Locking script, one output per buyer, all sharing H = sha256(K):

   ```
   OP_IF   OP_SHA256 <H> OP_EQUALVERIFY <sellerKey> OP_CHECKSIG
   OP_ELSE <sellerKey> OP_CHECKSIGVERIFY <buyerKey> OP_CHECKSIG
   OP_ENDIF
   ```

   Claim unlock: `<sellerSig> <K> OP_1`. Refund unlock: `<buyerSig> <sellerPreSig> OP_0`.
4. Funding: buyer `createAction` with the HTLC output, options `{ randomizeOutputs: false, noSend: true }`; share
   only txid/vout/satoshis/buyerKey with the seller (never the signed tx before the refund signature); verify the
   seller's refund signature locally; then broadcast with `createAction({ options: { sendWith: [txid] } })`.
   If no refund signature arrives: `abortAction({ reference: txid })`.
5. Claim: seller `createAction` with all HTLC inputs (inputBEEF = merged funding BEEFs), `outputs: []` (the wallet
   takes the value as change; an unfunded seller wallet works), `signAction` with
   `createSignature({ hashToDirectlySign })` over the BIP-143 preimage. Buyers read K from the claim tx, check
   sha256(K) = H, decrypt with `SymmetricKey(K)` (AES-256-GCM, random IV, in @bsv/sdk).
6. One joint funding tx for all buyers is NOT safe here (txid unknown until everyone signs, so refunds cannot be
   pre-signed first). Settlement (claim) is atomic; funding is not. Document this residual risk: if a buyer never
   funds, the seller does not claim and funded buyers wait until refundHeight (no loss, only time).
7. Key reveal proves disclosure, not data quality. Say so everywhere; never claim a quality guarantee.

## Required changes (one branch + PR per item, typecheck and tests green after each)

### A. packages/core (P1)

- `src/types.ts` (shared contract; mention in the PR): add ServiceOffer, PurchaseIntent, HtlcTerms (groupId,
  network, sellerIdentityKey, priceSats, hash, sellerKey, refundHeight, ciphertextHash, seller signature),
  GroupParticipant, PurchaseGroup, GroupStatus (open, matched, committed, funding, locked, claimed, expired,
  funding_failed, refund_available, refunded, settlement_failed). Replace SpendPolicy with `{ maxPerPurchaseSats,
  maxTotalSats, allowedServiceIds, requireMatchingResource, maxLockBlocks }`. Sats are safe integers, never floats.
- `src/htlc.ts`: secret + encrypt/decrypt + ciphertextHash; HTLC keys via protocol `[1, 'flashcrowd htlc']`,
  keyID = groupId, counterparty `'anyone'` (so anyone can derive a party's key from its identity key); terms signed
  by the seller's identity and verifiable with `ProtoWallet('anyone')`; prepareContribution, signRefund,
  verifyRefundSignature, broadcastContribution (verifies the refund signature itself), abandonContribution,
  verifyFunding (SPV + output check), claimContributions, secretFromClaim, refundContribution. Return WhatsOnChain
  links (`wocTxUrl`) for every transaction.
- `src/collective.ts`: splitPrice (integer, exact sum, largest remainder, never above a maximum), openGroup,
  matchIntents, advanceGroup (explicit, pure state machine; throw on illegal transitions).
- `src/spendPolicy.ts`: checkSpend, enforced in code (an LLM can never bypass it).
- Tests: replace the spike with real tests covering matching, incompatible resources, exact accounting,
  insufficient funding, duplicate membership, contribution change after authorization, tampered terms, double
  settlement, broadcast failure, SpendPolicy, valid/invalid secret, seller signature, refund before/after timeout,
  unauthorized refund, multi-participant refund, decryption. Keep the existing 13 swap tests passing.
- Scripts: a testnet script (wallet-toolbox wallets from key files outside the repo, Services with
  `arcadeUrl = ARCADE_URL.testnet`) that runs fund → claim and fund → early refund rejected → refund after
  refundHeight, printing WhatsOnChain links.

### B. apps/server (P2)

- Coordinator: `GET /api/services`, `POST/GET /api/intents`, `POST /api/groups/match`, `GET /api/groups/:id`,
  `POST /api/groups/:id/join`, contribution ref → seller refund signature, funding BEEF submit (verifyFunding),
  `GET /api/groups/:id/settlement`, `GET /api/feed` (SSE). Caller identity from BRC-103
  (`@bsv/auth-express-middleware` + `AuthFetch`); never invent headers; never hold buyer keys or funds.
- Mock seller module with its own wallet (key file outside the repo): one simulation dataset labelled as such and
  licensed to share within the group; fresh K per group; claims only when the group is locked and before
  refundHeight. In-memory store is fine if the restart limitation is documented.

### C. apps/agent (P4)

- 2–3 agents, each with its own wallet-toolbox wallet and key file. Deterministic flow: searchServices →
  createPurchaseIntent → join/match → verify terms + checkSpend → prepare → get refund signature → broadcast →
  wait for claim → secretFromClaim → decrypt. An optional LLM may narrate but never decides amounts.

### D. apps/web (P3)

- Dashboard: services, groups, participants, contributions, funding progress, status, lock/claim/refund tx links.
  Keep BSV Desktop connect; a real user flow via WalletClient (join a group or fund an agent). Test BSV Desktop
  with noSend/sendWith early; label any example data as simulation; never show a fake transaction.

### E. Docs

- README (problem, architecture, setup, env vars, testnet, run the demo, security, limits), docs/ARCHITECTURE.md,
  new docs/FLASHCROWD_PROTOCOL.md, docs/SECURITY.md, docs/DEMO.md (≤ 2:30), docs/IMPLEMENTATION_STATUS.md;
  update docs/TEAM.md, .env.example (new agent/seller vars) and the web manifest permissions
  (`flashcrowd htlc`, `flashcrowd terms`).

## Rules

- Propose function signatures and get approval before writing application code; report after each PR.
- Do not mark anything done until it ran; do not claim testnet success without real txids and WoC links.
- Record blockers plainly (e.g. testnet coins, BSV Desktop behaviour, Teranode finality).
