# json-patch

Monorepo for [`@dossierhq/json-patch`](packages/json-patch): a strict, bounded
[RFC 6902](https://www.rfc-editor.org/rfc/rfc6902) JSON Patch **apply** and **diff** over JSON
data, with [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON Pointers. Zero runtime
dependencies. Built for patches from people you do not trust, applied to documents you do.

```sh
npm install @dossierhq/json-patch
```

```ts
import { applyPatch, parsePatch } from "@dossierhq/json-patch";

const parsed = parsePatch(JSON.parse(body));
if (!parsed.ok) return reject(parsed.error);

const applied = applyPatch(document, parsed.value);
if (!applied.ok) return reject(applied.error);

store(applied.value);
```

The package README is the full documentation: the contract, limits, denial-of-service
guarantees, diff, errors and the testing strategy.

- [`packages/json-patch/README.md`](packages/json-patch/README.md): usage and design
- [`packages/json-patch/SECURITY.md`](packages/json-patch/SECURITY.md): the known JSON Patch
  vulnerability classes and why each does not apply here

## Workspace

| Path                         | What it is                                               |
| ---------------------------- | -------------------------------------------------------- |
| `packages/json-patch`        | The published package `@dossierhq/json-patch`            |
| `packages/typescript-config` | Shared `tsconfig` bases (private, not published)         |
| `scripts`                    | Repo-level checks: coverage map, property hunting        |
| `ast-grep-rules`             | Custom lint rules enforced by `ast-grep` in `pnpm lint`  |
| `.github/workflows`          | CI, scheduled fuzzing and mutation testing, dependencies |

## Development

Tool versions are pinned in `mise.toml` (Node and pnpm). With [mise](https://mise.jdx.dev)
installed:

```sh
mise install
pnpm install
pnpm build
```

`pnpm build` runs the whole gate: lint, type checks, build, tests with coverage, and the
`fallow` dead-code and health checks. The individual steps:

| Command              | What it does                                        |
| -------------------- | --------------------------------------------------- |
| `pnpm lint`          | `oxlint` and the `ast-grep` rules                   |
| `pnpm check-types`   | `tsc --noEmit` across the workspace                 |
| `pnpm test`          | `vitest` with coverage                              |
| `pnpm format`        | `oxfmt`, also run on staged files by the pre-commit |
| `pnpm fuzz`          | Jazzer.js fuzzing of `applyPatch` (`FUZZ_SECONDS`)  |
| `pnpm mutate`        | Stryker mutation testing                            |
| `pnpm deps:outdated` | List outdated dependencies                          |

Fuzzing runs nightly and mutation testing weekly in the Hardening workflow; both can also be
started by hand from the Actions tab.

## License

[MIT](LICENSE)
