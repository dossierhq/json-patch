import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  applyPatch,
  parsePatch,
  type JsonPatchErrorCode,
  type JsonPatchResult,
  type JsonValue,
} from "../index.js";
import { toTree, treeEqual, type Tree } from "../test/reference-model.js";
import { errorOf, okValue } from "../test/results.js";

// The community conformance suite for RFC 6902, vendored from
// https://github.com/json-patch/json-patch-tests at 2a928f9044aad35c74e2788d498bcf2c6b91adea
// (Apache-2.0, see ./NOTICE): tests.json, and spec_tests.json with the RFC's appendix A.
// Every record runs, the disabled ones included, since each disabled record is a question
// an implementation has to answer one way or the other.
//
// A record may only disagree with the suite by appearing in DIVERSIONS, with the outcome
// this library has instead and why. Those are exactly the diversions the README lists; a
// record that newly disagrees fails, and so does a diversion that no longer happens.

interface SuiteRecord {
  readonly comment?: string;
  readonly doc?: unknown;
  readonly patch?: unknown;
  readonly expected?: unknown;
  readonly error?: string;
  readonly disabled?: boolean;
}

type Expected =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code?: JsonPatchErrorCode };

// Keyed by `${file}#${index}`, because comments repeat.
const DIVERSIONS: ReadonlyMap<string, { readonly outcome: Expected; readonly why: string }> =
  new Map([
    [
      "tests.json#45",
      {
        outcome: { ok: false, code: "INVALID_PATCH" },
        why: "a member its op does not define is refused, where RFC 6902 §4 ignores it",
      },
    ],
    [
      "spec_tests.json#11",
      {
        outcome: { ok: false, code: "INVALID_PATCH" },
        why: "A.11 (ignoring unrecognized elements): the same refusal of an undefined member",
      },
    ],
  ]);

// What this library answers to each record the suite leaves disabled. None is a diversion:
// the suite disables them because implementations disagree, not because the RFC does.
const DISABLED: ReadonlyMap<string, { readonly outcome: Expected; readonly why: string }> = new Map(
  [
    [
      "tests.json#10",
      {
        outcome: { ok: true, value: "bar" },
        why: "a document may be any JSON value, so a scalar root can be replaced",
      },
    ],
    [
      "tests.json#56",
      { outcome: { ok: true, value: { foo: 1 } }, why: "the root can be tested like any location" },
    ],
    [
      "tests.json#85",
      {
        outcome: { ok: false, code: "INVALID_PATCH" },
        why: "JSON.parse keeps one of the two `op` members; the `value` a move does not define is what is refused",
      },
    ],
    [
      "spec_tests.json#13",
      {
        outcome: { ok: false, code: "INVALID_PATCH" },
        why: "A.13: likewise, the `value` a remove does not define is refused",
      },
    ],
  ],
);

// The vendored files' SHA-256, so an edit to them (a formatter's included) fails loudly
// instead of quietly changing what "conformance" means.
const SHA256: ReadonlyMap<string, string> = new Map([
  ["tests.json", "de3dce3d0d5029fed83007e50b54607750dd3d1478d3c59ca35fdc18fb1a04ae"],
  ["spec_tests.json", "a26b050292207033e5cccc5d6102b7bd6f8add7db0d0680e5d46a7ecf40a8c7b"],
]);

function read(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

function load(file: string): SuiteRecord[] {
  return JSON.parse(read(file)) as SuiteRecord[];
}

function resultOf(record: SuiteRecord): JsonPatchResult<JsonValue> {
  const parsed = parsePatch(record.patch);
  return parsed.ok ? applyPatch(record.doc as JsonValue, parsed.value) : parsed;
}

function expectDisabledListed(key: string, record: SuiteRecord): void {
  expect({ key, disabled: record.disabled === true }).toEqual({
    key,
    disabled: DISABLED.has(key),
  });
}

function suiteOutcome(record: SuiteRecord): Expected {
  if (record.error !== undefined) return { ok: false };
  return { ok: true, value: Object.hasOwn(record, "expected") ? record.expected : record.doc };
}

function casesOf(file: string) {
  return load(file).flatMap((record, index) => {
    if (!Object.hasOwn(record, "patch")) return [];
    const key = `${file}#${index}`;
    const special = DIVERSIONS.get(key) ?? DISABLED.get(key);
    const name = `#${index} ${record.comment ?? ""}${special ? ` — ${special.why}` : ""}`;
    return [{ name, key, record, expected: special?.outcome ?? suiteOutcome(record) }];
  });
}

describe.each(["tests.json", "spec_tests.json"])("%s", (file) => {
  test("is the vendored suite, unmodified", () => {
    expect(createHash("sha256").update(read(file)).digest("hex")).toBe(SHA256.get(file));
  });

  const cases = casesOf(file);

  test.each(cases.flatMap(({ expected, ...rest }) => (expected.ok ? [{ ...rest, expected }] : [])))(
    "$name",
    ({ key, record, expected }) => {
      expectDisabledListed(key, record);
      const value = okValue(resultOf(record));
      expect(treeEqual(toTree(value) as Tree, toTree(expected.value) as Tree)).toBe(true);
    },
  );

  test.each(cases.flatMap(({ expected, ...rest }) => (expected.ok ? [] : [{ ...rest, expected }])))(
    "$name",
    ({ key, record, expected }) => {
      expectDisabledListed(key, record);
      // A record that names no code accepts any refusal.
      expect(errorOf(resultOf(record))).toMatchObject(
        expected.code === undefined ? {} : { code: expected.code },
      );
    },
  );
});

test("every listed diversion and disabled record exists", () => {
  for (const key of [...DIVERSIONS.keys(), ...DISABLED.keys()]) {
    const [file, index] = key.split("#") as [string, string];
    expect({ key, found: load(file)[Number(index)] !== undefined }).toEqual({ key, found: true });
  }
});
