import fc from "fast-check";
import { expect, test } from "vitest";

import {
  applyPatch,
  JsonPatchError,
  parsePatch,
  type JsonPatchLimits,
  type JsonPatchResult,
  type JsonValue,
} from "./index.js";
import { parsePointer } from "./pointer.js";
import {
  documentArb,
  formatPointer,
  jsonArb,
  MEMBER_NAMES,
  passingTestsArb,
  scenarioArb,
} from "./test/arbitraries.js";
import {
  containerCounts,
  deepFreeze,
  jsonCost,
  jsonDepth,
  jsonValueCount,
} from "./test/json-helpers.js";
import { propertyParameters, propertyTimeoutMs } from "./test/property-runs.js";
import { referenceApply, toTree, treeEqual, type Tree } from "./test/reference-model.js";
import { okValue } from "./test/results.js";

// The library's contract, as properties over generated documents and patches:
//
//   DIFFERENTIAL   — parse + apply agrees with src/test/reference-model.ts, an independent,
//                    deliberately naive implementation of the same contract: the same
//                    result, or a failure with the same code at the same operation.
//   TOTAL          — for ANY input (fast-check's `anything`, including getters' absence,
//                    null prototypes, boxed values, sparse arrays, bigints), parsePatch and
//                    applyPatch return a result; nothing else is ever thrown.
//   PURE           — the document is deep-frozen before every apply, so a single write to
//                    it would throw (and fail TOTAL); it also stays equal to its snapshot.
//   UNSHARED       — the result holds no container of the patch, holds no container twice
//                    that the document held once, and two applies of one parsed patch share
//                    only what they share with the document.
//   PROTOTYPES     — no apply changes Object.prototype or Array.prototype.
//   LIMITS-REFUSE  — under random, tight limits the only new outcome is LIMIT_EXCEEDED: a
//                    success is the reference's success, and within the limits' bounds (cost
//                    grows by at most maxApplyWork, the count of values by at most
//                    maxApplyValues; nothing new nests past maxDepth).
//   LAWS           — applying p1 ++ p2 is applying p1 then p2; a patch of `test`s returns
//                    the document itself; an add undone by a remove leaves the document.
//   CANONICAL      — every key has exactly one pointer spelling: format ∘ parse and
//                    parse ∘ format are identities.

const PROPERTY_RUNS = 2000;
const PROPERTY_TIMEOUT_MS = propertyTimeoutMs(20_000);

function run(
  document: unknown,
  patch: unknown,
  limits?: Partial<JsonPatchLimits>,
): JsonPatchResult<JsonValue> {
  const parsed = parsePatch(patch, limits);
  return parsed.ok ? applyPatch(document as JsonValue, parsed.value, limits) : parsed;
}

function outcome(result: JsonPatchResult<JsonValue>) {
  return result.ok
    ? { ok: true, value: toTree(result.value) }
    : { ok: false, code: result.error.code, index: result.error.operationIndex };
}

// The outcome of applying `first`'s result then `next`: `first`'s refusal, or `next`'s with its
// operation index shifted past the `firstLength` operations before it.
function sequenced(
  first: JsonPatchResult<JsonValue>,
  next: readonly unknown[],
  firstLength: number,
) {
  if (!first.ok) return outcome(first);
  const second = run(first.value, next);
  return second.ok
    ? outcome(second)
    : { ...outcome(second), index: (second.error.operationIndex ?? 0) + firstLength };
}

function expectAgreement(
  actual: JsonPatchResult<JsonValue>,
  expected: ReturnType<typeof referenceApply>,
) {
  // Two values compare as trees (`treeEqual`, where 0 equals -0); anything else by outcome.
  /* oxlint-disable vitest/no-conditional-expect */
  if (expected.ok && actual.ok) {
    const tree = toTree(actual.value);
    expect(tree, "the result is JSON").toBeDefined();
    expect(treeEqual(tree as Tree, expected.value), "the result equals the reference's").toBe(true);
  } else {
    expect(outcome(actual)).toEqual(expected.ok ? { ok: true, value: expected.value } : expected);
  }
  /* oxlint-enable vitest/no-conditional-expect */
}

// What an apply must never change: the members of the two prototypes a JSON value has.
function prototypeFingerprint(): string[] {
  const describe = (proto: object) =>
    Reflect.ownKeys(proto).map((key) => `${String(key)}:${typeof Reflect.get(proto, key)}`);
  return [...describe(Object.prototype), "|", ...describe(Array.prototype)];
}

test(
  "DIFFERENTIAL, PURE, PROTOTYPES: parse + apply agrees with the reference model",
  () => {
    const fingerprint = prototypeFingerprint();
    fc.assert(
      fc.property(scenarioArb, ({ document, patch }) => {
        deepFreeze(document);
        const before = toTree(document);
        expect(before).toBeDefined();
        expectAgreement(run(document, patch), referenceApply(before as Tree, patch));
        expect(
          treeEqual(toTree(document) as Tree, before as Tree),
          "the document is unchanged",
        ).toBe(true);
        expect(prototypeFingerprint()).toEqual(fingerprint);
        expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
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

const looseOperationArb = fc.record(
  {
    op: fc.oneof(fc.constantFrom("add", "remove", "replace", "move", "copy", "test"), anythingArb),
    path: fc.oneof(fc.string(), anythingArb),
    from: fc.oneof(fc.string(), anythingArb),
    value: anythingArb,
  },
  { requiredKeys: [] },
);

test(
  "TOTAL: any input comes back as a result, never as a throw",
  () => {
    fc.assert(
      fc.property(
        documentArb,
        fc.oneof(anythingArb, fc.array(anythingArb), fc.array(looseOperationArb)),
        (document, patch) => {
          const result = run(deepFreeze(document), patch);
          expect(result.ok || result.error instanceof JsonPatchError).toBe(true);
        },
      ),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "UNSHARED: a result shares no container with the patch, nor one it did not have",
  () => {
    fc.assert(
      fc.property(scenarioArb, ({ document, patch }) => {
        const parsed = parsePatch(patch);
        if (!parsed.ok) return;
        const first = applyPatch(document as JsonValue, parsed.value);
        const second = applyPatch(document as JsonValue, parsed.value);
        if (!first.ok || !second.ok) return;
        const inDocument = containerCounts(document);
        const inPatch = containerCounts(patch);
        const inFirst = containerCounts(first.value);
        for (const [container, count] of inFirst) {
          expect(inPatch.has(container), "a patch container in the result").toBe(false);
          expect(count, "a container held twice").toBeLessThanOrEqual(
            Math.max(1, inDocument.get(container) ?? 0),
          );
        }
        const shared = [...containerCounts(second.value).keys()].filter((container) =>
          inFirst.has(container),
        );
        for (const container of shared) {
          expect(inDocument.has(container), "two results share").toBe(true);
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
  "LIMITS-REFUSE: a limit only ever turns an outcome into LIMIT_EXCEEDED",
  () => {
    fc.assert(
      fc.property(scenarioArb, tightLimitsArb, ({ document, patch }, limits) => {
        const actual = run(deepFreeze(document), patch, limits);
        if (!actual.ok && actual.error.code === "LIMIT_EXCEEDED") return;
        expectAgreement(actual, referenceApply(toTree(document) as Tree, patch));
        if (!actual.ok) return;
        const work = limits.maxApplyWork ?? Number.POSITIVE_INFINITY;
        expect(jsonCost(actual.value)).toBeLessThanOrEqual(jsonCost(document) + work);
        const values = limits.maxApplyValues ?? Number.POSITIVE_INFINITY;
        expect(jsonValueCount(actual.value)).toBeLessThanOrEqual(jsonValueCount(document) + values);
        const maxDepth = limits.maxDepth ?? Number.POSITIVE_INFINITY;
        expect(jsonDepth(actual.value)).toBeLessThanOrEqual(
          Math.max(jsonDepth(document), maxDepth),
        );
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "LAWS: p1 ++ p2 applies as p1 then p2",
  () => {
    fc.assert(
      fc.property(scenarioArb, ({ document, patch: p1, next: p2 }) => {
        if (!parsePatch(p1).ok || !parsePatch(p2).ok) return;
        const whole = run(document, [...p1, ...p2]);
        expect(outcome(whole)).toEqual(sequenced(run(document, p1), p2, p1.length));
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "LAWS: a patch of tests that pass returns the document itself",
  () => {
    fc.assert(
      fc.property(passingTestsArb, ({ document, patch }) => {
        const result = run(document, patch);
        expect(result.ok && result.value).toBe(document);
      }),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "LAWS: an add of a new member undone by its remove leaves the document",
  () => {
    fc.assert(
      fc.property(
        documentArb,
        fc.constantFrom(...MEMBER_NAMES),
        jsonArb,
        (document, key, value) => {
          const isObject =
            typeof document === "object" && document !== null && !Array.isArray(document);
          if (!isObject || Object.hasOwn(document, key)) return;
          const path = formatPointer([key]);
          const result = run(document, [
            { op: "add", path, value },
            { op: "remove", path },
          ]);
          expect(treeEqual(toTree(okValue(result)) as Tree, toTree(document) as Tree)).toBe(true);
        },
      ),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "CANONICAL: every token list has one pointer spelling, and every pointer one token list",
  () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "grapheme" }), { maxLength: 4 }),
        fc.string(),
        (tokens, text) => {
          const pointer = formatPointer(tokens);
          const parsed = parsePointer(pointer, 1_000_000, 1_000);
          expect(parsed).toEqual({ ok: true, tokens });
          const other = parsePointer(text, 1_000_000, 1_000);
          // oxlint-disable-next-line vitest/no-conditional-expect -- only a pointer that parses has a spelling to keep
          if (other.ok) expect(formatPointer(other.tokens)).toBe(text);
        },
      ),
      propertyParameters(PROPERTY_RUNS),
    );
  },
  PROPERTY_TIMEOUT_MS,
);
