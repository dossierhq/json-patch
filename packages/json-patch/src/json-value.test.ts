import { describe, expect, test } from "vitest";

import { defineMember, importValue, kindOf, type JsonObject } from "./json-value.js";
import { Budget } from "./limits.js";

describe("kindOf", () => {
  test.each([
    [null, "null"],
    [false, "boolean"],
    [0, "number"],
    [-0, "number"],
    ["", "string"],
    [[], "array"],
    [{}, "object"],
    [Object.create(null), "object"],
  ])("%j is a %s", (value, kind) => {
    expect(kindOf(value)).toBe(kind);
  });

  test.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a bigint", 1n],
    ["a symbol", Symbol("s")],
    ["a function", () => 0],
    ["a Date", new Date(0)],
  ])("%s is no JSON kind", (_, value) => {
    expect(kindOf(value)).toBeUndefined();
  });
});

describe("importValue", () => {
  const budget = () => new Budget(1_000_000);

  test("copies the value deep and freezes every container of the copy", () => {
    const input = { a: [1, { b: "c" }], d: {} };
    const imported = importValue(input, budget(), 10);
    if (!imported.ok) throw new Error(imported.code);
    const value = imported.value as { a: [number, { b: string }]; d: object };
    expect(value).toEqual(input);
    for (const container of [value, value.a, value.a[1], value.d]) {
      expect(Object.isFrozen(container)).toBe(true);
    }
    expect(value.a).not.toBe(input.a);
  });

  test("answers why it refuses", () => {
    expect(importValue(undefined, budget(), 10)).toEqual({ ok: false, code: "INVALID_VALUE" });
    expect(importValue([[0]], budget(), 1)).toEqual({ ok: false, code: "LIMIT_EXCEEDED" });
    expect(importValue("abc", new Budget(3), 10)).toEqual({ ok: false, code: "LIMIT_EXCEEDED" });
    expect(importValue({ abc: 1 }, new Budget(4), 10)).toEqual({
      ok: false,
      code: "LIMIT_EXCEEDED",
    });
  });

  test("admits a value exactly as deep as maxDepth and exactly as costly as the budget", () => {
    // [[0]]: two containers; 1 + 1 + 1 units. "abc": 1 + 3 units. { abc: 1 }: 1 + 3 + 1.
    expect(importValue([[0]], budget(), 2).ok).toBe(true);
    expect(importValue([[0]], new Budget(3), 10).ok).toBe(true);
    expect(importValue("abc", new Budget(4), 10).ok).toBe(true);
    expect(importValue({ abc: 1 }, new Budget(5), 10).ok).toBe(true);
  });
});

test("defineMember makes a member as JSON.parse does: writable, enumerable, configurable", () => {
  const object: JsonObject = {};
  defineMember(object, "__proto__", 1);
  expect(Object.getOwnPropertyDescriptor(object, "__proto__")).toEqual({
    value: 1,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
});
