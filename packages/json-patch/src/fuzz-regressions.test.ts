import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { applyPatch, createPatch, JsonPatchError, parsePatch } from "./index.js";
import {
  checkCase,
  checkDiff,
  checkFuzzInput,
  OracleViolation,
  type PatchLibrary,
} from "./test/fuzz-oracle.ts";

// The fuzz oracle (src/test/fuzz-oracle.ts) in the gate: every pinned fuzz regression
// (fuzz/regressions/) and every conformance record replays through it against src/, and
// the oracle is shown to catch each kind of contract break it exists for — an oracle that
// passes everything would let the fuzzer run for nothing.

const library: PatchLibrary = { applyPatch, createPatch, JsonPatchError, parsePatch };
const REGRESSIONS = new URL("../fuzz/regressions/", import.meta.url);

const regressions = readdirSync(REGRESSIONS).filter((name) => !name.endsWith(".md"));

test.each(regressions)("fuzz regression %s passes the oracle", (name) => {
  const bytes = readFileSync(new URL(name, REGRESSIONS));
  expect(() => checkFuzzInput(bytes, library)).not.toThrow();
});

test("the conformance records pass the oracle as fuzz inputs", () => {
  for (const file of ["tests.json", "spec_tests.json"]) {
    const records = JSON.parse(
      readFileSync(new URL(`conformance/${file}`, import.meta.url), "utf8"),
    ) as { doc?: unknown; patch?: unknown }[];
    for (const record of records) {
      if (!Object.hasOwn(record, "patch")) continue;
      const input = new TextEncoder().encode(
        JSON.stringify({ doc: record.doc, patch: record.patch }),
      );
      expect(() => checkFuzzInput(input, library)).not.toThrow();
    }
  }
});

test("an input that is not JSON, or a document that is not I-JSON, tests nothing", () => {
  expect(() => checkFuzzInput(new Uint8Array([0xff, 0x7b]), library)).not.toThrow();
  expect(() => checkCase("\uD800", [{ op: "test", path: "", value: 1 }], library)).not.toThrow();
});

test("a bare patch is applied to every seed document", () => {
  const applied: unknown[] = [];
  const spy: PatchLibrary = {
    ...library,
    applyPatch: (document, patch, limits) => {
      applied.push(document);
      return applyPatch(document, patch, limits);
    },
  };
  checkFuzzInput(new TextEncoder().encode("[]"), spy);
  expect(applied.length).toBeGreaterThan(5);
});

test("a bare input is diffed against every seed document both ways, and a pair is one diff", () => {
  const diffed: [unknown, unknown][] = [];
  const spy: PatchLibrary = {
    ...library,
    createPatch: (source, target, options) => {
      diffed.push([source, target]);
      return createPatch(source, target, options);
    },
  };
  checkFuzzInput(new TextEncoder().encode('"x"'), spy);
  expect(diffed.filter(([, target]) => target === "x").length).toBeGreaterThan(5);
  expect(diffed.filter(([source]) => source === "x").length).toBeGreaterThan(5);
  diffed.length = 0;
  checkFuzzInput(new TextEncoder().encode('{"source": [1], "target": {"a": 2}}'), spy);
  // With and without tests.
  expect(diffed).toEqual([
    [[1], { a: 2 }],
    [[1], { a: 2 }],
  ]);
});

test("a successful apply is diffed back against its document", () => {
  const diffed: unknown[] = [];
  const spy: PatchLibrary = {
    ...library,
    createPatch: (source, target, options) => {
      diffed.push(target);
      return createPatch(source, target, options);
    },
  };
  checkCase({ a: [1] }, [{ op: "add", path: "/b", value: 2 }], spy);
  expect(diffed).toEqual([
    { a: [1], b: 2 },
    { a: [1], b: 2 },
  ]);
});

test("a diff of what is not I-JSON may be refused, but never throws", () => {
  expect(() => checkDiff({ a: "\uD800" }, { a: 1 }, library)).not.toThrow();
  expect(() => checkDiff({ a: 1 }, { a: "\uD800" }, library)).not.toThrow();
});

describe("the oracle catches", () => {
  const add = () => [{ op: "add", path: "/a", value: { b: [1] } }];
  const removeMissing = () => [{ op: "remove", path: "/missing" }];
  const faulty = (overrides: Partial<PatchLibrary>): PatchLibrary => ({ ...library, ...overrides });

  test.each<[string, PatchLibrary, () => unknown[]]>([
    [
      "a throw",
      faulty({
        applyPatch: () => {
          throw new TypeError("boom");
        },
      }),
      add,
    ],
    ["a wrong result", faulty({ applyPatch: () => ({ ok: true, value: { a: 1 } }) }), add],
    [
      "a failure where the reference succeeds",
      faulty({
        applyPatch: () => ({ ok: false, error: new JsonPatchError("PATH_NOT_FOUND", 0, "x") }),
      }),
      add,
    ],
    [
      "a failure at the wrong operation",
      faulty({
        applyPatch: () => ({ ok: false, error: new JsonPatchError("PATH_NOT_FOUND", 3, "x") }),
      }),
      removeMissing,
    ],
    [
      "a success where the reference fails",
      faulty({ parsePatch: (input, limits) => parsePatch([], limits) }),
      removeMissing,
    ],
    [
      "a result that is not JSON",
      faulty({ applyPatch: () => ({ ok: true, value: { a: undefined } as never }) }),
      add,
    ],
    [
      "a result holding a container of the patch",
      faulty({
        applyPatch: (document, parsed) => {
          const result = applyPatch(document, parsed);
          if (result.ok) (result.value as { a: unknown }).a = sharedPatch[0]!.value;
          return result;
        },
      }),
      () => sharedPatch,
    ],
    [
      "a write to the document",
      faulty({
        applyPatch: (document, parsed) => {
          (document as { a: number }).a = 1;
          return applyPatch(document, parsed);
        },
      }),
      add,
    ],
    [
      "a changed prototype",
      faulty({
        applyPatch: (document, parsed) => {
          Reflect.set(Object.prototype, "polluted", 1);
          return applyPatch(document, parsed);
        },
      }),
      add,
    ],
  ])("%s", (_, broken, patch) => {
    try {
      expect(() => checkCase({}, patch(), broken)).toThrow(OracleViolation);
    } finally {
      Reflect.deleteProperty(Object.prototype, "polluted");
    }
  });

  const sharedPatch = [{ op: "add", path: "/a", value: { b: [1] } }];
});

describe("the oracle catches, in a diff", () => {
  const faulty = (overrides: Partial<PatchLibrary>): PatchLibrary => ({ ...library, ...overrides });
  const refused = (code: "INVALID_VALUE" | "LIMIT_EXCEEDED") => () =>
    ({ ok: false, error: new JsonPatchError(code, null, "x") }) as const;

  test.each<[string, PatchLibrary]>([
    [
      "a throw",
      faulty({
        createPatch: () => {
          throw new TypeError("boom");
        },
      }),
    ],
    ["a wrong patch", faulty({ createPatch: () => ({ ok: true, value: [] }) })],
    [
      "a patch that does not parse",
      faulty({ createPatch: () => ({ ok: true, value: [{ op: "bogus" }] as never }) }),
    ],
    [
      "a patch that does not apply",
      faulty({
        createPatch: () => ({ ok: true, value: [{ op: "remove", path: "/missing" }] }),
      }),
    ],
    ["a refusal of two I-JSON documents", faulty({ createPatch: refused("INVALID_VALUE") })],
    [
      "a patch holding a container of the target",
      faulty({
        createPatch: (_, target) => ({
          ok: true,
          value: [{ op: "replace", path: "", value: target as never }],
        }),
      }),
    ],
    [
      "a write to the source",
      faulty({
        createPatch: (source, target, options) => {
          (source as { a: number }).a = 2;
          return createPatch(source, target, options);
        },
      }),
    ],
    [
      "a changed prototype",
      faulty({
        createPatch: (source, target, options) => {
          Reflect.set(Object.prototype, "polluted", 1);
          return createPatch(source, target, options);
        },
      }),
    ],
  ])("%s", (_, broken) => {
    try {
      expect(() => checkDiff({ a: 1 }, { b: { c: [2] } }, broken)).toThrow(OracleViolation);
    } finally {
      Reflect.deleteProperty(Object.prototype, "polluted");
    }
  });

  test("but not a limit's refusal", () => {
    const limited = faulty({ createPatch: refused("LIMIT_EXCEEDED") });
    expect(() => checkDiff({ a: 1 }, { b: 2 }, limited)).not.toThrow();
  });
});
