import { describe, expect, test, vi } from "vitest";

import {
  ApplyBudget,
  applyPatch,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  JsonPatchError,
  JsonPatchInvariantError,
  parsePatch,
  type JsonPatchLimits,
  type JsonPatchResult,
  type JsonValue,
} from "./index.js";
import { deepFreeze } from "./test/json-helpers.js";
import { errorOf } from "./test/results.js";

function patch(operations: unknown, limits?: Partial<JsonPatchLimits>) {
  const parsed = parsePatch(operations, limits);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function apply(
  document: unknown,
  operations: unknown,
  limits?: Partial<JsonPatchLimits>,
): JsonPatchResult<JsonValue> {
  return applyPatch(deepFreeze(document) as JsonValue, patch(operations, limits), limits);
}

function outcome(result: JsonPatchResult<JsonValue>) {
  return result.ok ? result.value : `${result.error.code}: ${result.error.message}`;
}

describe("add", () => {
  test.each([
    ["a new member", { a: 1 }, "/b", { a: 1, b: 2 }],
    ["an existing member, replaced", { a: 1 }, "/a", { a: 2 }],
    ["the member named ''", {}, "/", { "": 2 }],
    ["an index, inserting", [1, 3], "/1", [1, 2, 3]],
    ["the end index", [1], "/1", [1, 2]],
    ["the end, as '-'", [1], "/-", [1, 2]],
    ["the root", { a: 1 }, "", 2],
    ["'-' as a member name of an object", {}, "/-", { "-": 2 }],
    ["'01' as a member name of an object", {}, "/01", { "01": 2 }],
  ])("at %s", (_, document, path, expected) => {
    expect(outcome(apply(document, [{ op: "add", path, value: 2 }]))).toEqual(expected);
  });

  test.each([
    ["past the end of an array", [1], "/2"],
    ["a non-index token of an array", [1], "/a"],
    ["a leading-zero index", [1, 2], "/01"],
    ["a missing parent", {}, "/a/b"],
    ["inside a scalar", { a: 1 }, "/a/b"],
    ["under a scalar root", 1, "/a"],
    ["'-' in the middle of a path", [[1]], "/-/0"],
  ])("fails %s", (_, document, path) => {
    expect(outcome(apply(document, [{ op: "add", path, value: 2 }]))).toBe(
      `PATH_NOT_FOUND: operation 0: path ${JSON.stringify(path)} does not resolve`,
    );
  });
});

describe("remove, replace, test", () => {
  test("remove takes out a member or an index", () => {
    expect(outcome(apply({ a: 1, b: 2 }, [{ op: "remove", path: "/a" }]))).toEqual({ b: 2 });
    expect(outcome(apply([1, 2, 3], [{ op: "remove", path: "/1" }]))).toEqual([1, 3]);
  });

  test.each([
    ["a missing member", { a: 1 }, "/b"],
    ["'-'", [1], "/-"],
    ["an index past the end", [1], "/1"],
    ["an inherited member", {}, "/toString"],
    ["an array's own length", [1], "/length"],
  ])("remove and replace of %s fail", (_, document, path) => {
    for (const op of ["remove", "replace"]) {
      const operation = op === "remove" ? { op, path } : { op, path, value: 0 };
      expect(outcome(apply(document, [operation]))).toMatch(/^PATH_NOT_FOUND/);
    }
  });

  test("replace keeps the member's place in the key order", () => {
    const result = apply({ a: 1, b: 2, c: 3 }, [{ op: "replace", path: "/b", value: 4 }]);
    expect(result.ok && Object.keys(result.value as object)).toEqual(["a", "b", "c"]);
  });

  test("a test compares by JSON value, not by identity or key order", () => {
    const document = { a: { x: [1, { y: null }], z: "s" } };
    expect(
      apply(document, [{ op: "test", path: "/a", value: { z: "s", x: [1, { y: null }] } }]).ok,
    ).toBe(true);
    expect(apply({ n: -0 }, [{ op: "test", path: "/n", value: 0 }]).ok).toBe(true);
  });

  test.each([
    ["a number and a string", { a: 1 }, "1"],
    ["a shorter array", { a: [1, 2] }, [1]],
    ["an object with a member more", { a: {} }, { b: null }],
    ["an object with a member less", { a: { b: null } }, {}],
    ["an object with other member names", { a: { b: null } }, { c: null }],
    ["null and false", { a: null }, false],
    ["two normalizations of é", { a: "é" }, "é"],
  ])("a test fails on %s", (_, document, value) => {
    expect(outcome(apply(document, [{ op: "test", path: "/a", value }]))).toBe(
      'TEST_FAILED: operation 0: test of "/a" failed',
    );
  });

  test("a test of a location with no value fails", () => {
    expect(outcome(apply({}, [{ op: "test", path: "/a", value: null }]))).toMatch(/^TEST_FAILED/);
    expect(outcome(apply({ a: 1 }, [{ op: "test", path: "/a/b", value: 1 }]))).toMatch(
      /^TEST_FAILED/,
    );
  });
});

describe("move and copy", () => {
  test("move removes, then adds — indices shift in between", () => {
    expect(outcome(apply([1, 2, 3], [{ op: "move", from: "/0", path: "/2" }]))).toEqual([2, 3, 1]);
    expect(outcome(apply({ a: { b: 1 } }, [{ op: "move", from: "/a/b", path: "/c" }]))).toEqual({
      a: {},
      c: 1,
    });
    expect(outcome(apply({ a: { b: 1 } }, [{ op: "move", from: "/a/b", path: "/a" }]))).toEqual({
      a: 1,
    });
  });

  test("move onto itself is a no-op, once its from resolves", () => {
    expect(outcome(apply({ a: 1 }, [{ op: "move", from: "/a", path: "/a" }]))).toEqual({ a: 1 });
    expect(outcome(apply({}, [{ op: "move", from: "/a", path: "/a" }]))).toMatch(/^FROM_NOT_FOUND/);
    expect(outcome(apply(1, [{ op: "move", from: "", path: "" }]))).toBe(1);
  });

  test("copy places a deep copy that shares nothing with its source", () => {
    const result = apply({ a: { b: [1] } }, [{ op: "copy", from: "/a", path: "/c" }]);
    if (!result.ok) throw result.error;
    const value = result.value as { a: { b: number[] }; c: { b: number[] } };
    expect(value.c).toEqual(value.a);
    expect(value.c).not.toBe(value.a);
    expect(value.c.b).not.toBe(value.a.b);
  });

  test("a missing from fails as FROM_NOT_FOUND", () => {
    expect(outcome(apply({}, [{ op: "copy", from: "/a", path: "/b" }]))).toBe(
      'FROM_NOT_FOUND: operation 0: from "/a" does not resolve',
    );
  });
});

describe("the result", () => {
  test("shares every container the patch did not touch with the document", () => {
    const document = { touched: { list: [1] }, untouched: { deep: [2] } };
    const result = apply(document, [{ op: "add", path: "/touched/list/-", value: 3 }]);
    if (!result.ok) throw result.error;
    const value = result.value as typeof document;
    expect(value.untouched).toBe(document.untouched);
    expect(value.touched).not.toBe(document.touched);
    expect(value.touched.list).toEqual([1, 3]);
    expect(document.touched.list).toEqual([1]);
  });

  test("is the document itself when the patch changes nothing", () => {
    const document = { a: 1 };
    expect(apply(document, []).ok && apply(document, []).ok).toBe(true);
    const result = applyPatch(document, patch([{ op: "test", path: "/a", value: 1 }]));
    expect(result.ok && result.value).toBe(document);
  });

  test("is all or nothing: a failure leaves no trace in the document", () => {
    const document = deepFreeze({ a: [1], b: { c: 1 } });
    const result = applyPatch(
      document,
      patch([
        { op: "add", path: "/a/-", value: 2 },
        { op: "remove", path: "/b/c" },
        { op: "test", path: "/b/c", value: 1 },
      ]),
    );
    expect(outcome(result)).toBe('TEST_FAILED: operation 2: test of "/b/c" failed');
    expect(document).toEqual({ a: [1], b: { c: 1 } });
  });
});

describe("prototype names are member names", () => {
  test("__proto__ is added, replaced, tested and removed as a member", () => {
    const result = apply({}, [
      { op: "add", path: "/__proto__", value: { polluted: true } },
      { op: "test", path: "/__proto__", value: { polluted: true } },
      { op: "replace", path: "/__proto__/polluted", value: false },
      { op: "copy", from: "/__proto__", path: "/constructor" },
    ]);
    if (!result.ok) throw result.error;
    const value = result.value as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__", "constructor"]);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const removed = applyPatch(value as JsonValue, patch([{ op: "remove", path: "/__proto__" }]));
    expect(removed.ok && Object.keys(removed.value as object)).toEqual(["constructor"]);
  });

  test("a move through an array's inherited members finds nothing (#1845)", () => {
    for (const from of ["/list/constructor/isArray", "/list/length", "/list/toString"]) {
      expect(outcome(apply({ list: [1, 2] }, [{ op: "move", from, path: "/x" }]))).toMatch(
        /^FROM_NOT_FOUND/,
      );
    }
    expect(typeof Array.isArray).toBe("function");
  });
});

describe("limits", () => {
  // Each copy of the root to a new member doubles the document: 40 of them would make 2^40
  // values. The budget charged for copies doubles with it, so whichever of the two apply
  // limits the values exhaust first stops the patch, long before it explodes.
  const doubling = (seed: unknown[]) => {
    const operations = [...seed];
    for (let round = 0; round < 40; round++)
      operations.push({ op: "copy", from: "", path: `/${round}` });
    return operations;
  };

  test("copy doubling of long strings is stopped by maxApplyWork", () => {
    // A copy shares a string but is charged its length: 16 MiB of work runs out at the
    // 14th copy, when the document holds 8192 strings of 1 KiB.
    const operations = doubling([{ op: "add", path: "/a", value: "x".repeat(1024) }]);
    expect(outcome(apply({}, operations, { maxDepth: 64 }))).toBe(
      "LIMIT_EXCEEDED: operation 14: the apply exceeds maxApplyWork",
    );
  });

  test("copy doubling of small values is stopped by maxApplyValues", () => {
    // Each value is an allocation however little it costs to serialize: 256 Ki values run
    // out at the 17th copy. Under maxApplyWork alone this patch allocated millions of
    // objects (seconds of CPU, hundreds of MB) before its characters added up.
    const operations = doubling([{ op: "add", path: "/a", value: { b: 1 } }]);
    expect(outcome(apply({}, operations, { maxDepth: 64 }))).toBe(
      "LIMIT_EXCEEDED: operation 17: the apply exceeds maxApplyValues",
    );
  });

  test("applies that share a budget are bounded together, as one apply would be", () => {
    // The doubling above, an operation per apply: each apply alone copies no more than the
    // document so far, but a shared budget runs out where the single apply did.
    const operations = doubling([{ op: "add", path: "/a", value: { b: 1 } }]);
    const budget = new ApplyBudget({ maxDepth: 64 });
    let document: JsonValue = {};
    let refused: string | undefined;
    for (const [index, operation] of operations.entries()) {
      const result = applyPatch(document, patch([operation]), budget);
      if (!result.ok) {
        refused = `${index}: ${result.error.message}`;
        break;
      }
      document = result.value;
    }
    expect(refused).toBe("17: operation 0: the apply exceeds maxApplyValues");
  });

  test("a failed apply's spending stays spent", () => {
    const list = Array.from({ length: 10 }, (_, i) => i);
    const differs = [...list.slice(0, 9), 99];
    const append = patch([{ op: "add", path: "/-", value: 0 }]);
    const budget = new ApplyBudget({ maxApplyValues: 20 });
    // The operation, the root, its 10 members: 12 values paid before the last one differs.
    expect(
      outcome(applyPatch(list, patch([{ op: "test", path: "", value: differs }]), budget)),
    ).toMatch(/^TEST_FAILED/);
    // The operation, the value, the copy-on-write copy of 10: 12 more do not fit in 8.
    expect(outcome(applyPatch(list, append, budget))).toBe(
      "LIMIT_EXCEEDED: operation 0: the apply exceeds maxApplyValues",
    );
    expect(applyPatch(list, append, { maxApplyValues: 20 }).ok).toBe(true);
  });

  test("a shared budget holds each apply to its maxDepth", () => {
    const budget = new ApplyBudget({ maxDepth: 1 });
    const deep = patch([{ op: "add", path: "/a", value: [0] }]);
    for (let round = 0; round < 2; round++) {
      expect(outcome(applyPatch({}, deep, budget))).toBe(
        "LIMIT_EXCEEDED: operation 0: the value would be nested deeper than maxDepth at its path",
      );
    }
  });

  test("a budget is made from limits, and holds them to their range", () => {
    expect(() => new ApplyBudget({ maxApplyValues: 0 })).toThrow(RangeError);
    // Limits that are not a budget are this apply's own: nothing carries over.
    const limits = { maxApplyValues: 5 };
    const five = patch([{ op: "add", path: "/a", value: [1, 2, 3] }]);
    expect(applyPatch({}, five, limits).ok).toBe(true);
    expect(applyPatch({}, five, limits).ok).toBe(true);
  });

  test("a move that deepens the document past maxDepth is refused", () => {
    const document = { a: [[[1]]], b: { c: {} } };
    expect(
      outcome(apply(document, [{ op: "move", from: "/a", path: "/b/c/d" }], { maxDepth: 5 })),
    ).toBe(
      "LIMIT_EXCEEDED: operation 0: the value would be nested deeper than maxDepth at its path",
    );
    expect(apply(document, [{ op: "move", from: "/a", path: "/b/c/d" }], { maxDepth: 6 }).ok).toBe(
      true,
    );
  });

  test("a copy that deepens the document past maxDepth is refused", () => {
    expect(
      outcome(
        apply({ a: [[1]], b: {} }, [{ op: "copy", from: "/a", path: "/b/c" }], { maxDepth: 3 }),
      ),
    ).toMatch(/^LIMIT_EXCEEDED/);
  });

  test("a test of a huge value is paid for", () => {
    const big = Array.from({ length: 1000 }, (_, i) => i);
    expect(
      outcome(apply({ a: big }, [{ op: "test", path: "/a", value: big }], { maxApplyWork: 500 })),
    ).toMatch(/^LIMIT_EXCEEDED/);
  });

  test("copy-on-write of a wide container is paid for", () => {
    const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
    expect(
      outcome(apply(wide, [{ op: "add", path: "/x", value: 1 }], { maxApplyWork: 500 })),
    ).toMatch(/^LIMIT_EXCEEDED/);
    expect(apply(wide, [{ op: "add", path: "/x", value: 1 }], { maxApplyWork: 1100 }).ok).toBe(
      true,
    );
  });

  test("running out of work copying a container partway down a path is LIMIT_EXCEEDED", () => {
    // The root and "a" have one member each; "b" has 1000, so its copy is what runs out.
    const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
    const document = { a: { b: { ...wide, c: {} } } };
    const operation = [{ op: "add", path: "/a/b/c/x", value: 1 }];
    expect(outcome(apply(document, operation, { maxApplyWork: 100 }))).toBe(
      "LIMIT_EXCEEDED: operation 0: the apply exceeds maxApplyWork",
    );
    expect(apply(document, operation, { maxApplyWork: 1100 }).ok).toBe(true);
  });

  test("an insert or a remove is charged for the members it shifts", () => {
    const list = Array.from({ length: 1000 }, (_, i) => i);
    // The copy-on-write copy (1000), the pointer and the value fit; shifting 1000 more does not.
    const operation = { op: "add", path: "/0", value: 0 };
    expect(outcome(apply(list, [operation], { maxApplyWork: 1500 }))).toMatch(/^LIMIT_EXCEEDED/);
    expect(apply(list, [{ ...operation, path: "/-" }], { maxApplyWork: 1500 }).ok).toBe(true);
    expect(outcome(apply(list, [{ op: "remove", path: "/0" }], { maxApplyWork: 1500 }))).toMatch(
      /^LIMIT_EXCEEDED/,
    );
    expect(apply(list, [{ op: "remove", path: "/999" }], { maxApplyWork: 1500 }).ok).toBe(true);
  });

  test("a move is charged for measuring what it deepens, and for the copies its remove makes", () => {
    const wide = Array.from({ length: 1000 }, (_, i) => i);
    expect(
      outcome(
        apply({ a: wide, b: {} }, [{ op: "move", from: "/a", path: "/b/c" }], {
          maxApplyWork: 500,
        }),
      ),
    ).toMatch(/^LIMIT_EXCEEDED/);
    expect(
      outcome(
        apply({ a: wide }, [{ op: "move", from: "/a/0", path: "/b" }], { maxApplyWork: 500 }),
      ),
    ).toMatch(/^LIMIT_EXCEEDED/);
  });

  test("a test is charged for the member names it compares", () => {
    const value = { ["k".repeat(1000)]: 1 };
    expect(
      outcome(apply({ a: value }, [{ op: "test", path: "/a", value }], { maxApplyWork: 500 })),
    ).toMatch(/^LIMIT_EXCEEDED/);
  });

  // Every charge site, one at a time: raising a cost limit one unit at a time from 1, each
  // fixture fails with LIMIT_EXCEEDED up to some threshold and succeeds from it on — never
  // another outcome, never a success below a failure.
  const fixtures: [string, unknown, unknown[]][] = [
    [
      "an add of nested values",
      { a: [] },
      [{ op: "add", path: "/a/-", value: [{ key: [1, "s"] }, {}] }],
    ],
    [
      "a replace",
      { a: { b: 1 } },
      [{ op: "replace", path: "/a/b", value: { long_member_name: "x" } }],
    ],
    ["a copy", { a: [{ b: "s" }, [2]] }, [{ op: "copy", from: "/a", path: "/c" }]],
    ["a move deeper", { a: [[1]], b: {} }, [{ op: "move", from: "/a", path: "/b/c" }]],
    // No deeper than it was: the moved value is not measured, so costs no more than its
    // pointers and the copies its remove and add make.
    ["a move sideways", { a: [[1]], b: {} }, [{ op: "move", from: "/a", path: "/c" }]],
    [
      "a test",
      { a: { k: [1, { x: "y" }] } },
      [{ op: "test", path: "/a", value: { k: [1, { x: "y" }] } }],
    ],
    ["a remove", { a: [1, 2, 3] }, [{ op: "remove", path: "/a/0" }]],
  ];

  // The smallest limit under which each fixture succeeds, or why the sweep is broken: below
  // it every outcome must be LIMIT_EXCEEDED with a message that says which limit, from it on
  // every outcome a success.
  function threshold(outcomes: JsonPatchResult<unknown>[]): number {
    const first = outcomes.findIndex((result) => result.ok);
    expect(first).toBeGreaterThan(0);
    for (const result of outcomes.slice(0, first)) {
      expect(result.ok ? "ok" : `${result.error.code}: ${result.error.message}`).toMatch(
        /^LIMIT_EXCEEDED: operation \d+: \S/,
      );
    }
    expect(outcomes.slice(first).every((result) => result.ok)).toBe(true);
    return first + 1;
  }

  const workThreshold = (document: unknown, operations: unknown[]) =>
    threshold(
      Array.from({ length: 80 }, (_, work) =>
        apply(document, operations, { maxApplyWork: work + 1 }),
      ),
    );
  const valuesThreshold = (document: unknown, operations: unknown[]) =>
    threshold(
      Array.from({ length: 40 }, (_, values) =>
        apply(document, operations, { maxApplyValues: values + 1 }),
      ),
    );
  const costThreshold = (operations: unknown[]) =>
    threshold(
      Array.from({ length: 120 }, (_, cost) => parsePatch(operations, { maxPatchCost: cost + 1 })),
    );

  // Pinned, so a change to what anything costs is a deliberate one. By hand, "a remove":
  // the pointer "/a/0" (1 + 4), copying the root (1 member) and "a" (3 members), and
  // shifting the 2 members after index 0: 5 + 1 + 3 + 2 = 11.
  // Its values leave out the pointer's characters: the operation 1, the copies 1 + 3 and
  // the shifts 2 = 7.
  test("each fixture's thresholds are the documented costs", () => {
    const thresholds = Object.fromEntries(
      fixtures.map(([name, document, operations]) => [
        name,
        {
          maxApplyWork: workThreshold(document, operations),
          maxApplyValues: valuesThreshold(document, operations),
          maxPatchCost: costThreshold(operations),
        },
      ]),
    );
    expect(thresholds).toMatchInlineSnapshot(`
      {
        "a copy": {
          "maxApplyValues": 7,
          "maxApplyWork": 13,
          "maxPatchCost": 23,
        },
        "a move deeper": {
          "maxApplyValues": 6,
          "maxApplyWork": 12,
          "maxPatchCost": 25,
        },
        "a move sideways": {
          "maxApplyValues": 3,
          "maxApplyWork": 7,
          "maxPatchCost": 23,
        },
        "a remove": {
          "maxApplyValues": 7,
          "maxApplyWork": 11,
          "maxPatchCost": 20,
        },
        "a replace": {
          "maxApplyValues": 5,
          "maxApplyWork": 26,
          "maxPatchCost": 45,
        },
        "a test": {
          "maxApplyValues": 6,
          "maxApplyWork": 11,
          "maxPatchCost": 29,
        },
        "an add of nested values": {
          "maxApplyValues": 8,
          "maxApplyWork": 16,
          "maxPatchCost": 32,
        },
      }
    `);
  });

  test("an operation pays for its pointers by their length", () => {
    const key = "k".repeat(100);
    const add = [{ op: "add", path: `/${key}`, value: 1 }];
    expect(outcome(apply({}, add, { maxApplyWork: 100 }))).toMatch(/^LIMIT_EXCEEDED/);
    expect(apply({}, add, { maxApplyWork: 110 }).ok).toBe(true);
    const copy = [{ op: "copy", from: `/${key}`, path: "/b" }];
    expect(outcome(apply({ [key]: 1 }, copy, { maxApplyWork: 100 }))).toMatch(/^LIMIT_EXCEEDED/);
    expect(apply({ [key]: 1 }, copy, { maxApplyWork: 120 }).ok).toBe(true);
  });

  test("copy-on-write copies a container once per apply, however many operations touch it", () => {
    const list = Array.from({ length: 1000 }, (_, i) => i);
    const appends = Array.from({ length: 5 }, () => ({ op: "add", path: "/-", value: 0 }));
    // The copy (1000), five pointers (3 each) and five values (1 each): 1020.
    expect(apply(list, appends, { maxApplyWork: 1020 }).ok).toBe(true);
    expect(outcome(apply(list, appends, { maxApplyWork: 1019 }))).toMatch(/^LIMIT_EXCEEDED/);
  });

  test("a copy may nest exactly to maxDepth", () => {
    // "/b" (1) plus [[1]] (2) is 3; "/a/c" (2) plus a scalar (0) is 2.
    expect(apply({ a: [[1]] }, [{ op: "copy", from: "/a", path: "/b" }], { maxDepth: 3 }).ok).toBe(
      true,
    );
    expect(
      apply({ a: { b: 1 } }, [{ op: "copy", from: "/a/b", path: "/a/c" }], { maxDepth: 2 }).ok,
    ).toBe(true);
  });

  test("applyPatch holds add and replace to its own maxDepth, not only parsePatch's", () => {
    // Parsed under the defaults (maxDepth 256), applied under maxDepth 1: [[0]] nests 2 deep.
    for (const [document, operation] of [
      [{}, { op: "add", path: "", value: [[0]] }],
      [{}, { op: "replace", path: "", value: [[0]] }],
      [{ a: 1 }, { op: "add", path: "/b", value: [0] }],
      [{ a: 1 }, { op: "replace", path: "/a", value: [0] }],
      [{ a: { b: 1 } }, { op: "add", path: "/a/c", value: 0 }],
    ] as const) {
      const parsed = patch([operation]);
      const result = applyPatch(deepFreeze(document) as JsonValue, parsed, { maxDepth: 1 });
      expect({ operation, outcome: outcome(result) }).toEqual({
        operation,
        outcome:
          "LIMIT_EXCEEDED: operation 0: the value would be nested deeper than maxDepth at its path",
      });
    }
    // Exactly at the limit is allowed: "/b" (1) plus a scalar (0).
    expect(
      applyPatch({ a: 1 }, patch([{ op: "add", path: "/b", value: 0 }]), { maxDepth: 1 }).ok,
    ).toBe(true);
  });

  test("a move of a huge array stops at the work budget", () => {
    const document = { a: Array.from({ length: 100_000 }, () => 0), b: {} };
    expect(
      outcome(apply(document, [{ op: "move", from: "/a", path: "/b/c" }], { maxApplyWork: 10 })),
    ).toBe("LIMIT_EXCEEDED: operation 0: the apply exceeds maxApplyWork");
  });

  test("depth counts objects as it counts arrays", () => {
    const document = { a: { x: { y: { z: 1 } } }, b: { c: {} } };
    for (const op of ["move", "copy"]) {
      const operation = [{ op, from: "/a", path: "/b/c/d" }];
      expect(outcome(apply(document, operation, { maxDepth: 5 }))).toBe(
        "LIMIT_EXCEEDED: operation 0: the value would be nested deeper than maxDepth at its path",
      );
      expect(apply(document, operation, { maxDepth: 6 }).ok).toBe(true);
    }
  });

  test("a limit out of range is a caller bug, and throws", () => {
    for (const name of [
      "maxOperations",
      "maxPointerLength",
      "maxDepth",
      "maxPatchCost",
      "maxApplyWork",
      "maxApplyValues",
    ]) {
      expect(() => parsePatch([], { [name]: 0 })).toThrow(
        new RangeError(
          `JSON Patch limit ${name} must be an integer in [1, ${Reflect.get(HARD_LIMITS, name)}]`,
        ),
      );
    }
    expect(() => parsePatch([], { maxDepth: 0 })).toThrow(RangeError);
    expect(() => parsePatch([], { maxDepth: 1.5 })).toThrow(RangeError);
    expect(() => parsePatch([], { maxOperations: 1e9 })).toThrow(RangeError);
    expect(() => parsePatch([], { maxDeph: 3 } as Partial<JsonPatchLimits>)).toThrow(
      new RangeError("Unknown JSON Patch limit: maxDeph"),
    );
    expect(() => applyPatch({}, patch([]), { maxApplyWork: -1 })).toThrow(RangeError);
    expect(DEFAULT_LIMITS.maxDepth).toBe(256);
  });

  test("limits that are not a plain object are a caller bug, and throw", () => {
    const notLimits = new TypeError(
      "JSON Patch limits must be a plain object, or an ApplyBudget made by this copy of the library",
    );
    for (const limits of [null, 5, [], new Map(), new (class Limits {})()]) {
      expect(() => parsePatch([], limits as Partial<JsonPatchLimits>)).toThrow(notLimits);
      expect(() => applyPatch({}, patch([]), limits as Partial<JsonPatchLimits>)).toThrow(
        notLimits,
      );
    }
    expect(applyPatch({}, patch([]), Object.create(null) as JsonPatchLimits).ok).toBe(true);
  });

  test("an ApplyBudget from another copy of the library throws, never applies under the defaults", async () => {
    // A second instance of the module, as a second installed copy of the package would be.
    vi.resetModules();
    const other = await import("./apply.js");
    const foreign = new other.ApplyBudget({ maxApplyValues: 5 });
    expect(foreign).not.toBeInstanceOf(ApplyBudget);
    expect(() => applyPatch({}, patch([]), foreign)).toThrow(TypeError);
  });
});

describe("errors", () => {
  test("never carry a value of the document or of the patch", () => {
    const secret = "only-readers-see-this";
    const document = { a: secret, list: [secret] };
    const operations = [
      [{ op: "test", path: "/a", value: `${secret}!` }],
      [{ op: "replace", path: "/b", value: secret }],
      [{ op: "copy", from: "/nope", path: "/c" }],
      [{ op: "add", path: "/list/9", value: secret }],
    ];
    for (const operation of operations) {
      expect(errorOf(apply(document, operation)).message).not.toContain(secret);
    }
  });
});

describe("a document that is not JSON", () => {
  test("breaks a precondition, reported as an invariant error where the patch touches it", () => {
    const document = { a: { b: new Date(0) } } as unknown as JsonValue;
    expect(() =>
      applyPatch(document, patch([{ op: "test", path: "/a", value: { b: 1 } }])),
    ).toThrow(JsonPatchInvariantError);
    expect(() => applyPatch(document, patch([{ op: "add", path: "/a/b/c", value: 1 }]))).toThrow(
      JsonPatchInvariantError,
    );
  });

  test("names the broken precondition, apart from a bad patch", () => {
    const document = { a: new Date(0) } as unknown as JsonValue;
    let thrown: unknown;
    try {
      applyPatch(document, patch([{ op: "test", path: "/a", value: 1 }]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(JsonPatchInvariantError);
    expect(thrown).not.toBeInstanceOf(JsonPatchError);
    expect(thrown).toMatchObject({
      name: "JsonPatchInvariantError",
      message: "the document is JSON",
    });
  });
});

test("a JsonPatchError names itself, and quotes at most 64 code units of a pointer", () => {
  const exactly64 = `/${"p".repeat(63)}`;
  const result = apply({}, [{ op: "remove", path: exactly64 }]);
  expect(result.ok ? undefined : result.error).toMatchObject({
    name: "JsonPatchError",
    message: `operation 0: path ${JSON.stringify(exactly64)} does not resolve`,
  });
  const longer = apply({}, [{ op: "remove", path: `${exactly64}q` }]);
  expect(longer.ok ? undefined : longer.error.message).toBe(
    `operation 0: path ${JSON.stringify(`${exactly64}…`)} does not resolve`,
  );
});
