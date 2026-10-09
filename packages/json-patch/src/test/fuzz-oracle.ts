// What a fuzz input must never do to the library, shared by the Jazzer.js target
// (fuzz/patch.fuzz.ts, which runs it against the built dist/) and the regression test
// (src/fuzz-regressions.test.ts, which runs it against src/ in the gate).
//
// The library comes in as an argument instead of an import: the fuzz target runs under
// plain Node, whose type stripping loads this file but not src/ (whose imports name the
// `.js` files the build writes). For the same reason every import here names a `.ts` file
// with no imports of its own, and the syntax stays erasable (no enums, no parameter
// properties).

import type { applyPatch, createPatch, JsonPatchError, parsePatch } from "../index.js";
import { containerCounts, deepFreeze } from "./json-helpers.ts";
import { referenceApply, toTree, treeEqual, type Tree } from "./reference-model.ts";

export interface PatchLibrary {
  readonly parsePatch: typeof parsePatch;
  readonly applyPatch: typeof applyPatch;
  readonly createPatch: typeof createPatch;
  readonly JsonPatchError: typeof JsonPatchError;
}

/** A broken contract. The fuzz target lets it escape, which is what makes it a crash. */
export class OracleViolation extends Error {
  override name = "OracleViolation";
}

// Documents a bare patch is applied to: each kind of root, with members a patch's
// pointers are likely to meet, prototype names among them.
const SEED_DOCUMENTS: readonly unknown[] = [
  {},
  [],
  0,
  "",
  null,
  JSON.parse('{"a":1,"b":[1,2,{"c":"d"}],"__proto__":{"x":null},"constructor":[],"":{"":0}}'),
  JSON.parse('[[0,1],{"a":{"b":{"c":[]}}},"s",true]'),
];

/**
 * Check one fuzz input. The bytes are decoded as UTF-8 and parsed as JSON; an input that is
 * not JSON tests nothing and passes (the parser is not under test). A JSON object with
 * exactly the members `doc` and `patch` is one case, the shape of a conformance suite
 * record, so the suite seeds the corpus as it is; one with exactly `source` and `target` is
 * one diff. Anything else is a patch, applied to each of the seed documents, and a document,
 * diffed against each of them both ways.
 */
export function checkFuzzInput(bytes: Uint8Array, library: PatchLibrary): void {
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return;
  }
  if (hasExactly(input, "doc", "patch")) {
    checkCase(input.doc, input.patch, library);
    return;
  }
  if (hasExactly(input, "source", "target")) {
    checkDiff(input.source, input.target, library);
    return;
  }
  for (const document of SEED_DOCUMENTS) {
    checkCase(document, input, library);
    checkDiff(document, input, library);
    checkDiff(input, document, library);
  }
}

function hasExactly<A extends string, B extends string>(
  input: unknown,
  first: A,
  second: B,
): input is Record<A | B, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const keys = Object.keys(input).sort();
  return keys.length === 2 && keys[0] === first && keys[1] === second;
}

/**
 * Parse and apply `patch` to `document` and hold the outcome to the contract:
 * - nothing is thrown, whatever the patch;
 * - the outcome is the reference model's (src/test/reference-model.ts) — the same result,
 *   or a failure with the same code at the same operation — unless a limit refused it;
 * - the document is unchanged (it is deep-frozen, so a write would also have thrown);
 * - Object.prototype and Array.prototype are unchanged;
 * - the result holds no container of the patch.
 * A document that is not I-JSON (JSON.parse admits lone surrogates) is outside the
 * library's precondition, and skipped.
 */
export function checkCase(document: unknown, patch: unknown, library: PatchLibrary): void {
  const before = toTree(document);
  if (before === undefined) return;
  deepFreeze(document);
  const fingerprint = prototypeFingerprint();
  const actual = run(document, patch, library);
  if (actual.ok) {
    expectSameResult(actual.value, referenceApply(before, patch), patch);
    // The result shares every container the patch left alone with the document.
    checkDiff(document, actual.value, library);
  } else if (actual.error.code !== "LIMIT_EXCEEDED") {
    expectSameFailure(actual.error, referenceApply(before, patch));
  }
  if (!treeEqual(toTree(document) as Tree, before)) fail("the document changed");
  if (prototypeFingerprint() !== fingerprint) fail("a prototype changed");
}

/**
 * Diff `source` to `target`, with and without tests, and hold the outcome to createPatch's
 * contract:
 * - nothing is thrown, whatever the inputs, and a patch that comes back parses;
 * - for two I-JSON documents, the patch comes back (or a limit refused it), and applied to
 *   `source` yields `target`;
 * - neither document changes (both are deep-frozen), nor does a prototype;
 * - the patch holds no container of either document.
 */
export function checkDiff(source: unknown, target: unknown, library: PatchLibrary): void {
  deepFreeze(source);
  deepFreeze(target);
  const fingerprint = prototypeFingerprint();
  const sourceTree = toTree(source);
  const targetTree = toTree(target);
  // Both documents I-JSON: the diff must succeed, bar a limit, and round-trip.
  const json = sourceTree !== undefined && targetTree !== undefined ? targetTree : undefined;
  for (const tests of [false, true]) {
    const diffed = guard(() => library.createPatch(source, target, { tests }));
    if (diffed.ok) checkPatch(source, target, diffed.value, json, library);
    else checkRefusal(diffed.error, json !== undefined);
  }
  if (sourceTree !== undefined && !treeEqual(toTree(source) as Tree, sourceTree)) {
    fail("the source changed");
  }
  if (prototypeFingerprint() !== fingerprint) fail("a prototype changed");
}

// A refusal from createPatch: of two I-JSON documents, only a limit may refuse a diff.
function checkRefusal(error: JsonPatchError, json: boolean): void {
  if (json && error.code !== "LIMIT_EXCEEDED") {
    fail(`refused two I-JSON documents with ${error.code}`);
  }
}

// A patch createPatch returned: it parses, and — when both documents are I-JSON, with
// `targetTree` the target's — it turns the source into the target and holds no container
// of either.
function checkPatch(
  source: unknown,
  target: unknown,
  patch: unknown,
  targetTree: Tree | undefined,
  library: PatchLibrary,
): void {
  const parsed = guard(() => library.parsePatch(patch));
  if (!parsed.ok) fail(`the patch does not parse: ${parsed.error.code}`);
  if (targetTree === undefined) return;
  const applied = guard(() => library.applyPatch(source as never, parsed.value));
  if (!applied.ok) fail(`the patch does not apply to its source: ${applied.error.code}`);
  const result = toTree(applied.value);
  if (result === undefined || !treeEqual(result, targetTree)) {
    fail("the patch does not turn the source into the target");
  }
  const inDocuments = new Set([
    ...containerCounts(source).keys(),
    ...containerCounts(target).keys(),
  ]);
  for (const container of containerCounts(patch).keys()) {
    if (inDocuments.has(container)) fail("the patch holds a container of a document");
  }
}

function guard<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw new OracleViolation(`threw instead of returning a result: ${String(error)}`, {
      cause: error,
    });
  }
}

function run(document: unknown, patch: unknown, library: PatchLibrary) {
  return guard(() => {
    const parsed = library.parsePatch(patch);
    // The document passed toTree, so it is JSON.
    return parsed.ok ? library.applyPatch(document as never, parsed.value) : parsed;
  });
}

function expectSameResult(
  result: unknown,
  expected: ReturnType<typeof referenceApply>,
  patch: unknown,
): void {
  if (!expected.ok) fail(`succeeded where the reference failed with ${expected.code}`);
  const tree = toTree(result);
  if (tree === undefined) fail("the result is not I-JSON");
  if (!treeEqual(tree, expected.value)) fail("the result differs from the reference's");
  expectUnshared(result, patch);
}

function expectSameFailure(error: JsonPatchError, expected: ReturnType<typeof referenceApply>) {
  if (expected.ok) fail(`failed with ${error.code} where the reference succeeded`);
  if (error.code !== expected.code || error.operationIndex !== expected.index) {
    fail(
      `failed with ${error.code} at ${error.operationIndex} where the reference failed ` +
        `with ${expected.code} at ${expected.index}`,
    );
  }
}

function expectUnshared(result: unknown, patch: unknown): void {
  const inPatch = containerCounts(patch);
  for (const container of containerCounts(result).keys()) {
    if (inPatch.has(container)) fail("the result holds a container of the patch");
  }
}

function prototypeFingerprint(): string {
  const describe = (proto: object) =>
    Reflect.ownKeys(proto).map((key) => `${String(key)}:${typeof Reflect.get(proto, key)}`);
  return [...describe(Object.prototype), "|", ...describe(Array.prototype)].join(",");
}

function fail(message: string): never {
  throw new OracleViolation(message);
}
