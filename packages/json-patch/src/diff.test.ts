import { describe, expect, test } from "vitest";

import {
  applyPatch,
  createPatch,
  HARD_LIMITS,
  JsonPatchError,
  parsePatch,
  type CreatePatchOptions,
  type JsonPatchLimits,
  type JsonPatchResult,
  type JsonValue,
  type Operation,
} from "./index.js";
import { containerCounts, deepFreeze } from "./test/json-helpers.js";

function outcome(result: JsonPatchResult<readonly Operation[]>) {
  return result.ok ? result.value : `${result.error.code}: ${result.error.message}`;
}

function diff(source: unknown, target: unknown, options?: CreatePatchOptions) {
  return outcome(createPatch(source, target, options));
}

// Parse and apply a patch createPatch made, the way a caller would.
function applied(source: unknown, operations: readonly Operation[]): JsonValue {
  const parsed = parsePatch(operations);
  if (!parsed.ok) throw parsed.error;
  const result = applyPatch(source as JsonValue, parsed.value);
  if (!result.ok) throw result.error;
  return result.value;
}

function patchOf(source: unknown, target: unknown, options?: CreatePatchOptions) {
  const result = createPatch(source, target, options);
  if (!result.ok) throw result.error;
  return result.value;
}

describe("the patch", () => {
  test("visits members last to first, depth first, and adds new ones after, in order", () => {
    const source = { a: 1, b: { c: 1, d: 2 }, e: [1, 2] };
    const target = { a: 2, b: { c: 1, x: 3 }, e: [1, 2], f: null, g: {} };
    expect(diff(source, target)).toEqual([
      { op: "remove", path: "/b/d" },
      { op: "add", path: "/b/x", value: 3 },
      { op: "replace", path: "/a", value: 2 },
      { op: "add", path: "/f", value: null },
      { op: "add", path: "/g", value: {} },
    ]);
  });

  test("with tests, guards every replace and remove with the value it overwrites", () => {
    expect(diff({ a: 1, b: [1, 2], c: { d: "x" } }, { a: 2, b: [1], e: 3 }, { tests: true }))
      .toMatchInlineSnapshot(`
      [
        {
          "op": "test",
          "path": "/c",
          "value": {
            "d": "x",
          },
        },
        {
          "op": "remove",
          "path": "/c",
        },
        {
          "op": "test",
          "path": "/b/1",
          "value": 2,
        },
        {
          "op": "remove",
          "path": "/b/1",
        },
        {
          "op": "test",
          "path": "/a",
          "value": 1,
        },
        {
          "op": "replace",
          "path": "/a",
          "value": 2,
        },
        {
          "op": "add",
          "path": "/e",
          "value": 3,
        },
      ]
    `);
  });

  test("an array only loses members from its end and gains them at its end", () => {
    expect(diff([1, 2, 3, 4], [1, 2])).toEqual([
      { op: "remove", path: "/3" },
      { op: "remove", path: "/2" },
    ]);
    expect(diff([1], [1, 2, 3])).toEqual([
      { op: "add", path: "/1", value: 2 },
      { op: "add", path: "/2", value: 3 },
    ]);
    // A member in front shifts nothing: every index is replaced in place.
    expect(diff([1, 2], [0, 1, 2])).toEqual([
      { op: "replace", path: "/1", value: 1 },
      { op: "replace", path: "/0", value: 0 },
      { op: "add", path: "/2", value: 2 },
    ]);
  });

  test("a member that changes kind is replaced, not diffed into", () => {
    expect(diff({ a: { b: 1 } }, { a: [1] })).toEqual([{ op: "replace", path: "/a", value: [1] }]);
    expect(diff({ a: [] }, { a: {} })).toEqual([{ op: "replace", path: "/a", value: {} }]);
    expect(diff({ a: {} }, { a: null })).toEqual([{ op: "replace", path: "/a", value: null }]);
    expect(diff({ a: "1" }, { a: 1 })).toEqual([{ op: "replace", path: "/a", value: 1 }]);
  });

  test("escapes member names in its pointers", () => {
    expect(diff({}, { "a/b": 1, "t~e": 2, "": 3, "~1": 4 })).toEqual([
      { op: "add", path: "/a~1b", value: 1 },
      { op: "add", path: "/t~0e", value: 2 },
      { op: "add", path: "/", value: 3 },
      { op: "add", path: "/~01", value: 4 },
    ]);
  });

  test("adds '__proto__' as a member, never as a prototype", () => {
    const target: unknown = JSON.parse('{"__proto__": {"polluted": true}, "a": {"__proto__": []}}');
    const operations = patchOf({ a: {} }, target);
    expect(operations).toEqual([
      { op: "add", path: "/a/__proto__", value: [] },
      { op: "add", path: "/__proto__", value: { polluted: true } },
    ]);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    const value = operations.at(1);
    expect(value && "value" in value && Object.getPrototypeOf(value.value)).toBe(Object.prototype);
    const result = applied({ a: {} }, operations) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({ polluted: true });
  });

  test("is frozen, all of it, and shares no container with either document", () => {
    const source = { a: { b: [1] }, c: [{}] };
    const target = { a: { b: [2], d: { e: [] } }, c: [] };
    const operations = patchOf(source, target, { tests: true });
    expect(Object.isFrozen(operations)).toBe(true);
    const inDocuments = new Set([
      ...containerCounts(source).keys(),
      ...containerCounts(target).keys(),
    ]);
    for (const operation of operations) {
      expect(Object.isFrozen(operation)).toBe(true);
      for (const container of containerCounts(
        "value" in operation ? operation.value : null,
      ).keys()) {
        expect(Object.isFrozen(container)).toBe(true);
        expect(inDocuments.has(container)).toBe(false);
      }
    }
  });
});

describe("equality", () => {
  test("the same value, or a deep copy of it, makes an empty patch", () => {
    const document = { a: [1, { b: "c" }], d: null, e: true, f: -1.5 };
    expect(diff(document, document)).toEqual([]);
    expect(diff(document, structuredClone(document))).toEqual([]);
    expect(diff([], [])).toEqual([]);
    expect(diff("s", "s")).toEqual([]);
  });

  test("numbers compare by value, so -0 equals 0", () => {
    expect(diff({ a: -0 }, { a: 0 })).toEqual([]);
    expect(diff(-0, 0)).toEqual([]);
  });

  test("strings compare by code unit, with no normalization", () => {
    expect(diff({ a: "é" }, { a: "é" })).toEqual([{ op: "replace", path: "/a", value: "é" }]);
  });

  test("a container both documents share is not read", () => {
    const shared = {
      get trap(): never {
        throw new Error("a getter ran");
      },
    };
    expect(diff({ a: shared, b: 1 }, { a: shared, b: 2 })).toEqual([
      { op: "replace", path: "/b", value: 2 },
    ]);
    expect(diff(shared, shared)).toEqual([]);
  });
});

describe("the root", () => {
  // Where fast-json-patch's compare is wrong: it returns no operations for a changed scalar
  // root, and a patch that does not apply for a root that changed kind.
  test.each([
    ["a changed scalar", 1, 2],
    ["a scalar to a container", "s", { a: 1 }],
    ["a container to a scalar", [1], null],
    ["an object to an array", { a: 1, b: 2 }, [1]],
    ["an array to an object", [], { a: 1 }],
  ])("is replaced when it is %s", (_, source, target) => {
    expect(diff(source, target, { tests: true })).toEqual([
      { op: "test", path: "", value: source },
      { op: "replace", path: "", value: target },
    ]);
    expect(applied(source, patchOf(source, target, { tests: true }))).toEqual(target);
  });
});

describe("what is not JSON", () => {
  const getter = (): Record<string, unknown> =>
    Object.defineProperty({}, "a", {
      enumerable: true,
      get(): never {
        throw new Error("a getter ran");
      },
    });
  const hole = (): unknown[] => {
    const array: unknown[] = [];
    array[1] = 1;
    return array;
  };
  class Point {
    x = 1;
  }

  test.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 1n],
    ["a symbol", Symbol("s")],
    ["a function", () => 1],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a class instance", new Point()],
  ])("is refused as INVALID_VALUE: %s", (_, value) => {
    expect(diff(value, {})).toBe('INVALID_VALUE: the source is not I-JSON at ""');
    expect(diff({}, value)).toBe('INVALID_VALUE: the target is not I-JSON at ""');
    expect(diff({ a: { b: value } }, { a: { b: 1 } })).toBe(
      'INVALID_VALUE: the source is not I-JSON at "/a/b"',
    );
    expect(diff({ a: [1] }, { a: [value] })).toBe(
      'INVALID_VALUE: the target is not I-JSON at "/a/0"',
    );
    expect(diff({}, { a: { b: value } })).toBe('INVALID_VALUE: the target is not I-JSON at "/a"');
  });

  test("is refused where the diff meets it, before the patch's limits are checked", () => {
    const limits = { maxPatchCost: 1 };
    const date = new Date(0);
    expect(diff({}, date, { limits })).toBe('INVALID_VALUE: the target is not I-JSON at ""');
    expect(diff({ a: 1 }, { a: date }, { limits })).toBe(
      'INVALID_VALUE: the target is not I-JSON at "/a"',
    );
    expect(diff({}, { a: date }, { limits })).toBe(
      'INVALID_VALUE: the target is not I-JSON at "/a"',
    );
  });

  test("a getter is refused, never run, wherever the diff meets it", () => {
    expect(diff(getter(), { a: 1 })).toBe('INVALID_VALUE: the source is not I-JSON at "/a"');
    expect(diff({ a: 1 }, getter())).toBe('INVALID_VALUE: the target is not I-JSON at "/a"');
    expect(diff({}, getter())).toBe('INVALID_VALUE: the target is not I-JSON at "/a"');
    expect(diff({ b: 1 }, { b: getter() })).toBe('INVALID_VALUE: the target is not I-JSON at "/b"');
    expect(diff({ b: getter() }, {}, { tests: true })).toBe(
      'INVALID_VALUE: the source is not I-JSON at "/b"',
    );
  });

  test("an array hole is refused, in either document", () => {
    expect(diff(hole(), [1, 1])).toBe('INVALID_VALUE: the source is not I-JSON at "/0"');
    expect(diff([1, 1], hole())).toBe('INVALID_VALUE: the target is not I-JSON at "/0"');
    expect(diff([], hole())).toBe('INVALID_VALUE: the target is not I-JSON at "/0"');
  });

  test("a string or member name with a lone surrogate is refused where the patch would carry it", () => {
    expect(diff({ a: "x" }, { a: "\uD800" })).toBe(
      'INVALID_VALUE: the target is not I-JSON at "/a"',
    );
    expect(diff({ a: "\uD800" }, { a: "x" }, { tests: true })).toBe(
      'INVALID_VALUE: the source is not I-JSON at "/a"',
    );
    expect(diff({}, { "\uDC00": 1 })).toBe('INVALID_VALUE: the target is not I-JSON at "/\\udc00"');
    expect(diff({ "\uDC00": 1 }, {})).toBe('INVALID_VALUE: the source is not I-JSON at "/\\udc00"');
    // Only compared, never carried: the patch is I-JSON all the same.
    expect(diff({ a: "\uD800", b: 1 }, { a: "\uD800", b: 2 })).toEqual([
      { op: "replace", path: "/b", value: 2 },
    ]);
  });

  test("a cycle is refused as a limit, whether walked or carried", () => {
    const cycle = (): Record<string, unknown> => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    };
    expect(diff(cycle(), cycle())).toBe("LIMIT_EXCEEDED: the diff exceeds maxApplyValues");
    expect(diff({}, cycle())).toBe(
      'LIMIT_EXCEEDED: the value at "/self" exceeds maxPatchCost or, at its path, maxDepth',
    );
  });

  test("what JSON.stringify would leave out is left out: symbol keys, hidden members, array extras", () => {
    const withSymbol = { a: 1, [Symbol("s")]: 2 };
    expect(diff(withSymbol, { a: 1 })).toEqual([]);
    const hidden = Object.defineProperty({ a: 1 }, "b", { value: 2, enumerable: false });
    expect(diff({ a: 1, b: 2 }, hidden)).toEqual([{ op: "remove", path: "/b" }]);
    expect(diff(hidden, { a: 1, b: 3 })).toEqual([{ op: "add", path: "/b", value: 3 }]);
    expect(diff(Object.assign([1], { extra: true }), [1])).toEqual([]);
  });
});

describe("options", () => {
  test("default to no tests and the default limits", () => {
    expect(diff({ a: 1 }, { a: 2 })).toEqual([{ op: "replace", path: "/a", value: 2 }]);
    expect(diff({}, { a: "x".repeat(4 * 1024 * 1024) })).toMatch(/^LIMIT_EXCEEDED/);
  });

  test("out of range are a caller bug, and throw", () => {
    expect(() => createPatch({}, {}, { test: true } as CreatePatchOptions)).toThrow(
      new RangeError("Unknown createPatch option: test"),
    );
    expect(() => createPatch({}, {}, { tests: 1 } as unknown as CreatePatchOptions)).toThrow(
      new RangeError("The createPatch option tests must be a boolean"),
    );
    expect(() => createPatch({}, {}, { limits: { maxDepth: 0 } })).toThrow(RangeError);
    expect(() => createPatch({}, {}, { limits: new Map() as unknown as JsonPatchLimits })).toThrow(
      TypeError,
    );
    expect(createPatch({}, {}, { tests: false }).ok).toBe(true);
  });
});

describe("limits", () => {
  function atLimit(limits: Partial<JsonPatchLimits>, source: unknown, target: unknown) {
    return diff(source, target, { limits });
  }

  test("maxOperations counts the operations, tests included", () => {
    expect(atLimit({ maxOperations: 2 }, [1, 2], [3, 4])).toHaveLength(2);
    expect(atLimit({ maxOperations: 1 }, [1, 2], [3, 4])).toBe(
      "LIMIT_EXCEEDED: the patch has more than maxOperations operations",
    );
    expect(diff({ a: 1 }, { a: 2 }, { tests: true, limits: { maxOperations: 1 } })).toBe(
      "LIMIT_EXCEEDED: the patch has more than maxOperations operations",
    );
  });

  test("maxPointerLength bounds each path", () => {
    expect(atLimit({ maxPointerLength: 4 }, {}, { abc: 1 })).toHaveLength(1);
    expect(atLimit({ maxPointerLength: 3 }, {}, { abc: 1 })).toBe(
      'LIMIT_EXCEEDED: path "/abc" is longer than maxPointerLength',
    );
  });

  test("maxDepth bounds each path's tokens and, with them, each value placed", () => {
    expect(atLimit({ maxDepth: 2 }, { a: {} }, { a: { b: 1 } })).toHaveLength(1);
    expect(atLimit({ maxDepth: 1 }, { a: {} }, { a: { b: 1 } })).toBe(
      'LIMIT_EXCEEDED: path "/a/b" is deeper than maxDepth',
    );
    expect(atLimit({ maxDepth: 2 }, { a: {} }, { a: { b: [] } })).toBe(
      'LIMIT_EXCEEDED: the value at "/a/b" exceeds maxPatchCost or, at its path, maxDepth',
    );
    for (const target of [{ a: {} }, { a: { b: 2 } }]) {
      expect(atLimit({ maxDepth: 1 }, { a: { b: 1 } }, target)).toBe(
        'LIMIT_EXCEEDED: path "/a/b" is deeper than maxDepth',
      );
    }
    // A tested value is only compared, so it only has to fit maxDepth itself.
    const tested = { tests: true, limits: { maxDepth: 2 } };
    expect(diff({ a: [[]] }, { a: 1 }, tested)).toHaveLength(2);
    expect(diff({ a: [[[]]] }, { a: 1 }, tested)).toMatch(/^LIMIT_EXCEEDED: the value at "\/a"/);
  });

  test("a document nested far deeper than any limit walks without overflowing the stack", () => {
    const nested = (depth: number, leaf: unknown): unknown => {
      let value = leaf;
      for (let level = 0; level < depth; level++) value = { a: value };
      return value;
    };
    const limits = HARD_LIMITS;
    expect(diff(nested(100_000, 1), nested(100_000, 1), { limits })).toEqual([]);
    expect(diff(nested(100_000, 1), nested(100_000, 2), { limits })).toMatch(
      /^LIMIT_EXCEEDED: path "(\/a){32}…" is longer than maxPointerLength$/,
    );
    expect(diff(nested(2000, 1), nested(2000, 2), { limits })).toMatch(
      /^LIMIT_EXCEEDED: path "(\/a){32}…" is deeper than maxDepth$/,
    );
  });

  // What the diff copies into its patch is work like what it reads, so the work limits
  // bound it: a tight maxApplyValues or maxApplyWork refuses the copy, whatever
  // maxPatchCost allows. One case per operation that carries a value.
  test("maxApplyValues and maxApplyWork bound what the diff copies into the patch", () => {
    const big = Array.from({ length: 10_000 }, () => 0);
    const cases: [string, unknown, unknown, boolean][] = [
      ["a replace", { a: 1 }, { a: big }, false],
      ["an add", {}, { a: big }, false],
      ["a guarded remove", { a: big }, {}, true],
      ["a guarded replace", { a: big }, { a: 1 }, true],
      ["a root replaced", null, big, false],
    ];
    for (const [name, source, target, tests] of cases) {
      // The case's name rides along, so a failure says which case it was.
      for (const limit of ["maxApplyValues", "maxApplyWork"] as const) {
        expect([name, diff(source, target, { tests, limits: { [limit]: 100 } })]).toEqual([
          name,
          `LIMIT_EXCEEDED: the diff exceeds ${limit}`,
        ]);
      }
      expect([name, createPatch(source, target, { tests, limits: HARD_LIMITS }).ok]).toEqual([
        name,
        true,
      ]);
    }
    // Long strings copy for one value each, and are stopped by their characters.
    const tight = { maxApplyValues: 100, maxApplyWork: 100 };
    const long = "x".repeat(10_000);
    expect(diff({ a: 1 }, { a: long }, { limits: tight })).toBe(
      "LIMIT_EXCEEDED: the diff exceeds maxApplyWork",
    );
    expect(diff({ a: long }, {}, { tests: true, limits: tight })).toBe(
      "LIMIT_EXCEEDED: the diff exceeds maxApplyWork",
    );
    // A member name the walk reads is paid for even when nothing follows: its value is the
    // same on both sides, so no copy is charged after it. The roots (2), their members
    // (1 + 1) and the name "ab" (2) are 6 work.
    expect(diff({ ab: 1 }, { ab: 1 }, { limits: { maxApplyWork: 6 } })).toEqual([]);
    expect(diff({ ab: 1 }, { ab: 1 }, { limits: { maxApplyWork: 5 } })).toBe(
      "LIMIT_EXCEEDED: the diff exceeds maxApplyWork",
    );
    // So are long member names inside a copied value.
    expect(diff({}, { a: { [long]: 1 } }, { limits: tight })).toBe(
      "LIMIT_EXCEEDED: the diff exceeds maxApplyWork",
    );
  });

  // Raising a limit one unit at a time from 1, each fixture fails with LIMIT_EXCEEDED up to
  // some threshold and succeeds from it on — never another outcome, never a success below a
  // failure. For maxPatchCost the threshold is exactly where parsePatch accepts the patch.
  const fixtures: [string, unknown, unknown, boolean][] = [
    ["a replace, guarded", { a: { b: 1 } }, { a: { b: { long_member_name: "x" } } }, true],
    ["an add of nested values", { a: [] }, { a: [[{ key: [1, "s"] }, {}]] }, false],
    ["a remove, guarded", { a: [1, 2, 3] }, { a: [1] }, true],
    ["a new member", { a: 1 }, { a: 1, bb: "cc" }, false],
    ["a compared string", { s: "a long string", t: 1 }, { s: "a long string", t: 2 }, false],
    ["a root replaced", "old", "new", true],
  ];

  function threshold(outcomes: JsonPatchResult<readonly Operation[]>[]): number {
    const first = outcomes.findIndex((result) => result.ok);
    expect(first).toBeGreaterThan(0);
    for (const result of outcomes.slice(0, first)) {
      expect(outcome(result)).toMatch(/^LIMIT_EXCEEDED: \S/);
    }
    expect(outcomes.slice(first).every((result) => result.ok)).toBe(true);
    return first + 1;
  }

  const sweep = (name: keyof JsonPatchLimits, source: unknown, target: unknown, tests: boolean) =>
    threshold(
      Array.from({ length: 120 }, (_, limit) =>
        createPatch(source, target, { tests, limits: { [name]: limit + 1 } }),
      ),
    );

  test("each fixture's thresholds are the documented costs, and parsePatch agrees", () => {
    const thresholds = Object.fromEntries(
      fixtures.map(([name, source, target, tests]) => {
        const maxPatchCost = sweep("maxPatchCost", source, target, tests);
        const operations = patchOf(source, target, { tests });
        expect(parsePatch(operations, { maxPatchCost }).ok).toBe(true);
        expect(
          outcome(parsePatch(operations, { maxPatchCost: maxPatchCost - 1 }) as never),
        ).toMatch(/^LIMIT_EXCEEDED/);
        return [
          name,
          {
            maxApplyValues: sweep("maxApplyValues", source, target, tests),
            maxApplyWork: sweep("maxApplyWork", source, target, tests),
            maxPatchCost,
          },
        ];
      }),
    );
    // By hand, "a new member": the walk reads the two roots (2) and their 1 + 2 members (3)
    // = 5 values, each a unit of work, and pays 1 + 2 for the member names "a" (read once,
    // for both documents) and "bb": 8 work. Copying "cc" into the patch is one value more
    // and its 2 characters: 6 values, 11 work. The patch: the array 1, the operation 17,
    // its path "/bb" 3 and its value "cc" 1 + 2 = 24.
    expect(thresholds).toMatchInlineSnapshot(`
      {
        "a compared string": {
          "maxApplyValues": 7,
          "maxApplyWork": 22,
          "maxPatchCost": 25,
        },
        "a new member": {
          "maxApplyValues": 6,
          "maxApplyWork": 11,
          "maxPatchCost": 24,
        },
        "a remove, guarded": {
          "maxApplyValues": 10,
          "maxApplyWork": 11,
          "maxPatchCost": 85,
        },
        "a replace, guarded": {
          "maxApplyValues": 9,
          "maxApplyWork": 28,
          "maxPatchCost": 68,
        },
        "a root replaced": {
          "maxApplyValues": 4,
          "maxApplyWork": 13,
          "maxPatchCost": 48,
        },
        "an add of nested values": {
          "maxApplyValues": 11,
          "maxApplyWork": 16,
          "maxPatchCost": 32,
        },
      }
    `);
  });
});

describe("errors", () => {
  test("name a location, never a value, and have no operation index", () => {
    const secret = "secret-value";
    const results = [
      createPatch({ a: secret }, { a: new Date() }),
      createPatch({ a: secret }, { a: `${secret}\uD800` }),
      createPatch({ a: 1 }, { a: secret }, { limits: { maxPatchCost: 20 } }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBeInstanceOf(JsonPatchError);
      expect(result.error.operationIndex).toBeNull();
      expect(result.error.message).not.toContain(secret);
    }
  });

  test("quote a long path truncated", () => {
    const key = "k".repeat(100);
    expect(diff({}, { [key]: new Date() })).toBe(
      `INVALID_VALUE: the target is not I-JSON at "/${"k".repeat(63)}…"`,
    );
  });

  test("leave the documents as they were", () => {
    const source = deepFreeze({ a: [1, { b: 2 }] });
    const target = deepFreeze({ a: [1, { b: 3 }, 4], c: "d" });
    expect(applied(source, patchOf(source, target, { tests: true }))).toEqual(target);
  });
});
