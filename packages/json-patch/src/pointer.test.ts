import { describe, expect, test } from "vitest";

import { applyPatch, parsePatch, type JsonValue } from "./index.js";
import { arrayIndex, isSameLocation, isStrictlyInside, parsePointer } from "./pointer.js";

const parse = (pointer: string) => parsePointer(pointer, 4096, 256);

describe("parsePointer", () => {
  test.each([
    ["", []],
    ["/", [""]],
    ["//", ["", ""]],
    ["/a/b", ["a", "b"]],
    ["/a~1b", ["a/b"]],
    ["/m~0n", ["m~n"]],
    ["/~01", ["~1"]],
    ["/~10", ["/0"]],
    ["/ ", [" "]],
    ["/\u{1F600}", ["\u{1F600}"]],
    ["/__proto__", ["__proto__"]],
  ])("%j is %j", (pointer, tokens) => {
    expect(parse(pointer)).toEqual({ ok: true, tokens });
  });

  test.each([
    ["a", 'pointer does not start with "/"'],
    ["#/a", 'pointer does not start with "/"'],
    [" /a", 'pointer does not start with "/"'],
    ["/~", 'pointer has a "~" not followed by 0 or 1'],
    ["/a~", 'pointer has a "~" not followed by 0 or 1'],
    ["/~2", 'pointer has a "~" not followed by 0 or 1'],
    ["/~~0", 'pointer has a "~" not followed by 0 or 1'],
    ["/\uD800", "pointer has a lone surrogate"],
    ["/a\uDC00", "pointer has a lone surrogate"],
  ])("%j is refused: %s", (pointer, detail) => {
    expect(parse(pointer)).toEqual({ ok: false, code: "INVALID_POINTER", detail });
  });

  test("a pointer at its limits is accepted; one past them is refused", () => {
    expect(parsePointer("/abc", 4, 1).ok).toBe(true);
    expect(parsePointer("/abcd", 4, 1)).toEqual({
      ok: false,
      code: "LIMIT_EXCEEDED",
      detail: "pointer is longer than maxPointerLength",
    });
    expect(parsePointer("/a/b", 4, 2).ok).toBe(true);
    expect(parsePointer("/a/b", 4, 1)).toEqual({
      ok: false,
      code: "LIMIT_EXCEEDED",
      detail: "pointer is deeper than maxDepth",
    });
  });

  test("the tokens are frozen", () => {
    const parsed = parse("/a/b");
    expect(parsed.ok && Object.isFrozen(parsed.tokens)).toBe(true);
  });
});

describe("arrayIndex", () => {
  test.each([
    ["0", 0],
    ["1", 1],
    ["10", 10],
    ["999999999999999", 999_999_999_999_999],
    ["1000000000000000", Number.MAX_SAFE_INTEGER],
    ["99999999999999999999", Number.MAX_SAFE_INTEGER],
  ])("%j is index %d", (token, index) => {
    expect(arrayIndex(token)).toBe(index);
  });

  test.each(["", "-", "00", "01", "-1", "+1", "1e0", "1.0", " 1", "1 ", "0x1", "١", "a"])(
    "%j is not an index",
    (token) => {
      expect(arrayIndex(token)).toBe(-1);
    },
  );
});

test("isStrictlyInside compares tokens, not text", () => {
  expect(isStrictlyInside(["a", "b"], ["a"])).toBe(true);
  expect(isStrictlyInside(["a"], [])).toBe(true);
  expect(isStrictlyInside(["a"], ["a"])).toBe(false);
  expect(isStrictlyInside(["ab"], ["a"])).toBe(false);
  expect(isStrictlyInside(["a/b", "c"], ["a", "b"])).toBe(false);
  expect(isSameLocation(["a", "b"], ["a", "b"])).toBe(true);
  expect(isSameLocation(["a"], ["a", "b"])).toBe(false);
});

// RFC 6901 §5: every pointer in the example resolves to the value it lists.
test("the RFC 6901 examples resolve", () => {
  const document = JSON.parse(`{
    "foo": ["bar", "baz"], "": 0, "a/b": 1, "c%d": 2, "e^f": 3,
    "g|h": 4, "i\\\\j": 5, "k\\"l": 6, " ": 7, "m~n": 8
  }`) as JsonValue;
  const examples: [string, JsonValue][] = [
    ["", document],
    ["/foo", ["bar", "baz"]],
    ["/foo/0", "bar"],
    ["/", 0],
    ["/a~1b", 1],
    ["/c%d", 2],
    ["/e^f", 3],
    ["/g|h", 4],
    ["/i\\j", 5],
    ['/k"l', 6],
    ["/ ", 7],
    ["/m~0n", 8],
  ];
  for (const [path, value] of examples) {
    const patch = parsePatch([{ op: "test", path, value }]);
    expect({ path, ok: patch.ok && applyPatch(document, patch.value).ok }).toEqual({
      path,
      ok: true,
    });
  }
});
