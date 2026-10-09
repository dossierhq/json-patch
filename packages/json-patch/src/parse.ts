import { assert } from "./assert.js";
import { fail, ok, quote, type JsonPatchResult } from "./errors.js";
import { dataMember, importValue, kindOf, type JsonValue } from "./json-value.js";
import { Budget, resolveLimits, type JsonPatchLimits } from "./limits.js";
import { isStrictlyInside, parsePointer, type PointerTokens } from "./pointer.js";

/** An operation as `applyPatch` runs it: its pointers parsed, its value a frozen copy. */
export type ParsedOperation =
  | {
      readonly op: "add" | "replace" | "test";
      readonly path: PointerTokens;
      readonly pathText: string;
      readonly value: JsonValue;
    }
  | { readonly op: "remove"; readonly path: PointerTokens; readonly pathText: string }
  | {
      readonly op: "move" | "copy";
      readonly path: PointerTokens;
      readonly pathText: string;
      readonly from: PointerTokens;
      readonly fromText: string;
    };

declare const parsedPatchBrand: unique symbol;

/**
 * A patch `parsePatch` accepted. Opaque: its operations are held where only this library
 * reads them, so a patch cannot be forged, and it cannot change once parsed — `applyPatch`
 * refuses (as a broken precondition) anything `parsePatch` did not return.
 */
export interface ParsedPatch {
  readonly [parsedPatchBrand]: true;
  /** How many operations the patch holds. */
  readonly length: number;
}

const OPERATIONS = new WeakMap<ParsedPatch, readonly ParsedOperation[]>();

export function operationsOf(patch: ParsedPatch): readonly ParsedOperation[] {
  const operations = OPERATIONS.get(patch);
  assert(operations !== undefined, "applyPatch takes a patch parsePatch returned");
  assert(operations.length === patch.length, "a parsed patch keeps its length");
  return operations;
}

// The members each operation defines (RFC 6902 §4.1–4.6). Anything else is refused, where
// the RFC ignores it: a stray member is a patch written for another dialect, or a typo
// ("form" for "from") that the RFC would let through as a different operation.
const OPERATION_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["add", new Set(["op", "path", "value"])],
  ["remove", new Set(["op", "path"])],
  ["replace", new Set(["op", "path", "value"])],
  ["move", new Set(["op", "path", "from"])],
  ["copy", new Set(["op", "path", "from"])],
  ["test", new Set(["op", "path", "value"])],
]);

/**
 * Check `input` — typically what `JSON.parse` made of a patch someone sent — and take a
 * private, frozen copy of it to apply. Everything that does not depend on the document is
 * refused here, so `applyPatch` only ever refuses a patch for what the document holds.
 *
 * Never throws for any `input` (a Proxy aside, whose traps are its own): a bad patch comes
 * back as a `JsonPatchError`. A limit out of range is a caller bug, and throws a
 * `RangeError`; limits that are not a plain object throw a `TypeError`.
 */
export function parsePatch(
  input: unknown,
  limits?: Partial<JsonPatchLimits>,
): JsonPatchResult<ParsedPatch> {
  const resolved = resolveLimits(limits);
  if (kindOf(input) !== "array") return fail("INVALID_PATCH", null, "a patch is not an array");
  const source = input as unknown[];
  if (source.length > resolved.maxOperations) {
    return fail("LIMIT_EXCEEDED", null, "the patch has more than maxOperations operations");
  }
  if (Reflect.ownKeys(source).length !== source.length + 1) {
    return fail("INVALID_PATCH", null, "a patch is an array with holes or extra members");
  }
  const budget = new Budget(resolved.maxPatchCost);
  const chargedArray = budget.charge(1);
  assert(chargedArray, "maxPatchCost is at least 1, the cost of the array");
  const operations: ParsedOperation[] = [];
  for (let index = 0; index < source.length; index++) {
    const member = dataMember(source, String(index));
    if (member === undefined) {
      return fail("INVALID_PATCH", null, "a patch is an array with holes or extra members");
    }
    const parsed = parseOperation(member.value, index, resolved, budget);
    if (!parsed.ok) return parsed;
    operations.push(parsed.value);
  }
  assert(operations.length === source.length, "a parsed patch keeps every operation");
  const patch = Object.freeze({ length: operations.length }) as unknown as ParsedPatch;
  OPERATIONS.set(patch, Object.freeze(operations));
  return ok(patch);
}

function parseOperation(
  raw: unknown,
  index: number,
  limits: JsonPatchLimits,
  budget: Budget,
): JsonPatchResult<ParsedOperation> {
  if (kindOf(raw) !== "object") return fail("INVALID_PATCH", index, "operation is not an object");
  const source = raw as object;
  const op = readOp(source, index);
  if (!op.ok) return op;
  const refusal = checkMembers(source, op.value.members, index, budget);
  if (refusal !== undefined) return refusal;
  if (!budget.charge(1 + op.value.op.length)) {
    return fail("LIMIT_EXCEEDED", index, "the patch costs more than maxPatchCost");
  }
  const path = readPointer(source, "path", index, limits, budget);
  if (!path.ok) return path;
  const kind = op.value.op;
  if (kind === "remove") return parseRemove(path.value, index);
  if (kind === "move" || kind === "copy") {
    return parseFromOperation(kind, source, path.value, index, limits, budget);
  }
  return parseValueOperation(kind, source, path.value, index, limits, budget);
}

// The operation's `op`, and the members it defines.
function readOp(
  source: object,
  index: number,
): JsonPatchResult<{ op: ParsedOperation["op"]; members: ReadonlySet<string> }> {
  const op = dataMember(source, "op")?.value;
  if (op === undefined) return fail("INVALID_PATCH", index, 'operation has no "op" member');
  if (typeof op !== "string") return fail("INVALID_PATCH", index, "unknown op (not a string)");
  const members = OPERATION_MEMBERS.get(op);
  if (members === undefined) return fail("INVALID_PATCH", index, `unknown op ${quote(op)}`);
  return ok({ op: op as ParsedOperation["op"], members });
}

function parseRemove(path: Pointer, index: number): JsonPatchResult<ParsedOperation> {
  if (path.tokens.length === 0) {
    return fail("INVALID_PATCH", index, "remove of the root: a patch cannot delete the document");
  }
  return ok(Object.freeze({ op: "remove", path: path.tokens, pathText: path.text }));
}

// Every own member of the operation is a data member the operation defines, and its name
// counts toward the patch's cost. The members' values are checked by their readers.
function checkMembers(
  source: object,
  members: ReadonlySet<string>,
  index: number,
  budget: Budget,
): JsonPatchResult<never> | undefined {
  if (!budget.charge(1))
    return fail("LIMIT_EXCEEDED", index, "the patch costs more than maxPatchCost");
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") return fail("INVALID_PATCH", index, "operation has a symbol key");
    if (!members.has(key)) {
      return fail(
        "INVALID_PATCH",
        index,
        `operation has a member ${quote(key)} its op does not define`,
      );
    }
    if (dataMember(source, key) === undefined) {
      return fail("INVALID_PATCH", index, `operation member ${quote(key)} is not a data property`);
    }
    // Stryker disable next-line BlockStatement: a member name is at most 5 units and never the
    // last charge: when it would not fit, a later one (op name, pointer) cannot fit either.
    if (!budget.charge(key.length)) {
      return fail("LIMIT_EXCEEDED", index, "the patch costs more than maxPatchCost");
    }
  }
  return undefined;
}

interface Pointer {
  readonly tokens: PointerTokens;
  readonly text: string;
}

function readPointer(
  source: object,
  name: "path" | "from",
  index: number,
  limits: JsonPatchLimits,
  budget: Budget,
): JsonPatchResult<Pointer> {
  const text = dataMember(source, name)?.value;
  if (text === undefined) return fail("INVALID_PATCH", index, `operation has no "${name}" member`);
  if (typeof text !== "string") return fail("INVALID_PATCH", index, `"${name}" is not a string`);
  if (!budget.charge(1 + text.length)) {
    return fail("LIMIT_EXCEEDED", index, "the patch costs more than maxPatchCost");
  }
  const parsed = parsePointer(text, limits.maxPointerLength, limits.maxDepth);
  if (!parsed.ok) return fail(parsed.code, index, `"${name}" ${quote(text)}: ${parsed.detail}`);
  return ok({ tokens: parsed.tokens, text });
}

function parseValueOperation(
  op: "add" | "replace" | "test",
  source: object,
  path: Pointer,
  index: number,
  limits: JsonPatchLimits,
  budget: Budget,
): JsonPatchResult<ParsedOperation> {
  const member = dataMember(source, "value");
  if (member === undefined) return fail("INVALID_PATCH", index, 'operation has no "value" member');
  // A value placed at `path` nests inside the containers its tokens pass through; a
  // tested value is only compared, so it only has to fit maxDepth itself.
  const maxDepth = op === "test" ? limits.maxDepth : limits.maxDepth - path.tokens.length;
  assert(maxDepth >= 0, "a parsed pointer fits maxDepth");
  const imported = importValue(member.value, budget, maxDepth);
  if (!imported.ok) {
    return imported.code === "INVALID_VALUE"
      ? fail("INVALID_VALUE", index, '"value" is not I-JSON')
      : fail("LIMIT_EXCEEDED", index, '"value" exceeds maxPatchCost or, at its path, maxDepth');
  }
  return ok(Object.freeze({ op, path: path.tokens, pathText: path.text, value: imported.value }));
}

function parseFromOperation(
  op: "move" | "copy",
  source: object,
  path: Pointer,
  index: number,
  limits: JsonPatchLimits,
  budget: Budget,
): JsonPatchResult<ParsedOperation> {
  const from = readPointer(source, "from", index, limits, budget);
  if (!from.ok) return from;
  if (op === "move" && isStrictlyInside(path.tokens, from.value.tokens)) {
    return fail("INVALID_PATCH", index, `move from ${quote(from.value.text)} into its own subtree`);
  }
  return ok(
    Object.freeze({
      op,
      path: path.tokens,
      pathText: path.text,
      from: from.value.tokens,
      fromText: from.value.text,
    }),
  );
}
