# src/kit: the developer pack's BSV-21 token kit

Source: the BSV developer pack, `starter/bsv21-token-kit` (version 0.1.0), folders `core/`, `client/` and
`overlay/`. The same code is printed in Appendix A of `BSV_STACK_COMPLETE_GUIDE.md` (checked file by file on
30 Oct 2026). `packages/core/test/helpers/mockchain.ts` is the kit's `test/helpers/mockchain.ts`.

The files are unchanged except one:

- `client/signer.ts`: `signWalletP2pkhInput` takes an optional sighash `scope` as its last parameter. The default
  stays `SIGHASH_ALL | SIGHASH_FORKID`; offers sign with `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY | SIGHASH_FORKID`
  (0xC3).

Keep it that way, so a newer kit can be compared with `diff -r`: our own code goes in `src/` next to this folder.
Prettier skips these files (`.prettierignore`) because the kit has its own code style.

`overlay/` runs in-process in the tests and, started by `apps/overlay`, as our testnet overlay.
