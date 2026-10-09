import { describe, expect, test } from "vitest";

import type { JsonValue } from "./json-value.js";
import { WorkBudget, HARD_LIMITS } from "./limits.js";
import { copyValue, jsonEqual, measureDepth, OVER_BUDGET } from "./walk.js";

// A budget of `units` of work and `values` values (neither limited unless given).
function work(units: number, values = HARD_LIMITS.maxApplyValues): WorkBudget {
  return new WorkBudget({ ...HARD_LIMITS, maxApplyWork: units, maxApplyValues: values });
}

// Every walk charges for a container's members before it schedules or reads any of them,
// so the work budget bounds what a walk touches and allocates, not only what it compares.
// An array that counts every touch of its members makes "touches" observable: reading one
// (a `get` or a descriptor read of an index) counts one, listing its keys counts them all.
// A walk the budget refuses at a big array must not have touched its members first.
function countingArray(length: number): { array: JsonValue[]; reads: () => number } {
  let reads = 0;
  const isIndex = (key: string | symbol) => typeof key === "string" && /^\d+$/.test(key);
  const array = new Proxy(
    Array.from({ length }, () => 0),
    {
      get(target, key, receiver) {
        if (isIndex(key)) reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
      getOwnPropertyDescriptor(target, key) {
        if (isIndex(key)) reads++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        reads += target.length;
        return Reflect.ownKeys(target);
      },
    },
  );
  return { array, reads: () => reads };
}

describe("a walk the budget refuses at a big array reads none of its members", () => {
  test("measureDepth", () => {
    const { array, reads } = countingArray(1000);
    expect(measureDepth(array, work(10))).toBe(OVER_BUDGET);
    expect(reads()).toBe(0);
  });

  test("jsonEqual", () => {
    const { array, reads } = countingArray(1000);
    expect(
      jsonEqual(
        array,
        Array.from({ length: 1000 }, () => 0),
        work(10),
      ),
    ).toBe(OVER_BUDGET);
    expect(reads()).toBe(0);
  });

  test("copyValue", () => {
    const { array, reads } = countingArray(1000);
    expect(copyValue(array, work(10))).toBe(OVER_BUDGET);
    expect(reads()).toBe(0);
  });
});

describe("each walk charges every node once", () => {
  // The same totals the pinned fixture costs in apply.test.ts rely on: one unit per value,
  // plus the length of every string and member name.
  const value = { ab: [1, "xyz", { c: null }], d: {} };
  // Values: the object, the array, 1, "xyz", { c }, null, {} = 7; strings and names:
  // "ab" 2 + "xyz" 3 + "c" 1 + "d" 1 = 7.
  const COST = 14;

  test("copyValue charges the value's cost", () => {
    expect(copyValue(value, work(COST))).not.toBe(OVER_BUDGET);
    expect(copyValue(value, work(COST - 1))).toBe(OVER_BUDGET);
  });

  test("jsonEqual charges the value's cost to find two copies equal", () => {
    const other = { ab: [1, "xyz", { c: null }], d: {} };
    expect(jsonEqual(value, other, work(COST))).toBe(true);
    expect(jsonEqual(value, other, work(COST - 1))).toBe(OVER_BUDGET);
  });

  test("a copy stops at a member whose content does not fit, placing nothing", () => {
    // ["abcdef"]: the array 1, its member 1, the content 6 = 8.
    expect(copyValue(["abcdef"], work(8))).toEqual({ value: ["abcdef"], depth: 1 });
    expect(copyValue(["abcdef"], work(7))).toBe(OVER_BUDGET);
    // { k: "abcdef" }: the object 1, its member 1, the name 1, the content 6 = 9.
    expect(copyValue({ k: "abcdef" }, work(9))).toEqual({ value: { k: "abcdef" }, depth: 1 });
    expect(copyValue({ k: "abcdef" }, work(8))).toBe(OVER_BUDGET);
  });

  test("a string is charged its content once its unit is paid", () => {
    // "abcdef": one unit plus six code units.
    expect(copyValue("abcdef", work(7))).toEqual({ value: "abcdef", depth: 0 });
    expect(copyValue("abcdef", work(6))).toBe(OVER_BUDGET);
    expect(jsonEqual("abcdef", "abcdef", work(7))).toBe(true);
    expect(jsonEqual("abcdef", "abcdef", work(6))).toBe(OVER_BUDGET);
  });

  test("measureDepth charges one unit per value", () => {
    expect(measureDepth(value, work(7))).toBe(3);
    expect(measureDepth(value, work(6))).toBe(OVER_BUDGET);
  });
  // Values alone: the 7 above, whatever the strings' and names' lengths.
  const VALUES = 7;

  test("every walk counts each value once, and no string's characters", () => {
    const other = { ab: [1, "xyz", { c: null }], d: {} };
    const walks = [
      (budget: WorkBudget) => copyValue(value, budget),
      (budget: WorkBudget) => jsonEqual(value, other, budget),
      (budget: WorkBudget) => measureDepth(value, budget),
    ];
    for (const walk of walks) {
      expect(walk(work(1000, VALUES))).not.toBe(OVER_BUDGET);
      const short = work(1000, VALUES - 1);
      expect(walk(short)).toBe(OVER_BUDGET);
      expect(short.exhausted).toBe("maxApplyValues");
    }
    expect(copyValue("x".repeat(1000), work(1001, 1))).not.toBe(OVER_BUDGET);
  });

  test("a budget records the limit a charge met", () => {
    const tight = work(3);
    expect(copyValue(["abcdef"], tight)).toBe(OVER_BUDGET);
    expect(tight.exhausted).toBe("maxApplyWork");
    expect(work(3).exhausted).toBeUndefined();
  });
});
