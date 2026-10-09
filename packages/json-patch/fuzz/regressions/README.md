# Fuzz regressions

Every file here is an input the fuzzer once crashed on (a `crash-<sha1>` file from
`fuzz/crashes/`), renamed for what it exercised and kept byte for byte: no extension, so no
formatter or text check reaches it, since an input need not be JSON, or even text. Its SHA-1
is still the one in its original name. `src/fuzz-regressions.test.ts` replays each one through
the oracle in the gate, and `pnpm fuzz` seeds the corpus with them.

To pin a crash: fix the bug, move the crash file here under a descriptive name, and check that
`pnpm test` fails without the fix. Never edit a file here; add a new one.

| File                        | Found                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `test-ignores-extra-member` | a planted bug (`test` equality ignoring a member only the tested value has), in 7s,   |
|                             | when the fuzzer was added (crash-691bbdd3fac71c5398b23dea90d5c32ba702cc75)            |
