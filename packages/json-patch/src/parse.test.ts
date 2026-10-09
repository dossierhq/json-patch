import { runInNewContext } from "node:vm";

import { describe, expect, test } from "vitest";

import {
  applyPatch,
  JsonPatchInvariantError,
  parsePatch,
  type JsonValue,
  type ParsedPatch,
} from "./index.js";

function refusal(input: unknown, limits?: Parameters<typeof parsePatch>[1]) {
  const result = parsePatch(input, limits);
  return result.ok ? "accepted" : `${result.error.code}: ${result.error.message}`;
}

describe("the patch document", () => {
  test.each([
    ["an object", { op: "add", path: "/a", value: 1 }],
    ["a string", '[{"op":"add","path":"/a","value":1}]'],
    ["null", null],
    ["an array of another realm", runInNewContext("[]") as unknown],
    ["an array subclass", new (class extends Array {})()],
  ])("%s is not a patch", (_, input) => {
    expect(refusal(input)).toBe("INVALID_PATCH: a patch is not an array");
  });

  test("an array with a hole or an extra member is not a patch", () => {
    const holey: unknown[] = [];
    holey[1] = { op: "remove", path: "/a" };
    expect(refusal(holey)).toBe("INVALID_PATCH: a patch is an array with holes or extra members");
    const extra = Object.defineProperty([], "extra", { value: 1, enumerable: true });
    expect(refusal(extra)).toBe("INVALID_PATCH: a patch is an array with holes or extra members");
    // A hole and an extra member together keep the count of own keys right.
    const both = Object.assign([], { 1: { op: "remove", path: "/a" }, extra: 1 });
    both.length = 2;
    expect(refusal(both)).toBe("INVALID_PATCH: a patch is an array with holes or extra members");
  });

  test("a sparse array claiming billions of operations is refused without walking them", () => {
    const huge: unknown[] = [];
    huge.length = 2 ** 32 - 1;
    expect(refusal(huge, { maxOperations: 100_000 })).toBe(
      "LIMIT_EXCEEDED: the patch has more than maxOperations operations",
    );
  });

  test("a patch of exactly maxOperations operations is a patch", () => {
    const patch = Array.from({ length: 3 }, () => ({ op: "remove", path: "/a" }));
    expect(refusal(patch, { maxOperations: 3 })).toBe("accepted");
    expect(refusal(patch, { maxOperations: 2 })).toBe(
      "LIMIT_EXCEEDED: the patch has more than maxOperations operations",
    );
  });

  test("the empty patch is a patch", () => {
    expect(refusal([])).toBe("accepted");
  });
});

describe("an operation", () => {
  test.each([
    [null, "INVALID_PATCH: operation 0: operation is not an object"],
    [[], "INVALID_PATCH: operation 0: operation is not an object"],
    [new Date(0), "INVALID_PATCH: operation 0: operation is not an object"],
    [{ path: "/a" }, 'INVALID_PATCH: operation 0: operation has no "op" member'],
    [{ op: "spam", path: "/a" }, 'INVALID_PATCH: operation 0: unknown op "spam"'],
    [{ op: "ADD", path: "/a", value: 1 }, 'INVALID_PATCH: operation 0: unknown op "ADD"'],
    [{ op: 1, path: "/a" }, "INVALID_PATCH: operation 0: unknown op (not a string)"],
    [{ op: "add", value: 1 }, 'INVALID_PATCH: operation 0: operation has no "path" member'],
    [{ op: "add", path: null, value: 1 }, 'INVALID_PATCH: operation 0: "path" is not a string'],
    [{ op: "add", path: "/a" }, 'INVALID_PATCH: operation 0: operation has no "value" member'],
    [{ op: "copy", path: "/a" }, 'INVALID_PATCH: operation 0: operation has no "from" member'],
    [{ op: "move", path: "/a", from: 1 }, 'INVALID_PATCH: operation 0: "from" is not a string'],
    [
      { op: "add", path: "/a", value: 1, xyz: 1 },
      'INVALID_PATCH: operation 0: operation has a member "xyz" its op does not define',
    ],
    [
      { op: "remove", path: "/a", value: 1 },
      'INVALID_PATCH: operation 0: operation has a member "value" its op does not define',
    ],
    [
      { op: "remove", path: "" },
      "INVALID_PATCH: operation 0: remove of the root: a patch cannot delete the document",
    ],
    [
      { op: "move", from: "/a", path: "/a/b" },
      'INVALID_PATCH: operation 0: move from "/a" into its own subtree',
    ],
    [
      { op: "move", from: "", path: "/a" },
      'INVALID_PATCH: operation 0: move from "" into its own subtree',
    ],
    [
      { op: "add", path: "a", value: 1 },
      'INVALID_POINTER: operation 0: "path" "a": pointer does not start with "/"',
    ],
    [
      { op: "copy", from: "/~2", path: "/a" },
      'INVALID_POINTER: operation 0: "from" "/~2": pointer has a "~" not followed by 0 or 1',
    ],
    [
      { op: "add", path: "/a", value: undefined },
      'INVALID_VALUE: operation 0: "value" is not I-JSON',
    ],
  ])("%j: %s", (operation, expected) => {
    expect(refusal([operation])).toBe(expected);
  });

  test("a value null is a value, not a missing one", () => {
    expect(refusal([{ op: "test", path: "/a", value: null }])).toBe("accepted");
  });

  test("an operation may have a null prototype, as a parser that avoids prototypes makes it", () => {
    const operation = Object.assign(Object.create(null) as object, { op: "remove", path: "/a" });
    expect(refusal([operation])).toBe("accepted");
  });

  test("the operation at fault is named by its index", () => {
    const result = parsePatch([
      { op: "remove", path: "/a" },
      { op: "remove", path: "/b" },
      { op: "remove" },
    ]);
    expect(result.ok ? undefined : result.error.operationIndex).toBe(2);
  });

  test("an inherited member is not a member", () => {
    const operation = Object.assign(Object.create({ path: "/a" }) as object, { op: "remove" });
    expect(refusal([operation])).toBe("INVALID_PATCH: operation 0: operation is not an object");
  });

  test("a getter is refused, never run", () => {
    let ran = false;
    const operation = {
      op: "remove",
      get path() {
        ran = true;
        return "/a";
      },
    };
    expect(refusal([operation])).toBe(
      'INVALID_PATCH: operation 0: operation member "path" is not a data property',
    );
    expect(ran).toBe(false);
  });

  test("a symbol key is refused", () => {
    expect(refusal([{ op: "remove", path: "/a", [Symbol("s")]: 1 }])).toBe(
      "INVALID_PATCH: operation 0: operation has a symbol key",
    );
  });

  test("a message quotes at most 64 code units of a string, escaped", () => {
    const result = parsePatch([{ op: `\u0000\n${"x".repeat(100)}`, path: "/a" }]);
    expect(result.ok ? undefined : result.error.message).toBe(
      `INVALID_PATCH: operation 0: unknown op "\\u0000\\n${"x".repeat(62)}…"`.slice(
        "INVALID_PATCH: ".length,
      ),
    );
  });
});

describe("a value", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const accessor = Object.defineProperty({}, "a", { get: () => 1, enumerable: true });
  const hidden = Object.defineProperty({}, "a", { value: 1, enumerable: false });

  test.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a lone high surrogate", "a\uD800"],
    ["a lone low surrogate", "\uDC00b"],
    ["a member name with a lone surrogate", { "\uD800": 1 }],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a typed array", new Uint8Array(1)],
    ["a boxed string", Object("s") as object],
    ["a class instance", new (class Thing {})()],
    ["an array with a hole", Object.assign([1], { 2: 3 })],
    ["an array with an extra member", Object.assign([1], { extra: 1 })],
    ["an array with a hole and an extra member", Object.assign([], { 1: 1, extra: 1, length: 2 })],
    ["an object with a symbol key", { [Symbol("s")]: 1 }],
    ["an object with an accessor", accessor],
    ["an object with a non-enumerable member", hidden],
    ["an object of another realm", runInNewContext("({ a: 1 })") as unknown],
  ])("%s is not I-JSON", (_, value) => {
    expect(refusal([{ op: "add", path: "/a", value }])).toBe(
      'INVALID_VALUE: operation 0: "value" is not I-JSON',
    );
  });

  test("a circular value is refused as infinitely deep", () => {
    expect(refusal([{ op: "add", path: "/a", value: circular }])).toBe(
      'LIMIT_EXCEEDED: operation 0: "value" exceeds maxPatchCost or, at its path, maxDepth',
    );
  });

  test("-0, a well-formed astral string and a null-prototype object are I-JSON", () => {
    const value = [-0, "\u{1F600}", Object.create(null) as object];
    expect(refusal([{ op: "add", path: "/a", value }])).toBe("accepted");
  });

  test("a value nested past maxDepth is refused before the walk reaches its bottom", () => {
    let deep: unknown = 0;
    for (let level = 0; level < 100_000; level++) deep = [deep];
    expect(refusal([{ op: "test", path: "", value: deep }])).toBe(
      'LIMIT_EXCEEDED: operation 0: "value" exceeds maxPatchCost or, at its path, maxDepth',
    );
  });

  test("a value placed at a path must fit maxDepth together with the path", () => {
    const value = [[0]];
    expect(refusal([{ op: "add", path: "/a/b", value }], { maxDepth: 4 })).toBe("accepted");
    expect(refusal([{ op: "add", path: "/a/b/c", value }], { maxDepth: 4 })).toBe(
      'LIMIT_EXCEEDED: operation 0: "value" exceeds maxPatchCost or, at its path, maxDepth',
    );
    expect(refusal([{ op: "test", path: "/a/b/c", value }], { maxDepth: 4 })).toBe("accepted");
  });
});

describe("the patch's cost", () => {
  test("counts every member name, pointer and string", () => {
    // The array, the operation, "op" and "path", "remove" and "/a": 1 + 1 + 2 + 4 + 7 + 3.
    const patch = [{ op: "remove", path: "/a" }];
    expect(refusal(patch, { maxPatchCost: 18 })).toBe("accepted");
    expect(refusal(patch, { maxPatchCost: 17 })).toMatch(/^LIMIT_EXCEEDED/);
  });

  test("bounds a long string", () => {
    const value = "x".repeat(1000);
    expect(refusal([{ op: "add", path: "/a", value }], { maxPatchCost: 1000 })).toMatch(
      /^LIMIT_EXCEEDED/,
    );
  });
});

describe("a parsed patch", () => {
  test("is a private copy: changing the input afterwards changes nothing", () => {
    const value = { list: [1] };
    const input = [{ op: "add", path: "/a", value }];
    const parsed = parsePatch(input);
    if (!parsed.ok) throw parsed.error;
    value.list.push(2);
    input[0]!.path = "/b";
    const applied = applyPatch({}, parsed.value);
    expect(applied).toEqual({ ok: true, value: { a: { list: [1] } } });
  });

  test("is frozen", () => {
    const parsed = parsePatch([]);
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
  });

  test("cannot be forged: applyPatch refuses what parsePatch did not return", () => {
    const forged = Object.freeze({ length: 0 }) as unknown as ParsedPatch;
    expect(() => applyPatch({} as JsonValue, forged)).toThrow(JsonPatchInvariantError);
  });
});
