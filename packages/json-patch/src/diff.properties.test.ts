import fc from "fast-check";
import fastJsonPatch from "fast-json-patch";
import { expect, test } from "vitest";

import {
  applyPatch,
  createPatch,
  HARD_LIMITS,
  JsonPatchError,
  parsePatch,
  type JsonValue,
  type Operation,
} from "./index.js";
import { parsePointer } from "./pointer.js";
import { documentArb, scenarioArb } from "./test/arbitraries.js";
import { containerCounts, deepFreeze } from "./test/json-helpers.js";
import { propertyParameters, propertyTimeoutMs } from "./test/property-runs.js";
import { toTree, treeEqual, type Tree } from "./test/reference-model.js";

// createPatch's contract, as properties over generated pairs of documents:
//
//   ROUND-TRIP    — the patch parses, and applied to the source yields the target, with and
//                   without tests; neither document is written to (both are deep-frozen)
//                   and no prototype changes.
//   DIFFERENTIAL  — where fast-json-patch's compare is right (two roots of one container
//                   kind), the patch is compare's, operation for operation, byte for byte.
//   IDENTITY      — a document diffed against itself, or a deep copy of itself, is [].
//   STABLE        — every write names the same location in source and target: a replace one
//                   both have, a remove one only the source has, an add one only the target
//                   has; no two writes overlap; every test guards the write after it with
//                   the value the source holds there, and every replace and remove has
//                   one. So the patch shifts no index.
//   GUARDED       — with tests, applied to ANY document, a success means that document held
//                   the source's value at every guarded location.
//   LIMITS        — under tight random limits the only new outcome is LIMIT_EXCEEDED, and a
//                   patch-side refusal is exactly parsePatch's: the patch comes back iff it
//                   parses under the same limits.
//   TOTAL         — any pair of inputs comes back as a result, never a throw, and a patch
//                   that comes back parses.
//   UNSHARED      — the patch is frozen and shares no container with either document.
//
// Pairs are drawn two ways: independently (the small member-name alphabet makes them share
// and miss paths constantly), and as a document with a patch of it applied — which shares
// every container the patch left alone, so the identity shortcut is walked too.

const PROPERTY_RUNS = 1000;
const PROPERTY_TIMEOUT_MS = propertyTimeoutMs(20_000);

function applyTo(document: unknown, patch: unknown): JsonValue | undefined {
  const parsed = parsePatch(patch);
  if (!parsed.ok) return undefined;
  const applied = applyPatch(document as JsonValue, parsed.value);
  return applied.ok ? applied.value : undefined;
}

const pairArb: fc.Arbitrary<{ source: unknown; target: unknown }> = fc.oneof(
  fc.record({ source: documentArb, target: documentArb }),
  scenarioArb.map(({ document, patch }) => ({
    source: document,
    target: applyTo(document, patch) ?? document,
  })),
);

function patchOf(source: unknown, target: unknown, tests: boolean): readonly Operation[] {
  const result = createPatch(source, target, { tests, limits: HARD_LIMITS });
  if (!result.ok) throw result.error;
  return result.value;
}

function prototypeFingerprint(): string[] {
  const describe = (proto: object) =>
    Reflect.ownKeys(proto).map((key) => `${String(key)}:${typeof Reflect.get(proto, key)}`);
  return [...describe(Object.prototype), "|", ...describe(Array.prototype)];
}

test(
  "ROUND-TRIP: the patch parses and turns the source into the target",
  () => {
    const fingerprint = prototypeFingerprint();
    fc.assert(
      fc.property(pairArb, fc.boolean(), ({ source, target }, tests) => {
        deepFreeze(source);
        deepFreeze(target);
        const before = toTree(source) as Tree;
        const result = applyTo(source, patchOf(source, target, tests));
        expect(result, "the patch applies").toBeDefined();
        expect(treeEqual(toTree(result) as Tree, toTree(target) as Tree)).toBe(true);
        expect(treeEqual(toTree(source) as Tree, before), "the source is unchanged").toBe(true);
        expect(prototypeFingerprint()).toEqual(fingerprint);
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

test(
  "DIFFERENTIAL: where compare is right, the patch is fast-json-patch's",
  () => {
    fc.assert(
      fc.property(pairArb, fc.boolean(), ({ source, target }, tests) => {
        const sameRootKind =
          isContainer(source) &&
          isContainer(target) &&
          Array.isArray(source) === Array.isArray(target);
        fc.pre(sameRootKind);
        const expected = fastJsonPatch.compare(source as object, target as object, tests);
        // Compared as JSON text: key order and all, but -0 as 0 — compare copies values
        // through JSON, which drops the sign.
        expect(JSON.stringify(patchOf(source, target, tests))).toBe(JSON.stringify(expected));
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "IDENTITY: a document against itself or a deep copy of itself is the empty patch",
  () => {
    fc.assert(
      fc.property(documentArb, fc.boolean(), (document, tests) => {
        expect(patchOf(document, document, tests)).toEqual([]);
        expect(patchOf(document, structuredClone(document), tests)).toEqual([]);
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

// The value `pointer` names in `document`, or undefined — resolved independently of the
// library, through own members only.
function resolve(document: unknown, pointer: string): unknown {
  const parsed = parsePointer(pointer, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  expect(parsed.ok, "an emitted pointer parses").toBe(true);
  let value = document;
  for (const token of parsed.ok ? parsed.tokens : []) {
    if (!isContainer(value)) return undefined;
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
    if (!Object.hasOwn(value, token)) return undefined;
    value = Object.getOwnPropertyDescriptor(value, token)?.value;
  }
  return value;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a === "" || b === "";
}

test(
  "STABLE: every write names one location in both documents, and none overlap",
  () => {
    fc.assert(
      fc.property(pairArb, ({ source, target }) => {
        const operations = patchOf(source, target, true);
        const writes = operations.filter((operation) => operation.op !== "test");
        writes.forEach((operation, index) => {
          const inSource = resolve(source, operation.path) !== undefined;
          const inTarget = resolve(target, operation.path) !== undefined;
          expect([operation.op, inSource, inTarget]).toEqual(
            operation.op === "add"
              ? ["add", false, true]
              : operation.op === "remove"
                ? ["remove", true, false]
                : ["replace", true, true],
          );
          for (const other of writes.slice(index + 1)) {
            expect(overlaps(operation.path, other.path), "two writes overlap").toBe(false);
          }
        });
        const guardedWrites = operations.flatMap((operation, index) =>
          operation.op === "replace" || operation.op === "remove" ? [{ operation, index }] : [],
        );
        for (const { operation, index } of guardedWrites) {
          expect(operations.at(index - 1)).toMatchObject({ op: "test", path: operation.path });
        }
        operations.forEach((operation, index) => {
          if (operation.op !== "test") return;
          const next = operations.at(index + 1);
          expect(next?.op === "replace" || next?.op === "remove").toBe(true);
          expect(next?.path).toBe(operation.path);
          const guarded = toTree(resolve(source, operation.path)) as Tree;
          expect(treeEqual(guarded, toTree(operation.value) as Tree)).toBe(true);
        });
        const unguarded = patchOf(source, target, false);
        expect(unguarded).toEqual(writes);
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "GUARDED: a guarded patch applies only to a document that holds what the source held",
  () => {
    fc.assert(
      fc.property(pairArb, documentArb, ({ source, target }, other) => {
        const operations = patchOf(source, target, true);
        if (applyTo(other, operations) === undefined) return;
        for (const operation of operations) {
          if (operation.op !== "test") continue;
          const held = toTree(resolve(other, operation.path));
          expect(held, "a guarded location exists").toBeDefined();
          expect(treeEqual(held as Tree, toTree(operation.value) as Tree)).toBe(true);
        }
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

const tightLimitsArb = fc.record(
  {
    maxOperations: fc.integer({ min: 1, max: 12 }),
    maxPointerLength: fc.integer({ min: 1, max: 24 }),
    maxDepth: fc.integer({ min: 1, max: 5 }),
    maxPatchCost: fc.integer({ min: 1, max: 400 }),
    maxApplyWork: fc.integer({ min: 1, max: 400 }),
    maxApplyValues: fc.integer({ min: 1, max: 100 }),
  },
  { requiredKeys: [] },
);

test(
  "LIMITS: a limit only refuses, and refuses a patch exactly when parsePatch would",
  () => {
    fc.assert(
      fc.property(pairArb, fc.boolean(), tightLimitsArb, ({ source, target }, tests, limits) => {
        const unlimited = patchOf(source, target, tests);
        const limited = createPatch(source, target, { tests, limits });
        const parsed = parsePatch(unlimited, limits);
        // Each outcome has its own oracle: a patch equals the unlimited one, a refusal is a limit's.
        /* oxlint-disable vitest/no-conditional-expect */
        if (limited.ok) {
          expect(limited.value).toEqual(unlimited);
          expect(parsed.ok, "a patch that comes back parses under its limits").toBe(true);
          return;
        }
        expect(limited.error.code).toBe("LIMIT_EXCEEDED");
        // The walk's own limits refuse before any patch exists; any other refusal is the
        // patch's, and parsePatch refuses the whole patch too.
        if (!limited.error.message.startsWith("the diff exceeds")) {
          expect(parsed.ok ? "parsed" : parsed.error.code).toBe("LIMIT_EXCEEDED");
        }
        /* oxlint-enable vitest/no-conditional-expect */
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

const anythingArb = fc.anything({
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withNullPrototype: true,
  withObjectString: true,
  withSet: true,
  withSparseArray: true,
  withTypedArray: true,
  withUnicodeString: true,
});

test(
  "TOTAL: any pair of inputs comes back as a result, and a patch that does parses",
  () => {
    fc.assert(
      fc.property(
        fc.oneof(anythingArb, documentArb),
        fc.oneof(anythingArb, documentArb),
        fc.boolean(),
        (source, target, tests) => {
          const result = createPatch(source, target, { tests });
          if (!result.ok) {
            // oxlint-disable-next-line vitest/no-conditional-expect -- the oracle for a refusal
            expect(result.error).toBeInstanceOf(JsonPatchError);
            return;
          }
          expect(parsePatch(result.value).ok).toBe(true);
        },
      ),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "UNSHARED: the patch is frozen and holds no container of either document",
  () => {
    fc.assert(
      fc.property(pairArb, fc.boolean(), ({ source, target }, tests) => {
        const operations = patchOf(source, target, tests);
        const inDocuments = new Set([
          ...containerCounts(source).keys(),
          ...containerCounts(target).keys(),
        ]);
        for (const container of containerCounts(operations).keys()) {
          expect(Object.isFrozen(container), "a container of the patch is frozen").toBe(true);
          expect(inDocuments.has(container), "the patch shares a container").toBe(false);
        }
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);
