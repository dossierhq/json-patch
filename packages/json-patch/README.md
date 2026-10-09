# @dossierhq/json-patch

A strict, bounded [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902) JSON Patch **apply** and
**diff** over JSON data, with [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON Pointers.
Zero runtime dependencies. Built for patches from people you do not trust, applied to
documents you do.

```ts
import { applyPatch, parsePatch } from "@dossierhq/json-patch";

const parsed = parsePatch(JSON.parse(body)); // everything that does not need the document
if (!parsed.ok) return reject(parsed.error); // INVALID_PATCH, INVALID_POINTER, INVALID_VALUE, LIMIT_EXCEEDED

const applied = applyPatch(document, parsed.value); // everything that does
if (!applied.ok) return reject(applied.error); // PATH_NOT_FOUND, FROM_NOT_FOUND, TEST_FAILED, LIMIT_EXCEEDED

store(applied.value);
```

And the other way, the patch that turns one document into another (see [Diff](#diff)):

```ts
import { createPatch } from "@dossierhq/json-patch";

const created = createPatch(before, after, { tests: true }); // guard what it overwrites
if (!created.ok) return reject(created.error); // INVALID_VALUE, LIMIT_EXCEEDED
send(created.value); // frozen; parses under the same limits
```

## The contract

- **Two phases.** `parsePatch(input, limits?)` checks everything that does not depend on the
  document and takes a private, frozen copy of the patch. `applyPatch(document, patch, limits?)`
  can then only fail for what the document holds. A parsed patch is opaque and cannot be
  forged: `applyPatch` refuses anything `parsePatch` did not return.
- **Total.** A bad patch comes back as `{ ok: false, error: JsonPatchError }` and is never
  thrown. That holds for any input to `parsePatch` (Proxies excepted, since their traps
  run), and for any parsed patch applied to any JSON document.
- **RFC 6902 semantics.** Operations run in order, each on the result of the ones before it,
  and the patch applies all or nothing.
- **Pure.** `document` is never modified, not even partway through a failed patch.
- **Copy-on-write.** The result shares with the document every container the patch did not
  change or pass through. Treat both as immutable, or deep-copy the one you mutate.
- **No aliasing.** The result shares no container with the patch, and it holds no container
  twice unless the document already did. Every value the patch places is a fresh copy, and
  `copy` deep-copies.
- **Prototype-proof.** Pointers resolve through own members only: an object's own keys and an
  array's in-range indices, never anything inherited. `"__proto__"`, `"constructor"` and
  `"toString"` are ordinary member names. They are added with `defineProperty`, never by
  assignment, so no patch can reach or change a prototype.
- **Bounded.** Every input size and every unit of work is capped by an explicit limit (see
  [Limits](#limits)), so a hostile patch costs a bounded amount of time and memory (see
  [Denial of service](#denial-of-service)). Nothing recurses, so no input depth can overflow
  the call stack.
- **Known attacks.** [SECURITY.md](SECURITY.md) catalogues the published vulnerabilities of
  other JSON Patch, JSON Pointer and diff libraries, class by class, with what refuses each
  here. `src/cve-regressions.test.ts` replays their attack inputs.
- **Safe errors.** An error message names the operation index and, where one is at fault,
  its pointer (truncated to 64 code units and JSON-escaped). It never contains a value from
  the patch or from the document.

### Preconditions

Breaking a precondition is a caller bug. A forged patch or a limit out of range always
throws, a `JsonPatchInvariantError`, a `RangeError` or a `TypeError`. A document that is not
JSON throws a `JsonPatchInvariantError` where an apply checks it (below), and elsewhere is not
detected.

- `document` is JSON, as `JSON.parse` makes it. It is not validated in full on every apply,
  since that would cost what copy-on-write saves. Instead, each container a pointer passes
  through is asserted to be JSON and each object member it looks up to be a data member, and
  every value a `copy`, `test` or `move` walks is asserted in full. The container an apply
  writes into is copied first, by spread or `slice`, which reads its members as ordinary
  properties, the written one included: a getter there runs, and its result is copied as
  data. If a document comes from somewhere you do not control, validate it where it enters.
- Limits are a plain object of integers in `[1, HARD_LIMITS]`, and no other names are
  accepted. Anything else throws a `TypeError`, an `ApplyBudget` made by another copy of
  this library included: a budget, like a parsed patch, works only with the copy that made
  it, so two installed versions cannot share one.

## The value domain: I-JSON

Patch values are held to [I-JSON (RFC 7493)](https://www.rfc-editor.org/rfc/rfc7493): exactly
the values `JSON.parse` can produce, minus the ones I-JSON forbids.

| Accepted                                                                      | Refused (`INVALID_VALUE`)                                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `null`, booleans                                                              | `undefined`, bigints, symbols, functions                                           |
| finite numbers, including `-0`                                                | `NaN`, `±Infinity`                                                                 |
| well-formed UTF-16 strings                                                    | a string or member name holding a **lone surrogate**                               |
| dense arrays of this realm (prototype `Array.prototype`), holding values only | holes, extra members, array subclasses, arrays from another realm                  |
| objects with prototype `Object.prototype` or `null`                           | class instances, `Date`, `Map`, typed arrays, boxed primitives                     |
| own, enumerable data members with string keys                                 | getters and setters (reported, **never run**), non-enumerable members, symbol keys |

A cyclic value is refused as `LIMIT_EXCEEDED`, because it is infinitely deep.

## Diversions from the RFCs

Where this library does something other than what an RFC says, it accepts less. It never
accepts more, and it never gives a different result for a patch it accepts. Every diversion
has a test. The ones the conformance suite can observe are listed in
`src/conformance/conformance.test.ts`.

1. **Undefined operation members are refused.** RFC 6902 §4 says a member an operation does
   not define MUST be ignored. Here it is `INVALID_PATCH`. A stray member is either a patch
   written for another dialect, or a typo the RFC would silently turn into a different
   operation. For example, `{"op": "remove", "path": "/a", "value": 1}` is refused rather than
   read as a plain `remove`. Suite records: `tests.json#45`, `spec_tests.json#11` (A.11).
2. **Values are I-JSON, not just JSON.** Strings, member names and pointers must be
   well-formed UTF-16. RFC 8259 tolerates lone surrogates; RFC 7493 does not.
3. **Limits.** Anything past a configured limit is `LIMIT_EXCEEDED`, even when the RFC would
   apply it.

### Where the RFCs leave a choice

These are not diversions, but each is a decision somebody has to make, pinned here:

- **A `test` of a location with no value fails** (`TEST_FAILED`, not `PATH_NOT_FOUND`): the
  precondition it states does not hold.
- **The root cannot be removed** (`INVALID_PATCH`): a patch cannot produce "no document".
- **A document may be any JSON value.** A scalar root can be replaced, or tested, with
  `path: ""`. Adding to or removing from it fails with `PATH_NOT_FOUND`.
- **`move` onto its own location** is a no-op once its `from` resolves. The root can only be
  moved onto itself.
- **Pointers are read strictly** (this is what RFC 6901 already says, though many readers
  are looser):
  - `~` is only ever `~0` or `~1`, so `/~2` and a trailing `~` are `INVALID_POINTER`. Every
    member name has exactly one spelling.
  - An array index has no sign and no leading zero. `-` is valid only where an `add` (or a
    `move`/`copy` destination) appends.
  - On an object, `01` and `-` are ordinary member names.
- **Equality in `test`:**
  - Numbers compare by value, so `-0` equals `0`.
  - Strings compare by code unit, with no Unicode normalization.
  - Objects compare regardless of member order.
- **Member order:** an added member goes last, and a replaced one keeps its place. JSON
  objects are unordered, so nothing here depends on it.
- **Out of scope, for the JSON parser to decide:**
  - Duplicate member names in the patch text. `JSON.parse` keeps the last one, which is how
    the suite's "two op members" records read.
  - Number precision: I-JSON numbers are IEEE doubles.

## Limits

Every limit is an integer. A caller can tighten any of them per call, never past its hard
limit. `parsePatch` enforces the patch's limits (`maxOperations`, `maxPointerLength`,
`maxPatchCost`, and `maxDepth` for values and pointers). `applyPatch` enforces its own
(`maxApplyWork`, `maxApplyValues`, and `maxDepth` again for everything it places), so
applying under a tighter `maxDepth` than the patch was parsed with is enforced too:

| Limit              | Default | Hard limit | Bounds                                                                                                |
| ------------------ | ------: | ---------: | ----------------------------------------------------------------------------------------------------- |
| `maxOperations`    |  10 000 |    100 000 | operations in one patch                                                                               |
| `maxPointerLength` |    4096 |     65 536 | UTF-16 code units in a `path` or `from`                                                               |
| `maxDepth`         |     256 |       1024 | nesting of a patch value, tokens of a pointer, and pointer tokens plus value depth of anything placed |
| `maxPatchCost`     |   4 MiB |    256 MiB | cost of the whole patch document                                                                      |
| `maxApplyWork`     |  16 MiB |      1 GiB | work one apply may do, in cost units                                                                  |
| `maxApplyValues`   |  256 Ki |      64 Mi | values one apply may copy, compare, measure or shift                                                  |

**Cost** tracks a value's serialized length: one unit per value, plus one per UTF-16 code
unit of every string and member name. The unit is characters, not nodes, so repeated
copying is always charged. `copy` shares strings in memory, but serializing the result
writes each one out again. So a patch that copies a long string a thousand times is charged
for a thousand strings.

**Work** is charged before it is done:

- every pointer, by its length
- every value copied into the result
- every value a `test` compares
- every value a `move` measures, when it moves a value deeper
- every member a copy-on-write container copies or an array insert or remove shifts

**Values** are counted at the same points, one per value or member, and each operation counts
one. Characters are not: a string's content and a member name cost work only. Two budgets,
because cost bounds the size of the result and values bound the time and memory it takes.
A copy shares a string for free, however long; every value it copies is an allocation,
however short.

"Before" is literal. A walk over a value pays for a container's members as soon as it knows
how many there are, before it reads or schedules any of them. So the budget bounds what an
apply reads and allocates, not only what it compares. An array's length is known up front.
An object's member count is not: listing its keys is the one step taken before paying for
it, and it is paid for straight after. So a walk the budget stops has listed the keys of at
most the one object it stopped at.

As a result, whatever the patch, the result's cost is at most the document's cost plus
`maxApplyWork`, and it holds at most `maxApplyValues` more values than the document.

## Denial of service

A patch is a program: 40 operations copying the root to a new member each double the
document every time, so a patch of about a kilobyte asks for 2⁴⁰ values. The apply limits
are what stop it, and they are the ones to size for a service that applies patches from
people it does not trust. Whichever of the two runs out first refuses the patch:

- **`maxApplyValues`** stops doubling of small values. Under `maxApplyWork` alone, an object
  like `{"a": 1}` costs 3 units, so 16 MiB of work let the doubling above make millions of
  objects first: 2.6 seconds and 259 MB, from one 1 KB patch.
- **`maxApplyWork`** stops doubling of long strings. They cost almost nothing to copy, since
  a copy shares them, but the result would serialize to gigabytes.

Measured at the defaults (Node 26.8, one core of a 2.8 GHz Xeon, 2026-09, median of three),
the worst patches we found are refused within these bounds:

| Patch, about 1 KB: the root copied 40 times, from | Refused by       |   Time | Peak memory |
| ------------------------------------------------- | ---------------- | -----: | ----------: |
| `{"e": {}}`                                       | `maxApplyValues` | 139 ms |      +46 MB |
| `{"a": 1}`                                        | `maxApplyValues` | 134 ms |      +33 MB |
| an object of 64 members                           | `maxApplyValues` | 111 ms |      +28 MB |
| an array of 8 numbers                             | `maxApplyValues` |  60 ms |      +30 MB |
| a string of 1 KiB                                 | `maxApplyWork`   |  21 ms |       +5 MB |

Time and memory scale with `maxApplyValues`, at worst about half a microsecond and a couple
of hundred bytes per value: raising it to 1 Mi made the first row 500 ms and +115 MB. The
hard limits are ceilings for input you trust, not settings for input you do not: under them
the second row took 28 seconds and 2 GB. Size the two apply limits from the largest
legitimate patch you accept, not from the largest document: a patch that edits a field of a
big document copies a path, not the document.

**Applying a patch a piece at a time.** Each call to `applyPatch` has its own budget. A caller
that splits an untrusted patch into several applies (one operation at a time, to inspect
the document between them, say) would give each piece a full budget. Pass one `ApplyBudget`
to all of them instead: they then draw on it together, as a single apply would.

```ts
const budget = new ApplyBudget(); // the defaults, or tighter limits
for (const operation of operations) {
  const applied = applyPatch(document, parsed(operation), budget);
  // …
}
```

What an apply spends stays spent, whether it succeeds or fails.

## Diff

`createPatch(source, target, { tests?, limits? })` returns the patch that turns `source` into
`target`, or why no patch fits the limits. The contract:

- **Round trip.** The patch parses, and `applyPatch(source, parsed)` is `target`.
- **fast-json-patch's shape.** Operation for operation, it is what
  [fast-json-patch](https://github.com/Starcounter-Jack/JSON-Patch)'s `compare` (3.1) returns,
  wherever `compare` is right, so moving from one to the other changes no patch:
  - members are compared last to first, depth first; the members `target` adds come after,
    in its key order;
  - two containers of one kind are diffed into; any other change replaces the member;
  - with `tests`, every `replace` and `remove` is preceded by a `test` of the value it
    overwrites. An `add` has nothing to guard.
- **Stable locations.** A `replace` overwrites in place, an array only loses members from its
  end and only gains them at its end, and no two writes overlap. So every operation's path
  names the same place in `source`, in `target` and in every document between them: no
  index shifts. Code that reasons about patches by their paths (does this edit touch that
  one?) can rely on this; a smarter array diff that inserts in the middle would break it.
  Prepending to an array of n members costs n replaces and an add.
- **Equality** is `test`'s: numbers by value (`-0` equals `0`), strings by code unit.
- **Where compare is wrong, this is not.** A changed scalar root is replaced (`compare`
  returns `[]`), and so is a root that changed kind (`compare` returns a patch that does not
  apply).
- **Total.** Any input comes back as a result, never a throw (Proxies excepted).
- **The JSON view.** The documents are read as `JSON.stringify` would write them: own,
  enumerable, string-keyed members. A symbol key, a non-enumerable member or an array's extra
  member is not part of the JSON, so it is not compared. But members are read through their
  descriptors, so a getter is refused (`INVALID_VALUE`), never run. So is any value the diff
  reads that is not JSON (`undefined`, a `Date`, `NaN`, a hole), and any value or member name
  it would write into the patch that is not I-JSON (a lone surrogate). A string it only
  compares need not be. A container `source` and `target` share is not read at all, so a
  diff after a copy-on-write apply costs what the apply changed.
- **Bounded.** The patch is held to the limits `parsePatch` enforces, charged as it charges
  them: it comes back exactly when it parses under the same `maxOperations`,
  `maxPointerLength`, `maxDepth` and `maxPatchCost`. The diff's own work is held to
  `maxApplyWork` and `maxApplyValues`, as an apply's is: one value per value it reads in
  either document and per value it copies into the patch, one unit of work per character of
  every member name it reads or copies and every string it compares or copies. A cyclic input
  runs out of budget. Nothing recurses, so no depth overflows the stack.
- **Frozen and unshared.** The patch, its operations and every value in them are frozen, and
  the patch shares no container with either document.
- **Errors** have no operation index. Their messages name a location, never a value.

### What it costs

Reading every member through its descriptor, which is what keeps a getter from running, is
most of the cost. Measured against `compare` (with tests, Node 26.8, one core of a 2.8 GHz
Xeon, 2026-09):

| Documents                              | `compare` | `createPatch` |
| -------------------------------------- | --------: | ------------: |
| 100 items (~800 values), one edit      |   0.08 ms |       0.33 ms |
| 100 items, many edits                  |   0.10 ms |       0.45 ms |
| 5 000 items (~40 000 values), one edit |    5.5 ms |         20 ms |
| 5 000 items, many edits                |    7.1 ms |         27 ms |

An ordinary property read would bring it to about `compare`'s speed, at the price of running
whatever a getter does.

## Errors

`JsonPatchError` has a `code`, an `operationIndex` (or `null` when the fault is the patch as
a whole, and always from `createPatch`) and a message.

| Code              | From                        | Means                                                    |
| ----------------- | --------------------------- | -------------------------------------------------------- |
| `INVALID_PATCH`   | `parsePatch`                | not an array of well-formed operations (see above)       |
| `INVALID_POINTER` | `parsePatch`                | a `path` or `from` that is not an RFC 6901 pointer       |
| `INVALID_VALUE`   | `parsePatch`, `createPatch` | a `value`, or a document, that is not I-JSON             |
| `LIMIT_EXCEEDED`  | all three                   | a limit of `JsonPatchLimits`                             |
| `PATH_NOT_FOUND`  | `applyPatch`                | the `path` does not lead where the operation needs it to |
| `FROM_NOT_FOUND`  | `applyPatch`                | the `from` of a `move` or `copy` does not resolve        |
| `TEST_FAILED`     | `applyPatch`                | a `test` found a different value, or none                |

A service that races patches against a moving document can treat `PATH_NOT_FOUND`,
`FROM_NOT_FOUND` and `TEST_FAILED` as "the document moved underneath this edit". Every other
code means the patch is wrong for any document.

## How it is built (Tiger Style)

- **Assertions.** Preconditions, postconditions and invariants are asserted inline, in both
  directions. For example, after an `add` the value is at its path, and after a `remove` the
  member is gone. They stay on in production. The messages are constants, so a passing
  assertion costs nothing more than the comparison.
- **Invariant errors versus results.** An assertion that fires is a bug in this library or
  in its caller. No patch may reach one, and the property tests fail if any does.
- **No recursion.** Every walk (import, copy, compare, measure) uses an explicit stack whose
  size its budget bounds. The `no-recursion` ast-grep rule enforces this.
- **Bounded loops and explicit limits.** Every loop is bounded by an input that a limit
  caps. The relations between the limits are asserted when the module loads.
- **Prototype safety by construction.** There is no `obj[key]` under a computed key, no
  `in`, and no `for…in` (the repo's shared ast-grep rules plus `no-for-in`). A patch's values
  and both documents of a diff are read through property descriptors, so a getter there is
  never run. The document an apply writes into is JSON by precondition, and its copies are
  made by spread or `slice` (see [Preconditions](#preconditions)).
- **Zero dependencies** at runtime. The library code uses no Node APIs, so it runs in
  Workers and browsers.

## Testing strategy

`pnpm test` runs all of the following. Coverage is gated at **100% of statements, branches,
functions and lines**. The deterministic tests reach it on their own, so the gate never
depends on a random run.

- **Conformance.** The community suite
  [json-patch-tests](https://github.com/json-patch/json-patch-tests) is vendored unmodified,
  pinned by commit and checked by SHA-256, and it includes the RFC's appendix A. Every
  record runs, disabled ones included. A disagreement must be a listed diversion with its
  reason, and a listed diversion that stops happening also fails.
- **Unit tables.** Every operation, every error code and message, the RFC 6901 §5 examples,
  every non-I-JSON value, and prototype member names (including the #1845 shapes). Also:
  amplification, depth, and the fact that no error message leaks a value. A sweep raises
  each cost limit one unit at a time for fixed patches, and asserts that every charge site
  fails with `LIMIT_EXCEEDED` below one threshold and succeeds above it.
- **Property tests** (`src/patch.properties.test.ts`, fast-check):
  - **DIFFERENTIAL:** results match `src/test/reference-model.ts`, an independent,
    deliberately naive implementation of the same contract. It uses Maps instead of objects,
    regex pointers, recursion, and RFC wording taken literally.
  - **TOTAL:** `fc.anything()` as a patch never throws.
  - **PURE:** documents are deep-frozen, so any write throws.
  - **UNSHARED:** the no-aliasing guarantee above.
  - **PROTOTYPES:** `Object.prototype` and `Array.prototype` are fingerprinted after every run.
  - **LIMITS-REFUSE:** under tight random limits the only new outcome is `LIMIT_EXCEEDED`,
    and the growth bounds hold.
  - **LAWS:** patch concatenation, a patch of passing tests returns the document itself, and
    an add undone by a remove.
  - **CANONICAL:** one spelling per pointer.

  The generators draw pointers from each generated document, so long patches get far. One
  patch in four is hostile.

- **Diff properties** (`src/diff.properties.test.ts`), over pairs of documents drawn both
  independently and as a document with a patch of it applied (which shares every container
  the patch left alone):
  - **ROUND-TRIP:** the patch parses and turns the source into the target; neither
    (deep-frozen) document changes, nor does a prototype.
  - **DIFFERENTIAL:** where both roots are containers of one kind, the patch is
    fast-json-patch's `compare`, byte for byte as JSON (a dev dependency, for this test only).
  - **IDENTITY:** a document against itself or a deep copy is `[]`.
  - **STABLE:** every write names one location in both documents, no two writes overlap, and
    every `replace` and `remove` is guarded by a `test` of the source's value.
  - **GUARDED:** a guarded patch applies to another document only if that document holds the
    source's value at every guarded location.
  - **LIMITS:** under tight random limits the only new outcome is `LIMIT_EXCEEDED`, and a
    patch comes back exactly when `parsePatch` accepts it under the same limits.
  - **TOTAL** (`fc.anything()` on both sides) and **UNSHARED** (frozen, no container of
    either document).

- **Hunts.** `pnpm --filter @dossierhq/json-patch test:hunt` runs the properties many times harder
  with fresh seeds, and prints a replay command for any counterexample.
- **The tests are tested.** Each property was checked by planting known bugs (a leading-zero
  index, a missing copy-on-write, a shared `copy`, a lax equality, an assignment through
  `"__proto__"`, and more). Every one was caught. So were the diff's: added members in
  reverse order, an unguarded `remove`, `-0` compared as a change, a hole let through.

### Fuzzing (Jazzer.js)

```sh
pnpm fuzz                    # 5 minutes
FUZZ_SECONDS=3600 pnpm fuzz  # an hour
pnpm --filter @dossierhq/json-patch fuzz:replay fuzz/crashes/crash-…  # one input
```

[Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) drives libFuzzer against
the built `dist/`. It instruments the library for coverage feedback, so mutated inputs that
reach new branches are kept and mutated further. It also compares against the values the code
checks (`"~"`, `"-"`, `"__proto__"`), so it steers towards them.

- **Target.** `fuzz/patch-target.ts` decodes the bytes as UTF-8 and `JSON.parse`s them. An
  object with exactly `doc` and `patch` is one case (a conformance record's shape), and one
  with exactly `source` and `target` one diff. Anything else is a patch, applied to each of
  a handful of seed documents, and a document, diffed against each of them both ways. Every
  apply that succeeds is diffed back against its document too, so one target fuzzes both.
- **Oracle.** `src/test/fuzz-oracle.ts` is the contract as a crash condition. Any of these
  is a crash:
  - a throw;
  - a disagreement with the reference model, unless a limit refused the patch;
  - a diff of two I-JSON documents that is refused other than by a limit, or whose patch does
    not parse or does not turn the source into the target;
  - a changed (deep-frozen) document;
  - a changed prototype;
  - a result holding a container of the patch, or a patch holding one of a document.

  Jazzer's own prototype-pollution detector runs as well.

- **Corpus.** `fuzz/seed-corpus.ts` seeds `fuzz/corpus/` (gitignored) with every conformance
  record and every pinned regression. libFuzzer adds what it finds, so the corpus grows
  run over run. The nightly workflow keeps it in the Actions cache.
- **Crashes.** A crash writes its input to `fuzz/crashes/` (gitignored). Once fixed, move it
  to `fuzz/regressions/` under a descriptive name, without an extension, so it stays byte
  for byte what libFuzzer wrote. `src/fuzz-regressions.test.ts` replays
  every regression, and every conformance record, through the oracle in `pnpm test`. It
  also shows that the oracle catches each kind of break it exists for.

As a check when the fuzzer was added, a planted bug (`test` equality that ignores extra
object members) was found in 7 seconds. Its input is the first pinned regression.

### Mutation testing (Stryker)

```sh
pnpm mutate   # a few minutes; report in reports/mutation/index.html
```

[Stryker](https://stryker-mutator.io) plants one small change at a time in `src/`: a flipped
comparison, an emptied block, a removed call, a blanked string. For each one it runs the
tests that cover that code. A mutant no test notices ("survived") is behavior the tests do
not pin down. The run fails below `thresholds.break` in `stryker.config.mjs`.

- **Deterministic kills.** The run uses `vitest.stryker.config.ts`: properties run from a
  fixed seed, at a tenth of their runs, so a mutant is killed or survives the same way every
  time.
- **Assertions are skipped.** An ignorer in `stryker.config.mjs` skips `assert(…)` calls.
  Weakening a check that never fires on correct code is equivalent by construction.
- **Every other survivor is either killed or justified in the code.** A
  `// Stryker disable next-line <Mutator>: <why>` comment says why the mutant cannot change
  anything observable. There are five: two of them are `compare`'s own shortcut past a
  pass that would find nothing, kept for the 12% it saves.
- **Load-time code.** `src/module-load.test.ts` imports the library inside a test. A mutant
  that breaks module loading fails every test file before any test runs, and Stryker's vitest
  runner reports that as "survived" rather than "killed". Without this test, every mutant
  of the limits' load-time checks looked like a gap.
- **TypeScript 7.** Stryker rewrites the tsconfig through TypeScript's JS API, which the
  native TypeScript 7 compiler doesn't have. The config points that step at no file. It
  only relocates relative `extends` and project references, and tsconfig.json has neither.

How the first runs went, as a record of what mutation testing found beyond 100% coverage:

| Run                            | Score | Survivors                                           |
| ------------------------------ | ----- | --------------------------------------------------- |
| First, plain                   | 86.3% | 162, 97 of them in assertions                       |
| Assertions ignored, load test  | 95.7% | 43                                                  |
| Gaps tested, dead code removed | 99.6% | 4                                                   |
| Apply at 100% (`break: 100`)   | 100%  | 0 (1032 killed, 7 by timeout; 3 marked equivalent)  |
| Diff added, first run          | 99.0% | 13                                                  |
| Now                            | 100%  | 0 (1364 killed, 13 by timeout; 5 marked equivalent) |

The gaps it found:

- depth was never measured through objects, only arrays;
- no boundary test sat at exactly `maxOperations`, at exactly `maxDepth` for a scalar, or at
  exactly 64 quoted code units;
- running out of work while copying a container partway down a path came out as
  `PATH_NOT_FOUND` in one mutant, and no test caught it;
- nothing checked that a parsed value is frozen or that a result's members are writable;
- the error names and every limit's messages were unpinned.

In the diff, it found that no test put a `remove` or `replace` past `maxDepth`, and that
code refusing a non-JSON member was only covered by a later check that happened to refuse it
too. The branches were reordered so each check has its own observable outcome. Once the diff
charged the values it copies to its work limits, a copy's charge came straight after every
member name's, so dropping the refusal for a name that did not fit went unnoticed; a test now
pins a name with nothing after it.

It also found code whose mutants could not matter: an unused depth, a redundant bound, a
refusal whose contents never surfaced. That code was removed rather than tested. The work
each operation costs is now pinned exactly, so a change to the accounting shows up as a
changed snapshot.

### Scheduled runs

`.github/workflows/json-patch-hardening.yml` fuzzes for 15 minutes every night and runs
Stryker every Sunday. Both can also be started by hand. Neither is part of the CI gate: a
fuzz run is random and a mutation run is slow. What they find comes back to the gate as a
pinned regression or a new test.

### Not yet

- A diff that `move`s, or that inserts into an array in the middle: smaller patches, but ones
  whose operations shift indices, which the stable-location guarantee above rules out. It
  would be an option, not the default.
