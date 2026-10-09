import { assert } from "./assert.js";
import type { Budget, WorkBudget } from "./limits.js";

/**
 * A JSON value as this library holds it: `null`, a boolean, a finite number, a string, an
 * array of values or a plain object of values. See the README for the stricter I-JSON
 * rules a patch value is held to.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonKind = "null" | "boolean" | "number" | "string" | "array" | "object";

/**
 * The JSON kind of `value`, or undefined when it is none: `undefined`, a non-finite
 * number, a bigint, a symbol, a function, and every object but an array of this realm and
 * a plain object (prototype `Object.prototype` or null). Only the value itself is looked
 * at — its members are the caller's to walk.
 */
export function kindOf(value: unknown): JsonKind | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return Number.isFinite(value) ? "number" : undefined;
    case "string":
      return "string";
    case "object":
      return containerKindOf(value);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return undefined;
  }
}

function containerKindOf(value: object): JsonKind | undefined {
  const proto = Object.getPrototypeOf(value) as unknown;
  if (Array.isArray(value)) return proto === Array.prototype ? "array" : undefined;
  return proto === Object.prototype || proto === null ? "object" : undefined;
}

/** A JSON container: an array or a plain object. */
export type JsonContainer = JsonValue[] | JsonObject;

// What a patch value costs by itself as importValue meets it (see JsonPatchLimits): one
// unit, plus a string's length. A container's members are charged as they are visited.
function contentLength(value: JsonValue): number {
  return typeof value === "string" ? value.length : 0;
}

// What importing charges: the patch's cost, always; and when the copy is work a diff does
// (createPatch copying a value into its patch), that work too, as walk.ts charges a copy —
// one value per value, a string's and a member name's characters as work.
class ImportCharges {
  readonly #cost: Budget;
  readonly #work: WorkBudget | undefined;

  constructor(cost: Budget, work: WorkBudget | undefined) {
    this.#cost = cost;
    this.#work = work;
  }

  value(value: JsonValue): boolean {
    const length = contentLength(value);
    if (!this.#cost.charge(1 + length)) return false;
    return this.#work === undefined || (this.#work.values(1) && this.#work.chars(length));
  }

  name(key: string): boolean {
    if (!this.#cost.charge(key.length)) return false;
    return this.#work === undefined || this.#work.chars(key.length);
  }
}

type ImportFailure = { readonly ok: false; readonly code: "INVALID_VALUE" | "LIMIT_EXCEEDED" };
export type Imported = { readonly ok: true; readonly value: JsonValue } | ImportFailure;

const INVALID: ImportFailure = { ok: false, code: "INVALID_VALUE" };
const OVER_LIMIT: ImportFailure = { ok: false, code: "LIMIT_EXCEEDED" };

interface ImportFrame {
  readonly source: object;
  readonly target: JsonContainer;
  // The nesting of this container: 1 for a top-level one.
  readonly depth: number;
}

/**
 * A deep, frozen copy of `input` if it is an I-JSON value no deeper than `maxDepth`
 * (containers nested) whose cost fits `budget`, and whose copying fits `work` when there
 * is one; otherwise why not. The copy is what makes a parsed patch safe to hold: the
 * caller's value may change after it was checked, the copy cannot.
 *
 * Walks with an explicit stack, never recursion, so no input can overflow the call stack:
 * a value nested deeper than `maxDepth` is refused as soon as the walk reaches the
 * container past the limit, and a cyclic value is one of those.
 *
 * Reads members through their property descriptors, so a getter is refused, never run.
 * A Proxy is outside the domain: its traps run, and whatever they do is theirs.
 */
export function importValue(
  input: unknown,
  budget: Budget,
  maxDepth: number,
  work?: WorkBudget,
): Imported {
  assert(Number.isSafeInteger(maxDepth) && maxDepth >= 0, "maxDepth is a non-negative integer");
  const stack: ImportFrame[] = [];
  // A refused top value pushed no frame, so the loop is skipped and the refusal returned.
  const charges = new ImportCharges(budget, work);
  const top = importNode(input, 1, maxDepth, charges, stack);
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const filled = Array.isArray(frame.target)
      ? importArrayMembers(frame, frame.target, maxDepth, charges, stack)
      : importObjectMembers(frame, frame.target, maxDepth, charges, stack);
    if (filled !== undefined) return filled;
    Object.freeze(frame.target);
  }
  return top;
}

// One value, copied if it is a scalar; if it is a container, an empty one of its kind in
// its place and a frame on `stack` to fill it later. `depth` is the nesting the value
// would have if it is a container.
function importNode(
  value: unknown,
  depth: number,
  maxDepth: number,
  charges: ImportCharges,
  stack: ImportFrame[],
): Imported {
  const kind = kindOf(value);
  if (kind === undefined) return INVALID;
  const node = value as JsonValue;
  if (!charges.value(node)) return OVER_LIMIT;
  if (kind === "string") {
    return (node as string).isWellFormed() ? { ok: true, value: node } : INVALID;
  }
  if (kind !== "array" && kind !== "object") return { ok: true, value: node };
  if (depth > maxDepth) return OVER_LIMIT;
  const target: JsonContainer = kind === "array" ? [] : {};
  stack.push({ source: node as object, target, depth });
  return { ok: true, value: target };
}

function importArrayMembers(
  frame: ImportFrame,
  target: JsonValue[],
  maxDepth: number,
  charges: ImportCharges,
  stack: ImportFrame[],
): ImportFailure | undefined {
  const source = frame.source as unknown[];
  const length = source.length;
  // Dense, and nothing but its indices and `length`: a hole or an extra member is not
  // JSON. Counting own keys first also keeps the loop below to the keys that exist, so a
  // sparse array with a huge `length` costs what it holds, not what it claims.
  if (Reflect.ownKeys(source).length !== length + 1) return INVALID;
  for (let index = 0; index < length; index++) {
    const member = dataMember(source, String(index));
    if (member === undefined) return INVALID;
    const child = importNode(member.value, frame.depth + 1, maxDepth, charges, stack);
    if (child.ok === false) return child;
    target.push(child.value);
  }
  assert(target.length === length, "an imported array keeps every member");
  return undefined;
}

function importObjectMembers(
  frame: ImportFrame,
  target: JsonObject,
  maxDepth: number,
  charges: ImportCharges,
  stack: ImportFrame[],
): ImportFailure | undefined {
  for (const key of Reflect.ownKeys(frame.source)) {
    if (typeof key !== "string" || !key.isWellFormed()) return INVALID;
    if (!charges.name(key)) return OVER_LIMIT;
    const member = dataMember(frame.source, key);
    if (member === undefined) return INVALID;
    const child = importNode(member.value, frame.depth + 1, maxDepth, charges, stack);
    if (child.ok === false) return child;
    defineMember(target, key, child.value);
  }
  return undefined;
}

// An own, enumerable data property of `source` — what JSON.parse makes — or undefined.
// Read through the descriptor, so an accessor is reported, never called.
export function dataMember(source: object, key: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || descriptor.enumerable !== true) return undefined;
  return "value" in descriptor ? { value: descriptor.value } : undefined;
}

/**
 * Store `value` as an own, enumerable, writable, configurable member of `target` — what
 * JSON.parse makes. Defined, never assigned: an assignment through "__proto__" would swap
 * the object's prototype instead of storing the member, and "__proto__" is an ordinary
 * member name in JSON. An existing member keeps its place in the key order.
 */
export function defineMember(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
