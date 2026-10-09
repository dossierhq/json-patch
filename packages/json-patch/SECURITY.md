# Security: known JSON Patch vulnerabilities, and why they do not apply here

Published vulnerabilities in JSON Patch (RFC 6902), JSON Pointer (RFC 6901), JSON Merge Patch
(RFC 7386/7396) and JSON diff libraries, across languages. They fall into a few classes of
attack. For each class, this file says what in this library refuses it and which test replays
its attack input. `src/cve-regressions.test.ts` replays the attack inputs of the advisories
below. Every test in it also checks that none of the builtins and prototypes it fingerprints
changed.

Collected 2026-09-24 from the GitHub Advisory Database, the libraries' own fixes and issues,
and NVD, and checked 2026-09-25: every GHSA ID against the GitHub Advisory Database, every
`SNYK-…` ID against Snyk. Where a database and the library's own release notes disagree on
the fixed version, the catalogue follows the release notes and says so.

**Verdict.** No class is open in this library. Three classes are not a patch library's to
close, because they depend on who is applying the patch (see
[What the caller owns](#what-the-caller-owns)).

## The classes

| #   | Class                                                  | Advisories (see [catalogue](#catalogue))                                                                                                           | Why it does not apply here                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Prototype pollution through a `__proto__` segment      | fast-json-patch <2.1, jsonpointer <4.1, json-pointer, json-ptr, rfc6902, json8, immer, jsondiffpatch, object-path, dot-prop, set-value, scim-patch | A pointer resolves through own members only (`getOwnPropertyDescriptor`, and an array's in-range indices). No object has an own `__proto__` unless the document put one there, and then it is an ordinary member.                                                                                                     |
| 2   | … through `constructor/prototype`, past a guard of (1) | fast-json-patch CVE-2021-4279, json-pointer CVE-2022-4742, jsondiffpatch CVE-2026-8657                                                             | There is no guard to get past: no name is special. `constructor` is not an own member of a plain object.                                                                                                                                                                                                              |
| 3   | … through a segment deeper than the guard looks        | jsonpointer CVE-2021-23807                                                                                                                         | The same own-member lookup at every segment.                                                                                                                                                                                                                                                                          |
| 4   | Type confusion: a path segment that is not a string    | jsonpointer, json-pointer, json-ptr, immer, object-path, set-value (each the second CVE after a string-only fix)                                   | `path` and `from` must be strings (`typeof`), and `op` too. A pointer is split into strings by `parsePointer`. An array, a `String` object or an object with `toString` is `INVALID_PATCH`.                                                                                                                           |
| 5   | A final `__proto__` swaps the target's prototype       | json-pointer 0.6.2 (residual), merge-patch class (json8-merge-patch CVE-2020-8268)                                                                 | Members are placed with `Object.defineProperty`, never assigned, and so is every member of a copied value. Copy-on-write copies with spread, which also defines.                                                                                                                                                      |
| 6   | Skipping a forbidden segment aliases another path      | rfc6902 5.x (residual)                                                                                                                             | Nothing is skipped: `/constructor/role` names the member `constructor`, and fails if there is none.                                                                                                                                                                                                                   |
| 7   | Writing to a builtin (`/constructor/keys`)             | fast-json-patch 3.1.1 (residual), #1845 in this repo                                                                                               | As (1). No builtin is reachable.                                                                                                                                                                                                                                                                                      |
| 8   | Array index read leniently                             | cJSON CVE-2025-57052 (`0A` as 10), Caddy CVE-2026-45692 (`01` as 1), evanphx `SupportNegativeIndices`                                              | RFC 6901's grammar exactly: `0` or a digit string with no leading zero. No sign, space, exponent, hex or fullwidth digit. `-` only where an `add` appends. A token with more than 15 digits is out of range, never parsed.                                                                                            |
| 9   | Add past the end: out-of-bounds write, or padding      | evanphx CVE-2018-14632, evanphx PR #222 (padding to index 2 000 000 000)                                                                           | An index above the length is `PATH_NOT_FOUND`. Nothing is padded.                                                                                                                                                                                                                                                     |
| 10  | Escapes decoded wrongly                                | cJSON CVE-2026-29036                                                                                                                               | `~1` is decoded before `~0`, and any other `~` is `INVALID_POINTER`, so every key has exactly one spelling. An assertion checks that escaping and unescaping round-trip.                                                                                                                                              |
| 11  | A pointer indexes a string or a scalar                 | python-json-patch #178, evanphx #171 (nil dereference under `null`)                                                                                | Only arrays and plain objects have members. Anything else is `PATH_NOT_FOUND`.                                                                                                                                                                                                                                        |
| 12  | A pointer turned into code                             | json-ptr GHSA-rrqv-vjrw-hrcr, Spring Data REST CVE-2017-8046 and CVE-2026-41729 (SpEL), Cribl CVE-2026-56747                                       | A pointer is only ever split and compared. There is no `eval`, `new Function` or expression language.                                                                                                                                                                                                                 |
| 13  | Crash on a malformed or unlucky operation              | evanphx #114, #158, #171, #90; python-json-patch #152 (an `IndexError` for an index a `remove` shifted); cJSON CVE-2026-87933 (use after free)     | Total: every input is a result, never a throw. The TOTAL property (`fc.anything()` as a patch) and the fuzzer's oracle hold this.                                                                                                                                                                                     |
| 14  | Loose equality                                         | python-json-patch #180 (a diff comparing `1` and `True` as equal)                                                                                  | No coercion, in `test` and in `createPatch` alike: `1` is not `"1"`, `0` is not `false`, `[]` is not `{}`, and extra members differ. Strings compare by code unit. A missing value fails the test.                                                                                                                    |
| 15  | Not all or nothing                                     | cJSON CVE-2026-67217                                                                                                                               | The document is never written. An apply builds its result by copy-on-write and returns it only when every operation has run, so a failed patch leaves nothing behind. The PURE property deep-freezes every document it applies to.                                                                                    |
| 16  | `move` into its own subtree makes a cycle              | (a class, not a single CVE)                                                                                                                        | `INVALID_PATCH`, found at parse time by comparing tokens.                                                                                                                                                                                                                                                             |
| 17  | Amplification by `copy`                                | Kubernetes CVE-2019-1002100, evanphx PR #70 and #74, java-json-tools CVE-2026-86319                                                                | `maxApplyValues` and `maxApplyWork`, charged before the work is done (see the README's [Denial of service](README.md#denial-of-service)). An apply copies a container once, however many operations pass through it.                                                                                                  |
| 18  | Depth: stack overflow                                  | java-json-tools CVE-2026-86318, jackson-core #818, cJSON CVE-2026-67215 (depth grown by grafting)                                                  | Nothing recurses (the `no-recursion` ast-grep rule). `maxDepth` bounds the patch's values, its pointers, and everything an apply places: `copy`, and a `move` to a deeper path. A `move` up or across keeps a depth the document already had, so the document's own depth is the caller's to bound when it is stored. |
| 19  | Exponential walks of shared subtrees                   | cJSON CVE-2026-67216                                                                                                                               | Every walk (copy, compare, measure, diff) is charged per value it reaches, so a shared subtree is paid for each time it is walked, and the budget stops it.                                                                                                                                                           |
| 20  | Quadratic or unbounded pointer parsing                 | jackson-coreutils CVE-2026-86513, MongoDB CVE-2026-82054                                                                                           | `maxPointerLength` is checked before the pointer is split, and `maxDepth` bounds its tokens. The split is linear.                                                                                                                                                                                                     |
| 21  | ReDoS                                                  | ajv CVE-2025-69873 (data reached by a pointer compiled as a RegExp)                                                                                | The one pattern is the array index's: anchored, with no nested quantifier, and it never holds data.                                                                                                                                                                                                                   |
| 22  | A diff that writes or reads prototype names unsafely   | deep-object-diff CVE-2022-41713, jsondiffpatch CVE-2026-8657                                                                                       | `createPatch` reads members through descriptors and escapes each member name into its pointer. The patch it writes is applied as (1)–(5). A diff of documents holding `__proto__` or `constructor` round-trips as members.                                                                                            |
| 23  | A diff whose operations do not reproduce the target    | python-json-patch #160 (operations emitted in the wrong order)                                                                                     | The ROUND-TRIP property applies every patch it creates to the source and compares the result with the target.                                                                                                                                                                                                         |

Also not applicable: the integer overflows and heap bugs of C libraries (cJSON
CVE-2026-16554), since this is memory-safe code.

## What the caller owns

A patch library applies a patch to a document. It does not know who sent the patch, or what
they are allowed to read. These classes are about that:

- **`copy`, `move` and `test` read the document** (java-json-tools CVE-2026-86512, SurrealDB
  CVE-2026-63751 with an empty `from`). A patch can copy any value it can point to into a
  place its author can read. A `test` answers whether a value is what the author guessed,
  even when the author never sees the document: its pass or fail is an oracle. Whoever may
  apply a patch to a document can learn what the document holds, so write access must imply
  read access, or the patch must be limited to operations that read nothing.
  - **How it goes wrong.** A service whose write and read authorization are separate lets a
    principal hold one without the other. Such a principal cannot fetch the document, but a
    patch of `[{ op: "test", path: "/pin", value: guess }, { op: "replace", path: "/pin",
value: guess }]` fails for a wrong guess and succeeds for the right one, and
    `PATH_NOT_FOUND` tells it which members exist. The fix is in the service: a principal who
    may not read the document gets the same not-found answer as for a document that does not
    exist, whatever the patch asks, and nothing is applied. A create needs no read, since a
    new document starts empty.
- **Field-level authorization of what a patch writes.** Spring Data REST CVE-2026-41728
  checked the last segment of a path but not the ones above it, and CVE-2026-47849 left
  `@Id` and `@Version` writable. Capsule CVE-2024-39690 let a patch add the
  `ownerReferences` its webhook trusted, and Gardener CVE-2026-79767 checked only the
  `User` subjects a change added (a flaw in the check, reachable by any update, a patch
  among them). Field-level authorization must check every location a patch writes, and
  everything above it. Each location has exactly one spelling here (class 8 and 10) but
  one: an `add` reads `-` as the index one past the end, so `/list/-` and `/list/1` append
  to the same place in a one-item list. An authorizer that resolves `-` to that index first
  can compare pointer text soundly, unlike Caddy's in CVE-2026-45692. A service that
  authorizes a whole document has no field-level check to get wrong.
- **Rendering a diff as HTML** (jsondiffpatch CVE-2025-9910). This library renders nothing.
  A viewer that shows a patch must escape it.
- **The document is JSON**, a precondition (see the README), not validated in full. A class
  instance where the patch touches it is refused as an invariant error. A getter is not: an
  apply copies the object that holds it with spread, which runs the getter and copies what
  it returns, so a `replace` next to a getter succeeds. A document with getters is the
  caller's bug.
- **Limits sized to the service.** The defaults stop the worst patches found in about 150 ms
  and 50 MB. The hard limits are for trusted input only: a client's patch under the
  defaults, a replayed one from the service's own log under the hard limits.

## Catalogue

Grouped by ecosystem. "Class" refers to the table above.

### JavaScript

| Advisory                                                                | Library                | Fixed in            | Class    | Attack input                                                                      |
| ----------------------------------------------------------------------- | ---------------------- | ------------------- | -------- | --------------------------------------------------------------------------------- |
| SNYK-JS-FASTJSONPATCH-595663                                            | fast-json-patch        | 2.1.0 (Snyk: 2.2.1) | 1        | `{"op":"add","path":"/__proto__/x","value":1}`                                    |
| CVE-2021-4279, GHSA-8gh8-hqwg-xf34                                      | fast-json-patch        | 3.1.1               | 2        | `{"op":"replace","path":"/constructor/prototype/polluted","value":"x"}`           |
| (no advisory; #1845 in this repo)                                       | fast-json-patch 3.1.1  | open                | 7        | `{"op":"replace","path":"/constructor/keys","value":0}`                           |
| SNYK-JS-JSONPOINTER-598804                                              | jsonpointer            | 4.1.0               | 1        | `set({}, "/__proto__/polluted", true)`                                            |
| CVE-2021-23807, GHSA-282f-qqgm-c34q                                     | jsonpointer            | 5.0.0               | 3, 4     | `"/foo/__proto__/boo"`, and `[["__proto__"], ["__proto__"], "boo"]`               |
| CVE-2020-7709, GHSA-7mg4-w3w5-x5pc                                      | json-pointer           | 0.6.1               | 1        | `set({}, "/__proto__/x", v)`                                                      |
| CVE-2021-23820, GHSA-v5vg-g7rq-363w                                     | json-pointer           | 0.6.2               | 4        | `set({}, [["__proto__"]], v)`                                                     |
| CVE-2022-4742, GHSA-6xrf-q977-5vgc                                      | json-pointer           | 0.6.2               | 1, 2, 5  | as above; a final `/__proto__` still replaces the prototype in 0.6.2              |
| CVE-2020-7766, GHSA-x5r6-x823-9848                                      | json-ptr               | 2.1.0               | 1        | `set({}, "/__proto__/polluted", v, true)`, forcing the path                       |
| GHSA-rrqv-vjrw-hrcr (no CVE)                                            | json-ptr               | 2.1.0               | 12       | a pointer with a quote, compiled into `new Function` by `.get()`                  |
| CVE-2021-23509, GHSA-8gwj-8hxc-285w                                     | json-ptr               | 3.0.0               | 4        | pointer segments given as arrays                                                  |
| CVE-2021-4245, GHSA-p495-jxh2-wrfg                                      | rfc6902                | 5.0.0               | 1, 6     | `{"op":"add","path":"/__proto__/polluted","value":1}`; 5.x skips the segment      |
| CVE-2020-28477, GHSA-9qmh-276g-x5pj                                     | immer (`applyPatches`) | 8.0.1               | 1        | `{op:"add", path:["__proto__","polluted"], value:"yes"}`                          |
| CVE-2021-23436, GHSA-33f9-j839-rf8h; CVE-2021-3757, GHSA-c36v-fmgq-m8hx | immer                  | 9.0.6               | 4        | `path: [["__proto__"], "polluted"]`                                               |
| CVE-2020-7770, GHSA-7h43-gx24-p529                                      | json8                  | 1.0.3               | 1        | a pointer add through `__proto__`                                                 |
| CVE-2020-8268, GHSA-8v9x-9xqg-r8mr                                      | json8-merge-patch      | 1.0.3               | 5        | merge patch `{"__proto__": {…}}`                                                  |
| CVE-2022-41713, GHSA-653v-rqx9-j85p                                     | deep-object-diff       | 1.1.9               | 22       | `diff({}, JSON.parse('{"__proto__":{"x":1}}'))`                                   |
| CVE-2026-8657, GHSA-j4fx-xxwh-2485                                      | jsondiffpatch          | 0.7.6               | 1, 2, 22 | delta `{"__proto__":{"p":["x"]}}`; formatter `{"op":"add","path":"/__proto__/p"}` |
| CVE-2025-9910, GHSA-33vc-wfww-vjfv                                      | jsondiffpatch          | 0.7.2               | caller   | a diff rendered by its HTML formatter injects script                              |
| CVE-2020-15256, GHSA-cwx2-736x-mf6w                                     | object-path            | 0.11.5              | 1        | a path setter through `__proto__`                                                 |
| CVE-2021-23434, GHSA-v39p-96qg-c8rf                                     | object-path            | 0.11.6              | 4        | `["__proto__"]` as a segment                                                      |
| CVE-2021-3805, GHSA-8v63-cqqc-6r2c                                      | object-path            | 0.11.8              | 1        | `del()` through `__proto__`                                                       |
| CVE-2020-8116, GHSA-ff7x-qrg7-qggm                                      | dot-prop               | 4.2.1, 5.1.1        | 1        | `set({}, "__proto__.x", v)`                                                       |
| CVE-2019-10747, GHSA-4g88-fppr-53pp                                     | set-value              | 2.0.1, 3.0.1        | 1        | `set(obj, "a.__proto__.x", v)`                                                    |
| CVE-2021-23440, GHSA-4jqc-8m5r-9rpr                                     | set-value              | 2.0.1, 3.0.3, 4.0.1 | 4        | an array as a path segment                                                        |
| CVE-2026-48170, GHSA-9m6g-wc8r-q59c                                     | scim-patch             | 0.9.1               | 1        | a SCIM PATCH value `{"__proto__.isAdmin": true}`                                  |
| CVE-2025-69873, GHSA-2g4f-4pwh-qvx6                                     | ajv (`$data`)          | 8.18.0, 6.14.0      | 21       | a pattern `^(a\|a)*$` reached through a JSON Pointer                              |

### Go

| Advisory                               | Library                           | Fixed in                      | Class  | Attack input                                                                 |
| -------------------------------------- | --------------------------------- | ----------------------------- | ------ | ---------------------------------------------------------------------------- |
| CVE-2018-14632, GHSA-gxhv-3hwf-wjp9    | evanphx/json-patch                | 0.5.2                         | 9      | `{"op":"add","path":"/foo/2","value":"x"}` on `{"foo":["bar"]}`              |
| CVE-2019-1002100, GHSA-q4rr-64r9-fwgf  | Kubernetes apiserver (json-patch) | 1.11.8, 1.12.6, 1.13.4        | 17     | many `copy` operations doubling the object                                   |
| PR #70, #74 (no advisory)              | evanphx/json-patch                | opt-in limits, off by default | 17     | a 1 MB patch of copies growing arrays by ~10 M items                         |
| PR #222 (no advisory)                  | evanphx/json-patch v5             | open as of 2026-07            | 9      | `{"op":"add","path":"/a/2000000000","value":1}` with `EnsurePathExistsOnAdd` |
| issues #114, #158, #171, #90           | evanphx/json-patch                | various                       | 11, 13 | `test` of a missing path; `add /f/0` after `replace /f` with `null`          |
| `SupportNegativeIndices` (no advisory) | evanphx/json-patch                | on by default                 | 8      | `/list/-1` names the last member                                             |

### Python

| Advisory   | Library                          | Fixed in | Class | Attack input                                                                                      |
| ---------- | -------------------------------- | -------- | ----- | ------------------------------------------------------------------------------------------------- |
| issue #178 | python-json-patch                | open     | 11    | `{"op":"copy","from":"/foo/0","path":"/bar"}` on `{"foo":"should-not-be-indexable"}` copies `"s"` |
| issue #180 | python-json-patch (`make_patch`) | open     | 14    | `{"field":[1,1]}` against `{"field":[1,true]}` diffs as equal                                     |
| issue #160 | python-json-patch (`make_patch`) | open     | 23    | two chained `move`s, sometimes emitted in the wrong order                                         |
| issue #152 | python-json-patch                | open     | 13    | `remove /ownerships/0`, then `remove /ownerships/5/current` on 6 items: `IndexError`              |

### Java

| Advisory                            | Library                                  | Fixed in      | Class  | Attack input                                                         |
| ----------------------------------- | ---------------------------------------- | ------------- | ------ | -------------------------------------------------------------------- |
| CVE-2017-8046, GHSA-9qf9-28h9-hqcj  | Spring Data REST                         | 2.6.9, 3.0.1  | 12     | a JSON Patch path evaluated as SpEL                                  |
| CVE-2026-41729, GHSA-j388-8rm5-p97f | spring-data-rest-core                    | 5.0.6, 4.5.12 | 12     | a pointer segment used as a map key inside a SpEL expression         |
| CVE-2026-41728, GHSA-cv39-x4c6-hhp2 | spring-data-rest-core                    | 5.0.6, 4.5.12 | caller | a write check skipped for intermediate segments                      |
| CVE-2026-47849, GHSA-4xj4-jmcc-9rq7 | spring-data-rest-core                    | 5.1.1, 5.0.7  | caller | `@Id` and `@Version` writable through JSON Patch                     |
| CVE-2026-86512, GHSA-3pg6-r94f-fcvh | java-json-tools json-patch               | unpatched     | caller | `{"op":"copy","from":"/internal/passwordHash","path":"/public/bio"}` |
| CVE-2026-86318, GHSA-8hxc-hjmg-w3c7 | java-json-tools json-patch (merge patch) | unpatched     | 18     | `{"nested":{"nested":…}}` about 2000 deep                            |
| CVE-2026-86319, GHSA-7fc8-9vq7-8mjg | java-json-tools json-patch               | unpatched     | 17     | 50 000 `add` operations, each deep-copying the document              |
| CVE-2026-86513, GHSA-6924-jpg3-mjfw | jackson-coreutils                        | unpatched     | 20     | the pointer `/a` repeated 200 000 times                              |
| jackson-core #818 (no advisory)     | Jackson `JsonPointer.compile`            | 2.14.0        | 18     | a pointer of about 6000 segments                                     |

### C

| Advisory                            | Library | Fixed in     | Class | Attack input                                                          |
| ----------------------------------- | ------- | ------------ | ----- | --------------------------------------------------------------------- |
| CVE-2025-57052, GHSA-98j5-4649-rfv2 | cJSON   | 1.7.19       | 8     | the index `0A` read as 10 on an array of 3                            |
| CVE-2026-29036, GHSA-89cr-7g9x-rjgw | cJSON   | after 1.7.19 | 10    | `~0` and `~1` in a patch path decoded to another key                  |
| CVE-2026-67215, GHSA-5q3m-r3x7-8phg | cJSON   | after 1.7.19 | 18    | `add` and `copy` grafting subtrees until a recursive delete overflows |
| CVE-2026-67216, GHSA-ff2v-f99f-wm3f | cJSON   | after 1.7.19 | 19    | a document of about 40 levels of shared subtrees, compared            |
| CVE-2026-67217, GHSA-pr46-97qf-f32c | cJSON   | after 1.7.19 | 15    | a `replace` without a value deletes its target, then fails            |
| CVE-2026-87933, GHSA-7jcg-95pj-h5fp | cJSON   | after 1.7.19 | 13    | a merge patch that is not an object: use after free                   |
| CVE-2026-16554, GHSA-qv6q-8g2j-w47g | cJSON   | after 1.7.19 | —     | an escape counter overflowing on 32-bit                               |

### Applications

| Advisory                            | Product               | Class  | Attack input                                                                          |
| ----------------------------------- | --------------------- | ------ | ------------------------------------------------------------------------------------- |
| CVE-2026-63751, GHSA-fpxg-5xmv-922m | SurrealDB             | caller | `PATCH [{op:"copy", from:"", path:"/leak"}]` copies fields the reader may not see     |
| CVE-2026-45692, GHSA-x5w9-xh9r-mvfc | Caddy `/config` API   | 8      | allowed `/…/routes/0`, sent `/…/routes/01`: the authorizer and the traversal disagree |
| CVE-2024-39690, GHSA-mq69-4j5w-3qwp | Capsule (Kubernetes)  | caller | `add /metadata/ownerReferences` on a namespace the tenant does not own                |
| CVE-2026-79767, GHSA-gfjv-gqf2-c888 | Gardener              | caller | `add /spec/members/-` of the group `system:authenticated`                             |
| CVE-2026-82054, GHSA-6wc7-3wqm-rgrj | MongoDB `$jsonSchema` | 20     | a JSON Pointer with no limit on its work                                              |
| CVE-2026-56747, GHSA-c2q2-868h-6pj2 | Cribl Stream          | 12     | a JSON Pointer compiled into JavaScript                                               |

### Nothing published

No advisory was found for: Microsoft.AspNetCore.JsonPatch, Marvin.JsonPatch, JsonPatch.Net,
python-json-patch and jsonpointer, Ruby `hana` and `json-patch`, PHP php-jsonpatch and
swaggest/json-diff, go-openapi/jsonpointer, wI2L/jsondiff, gomodules/jsonpatch,
mattbaird/jsonpatch, the Rust `json-patch` and `jsonptr` crates, microdiff, just-diff-apply,
immutable-json-patch and json8-patch. Scanners flag CVE-2017-11883 on
Microsoft.AspNetCore.JsonPatch, but it is a general ASP.NET Core denial of service, not a
flaw in the patch code.

## Keeping this current

A new advisory is either one of the classes above or a new one. For either, add its attack
input to `src/cve-regressions.test.ts` and its row to the catalogue. A new class gets a row
in the class table saying what refuses it, or a fix first.
