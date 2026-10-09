import { assert } from "./assert.js";
import { defineMember, kindOf, type JsonContainer, type JsonValue } from "./json-value.js";
import type { WorkBudget } from "./limits.js";

// The walks `applyPatch` makes over whole values: copy, compare, measure. Each walks with
// an explicit stack, never recursion, so no value's depth can overflow the call stack.
//
// Each charges `budget` before it touches: a value's nodes are paid for as they become
// known, so the budget bounds what a walk reads, schedules and allocates, not just what it
// compares. The root costs one value up front; a container's members cost one value each
// the moment its member list is known, before any member is read or scheduled; a string's
// content is charged (as work, not values) when the string is visited, a member name when
// it is read. An array's
// length is known without reading it. An object's member list is not: `Object.keys` is the
// one step a walk takes before paying for it, and it is paid for straight after, so a walk
// the budget stops has enumerated at most the one object it stopped at.
//
// Their input is JSON by precondition: a patch value parsePatch imported, or a part of the
// document, which the caller vouches for. They assert what they touch (a non-JSON value is
// a JsonPatchInvariantError, not a result) rather than re-validate: re-checking a document
// in full on every apply would cost what structural sharing saves.

/** Returned by a walk that `budget` stopped. */
export const OVER_BUDGET: unique symbol = Symbol("over budget");

const NOT_JSON = "the document is JSON";

// The member `key` of a JSON object, read through its descriptor (a document is JSON by
// precondition, so it is a data member).
function memberOf(container: object, key: string): JsonValue {
  const member = Object.getOwnPropertyDescriptor(container, key);
  assert(member !== undefined && "value" in member, NOT_JSON);
  return member.value as JsonValue;
}

// The cost of visiting `value` once its unit is paid: a string's content.
function contentCost(value: JsonValue): number {
  return typeof value === "string" ? value.length : 0;
}

interface CopyFrame {
  readonly source: JsonContainer;
  readonly target: JsonContainer;
  readonly depth: number;
}

/**
 * A deep copy of `value` that shares no container with it, and its depth (containers
 * nested; 0 for a scalar). Strings are shared: they are immutable, and charged by length
 * all the same.
 */
export function copyValue(
  value: JsonValue,
  budget: WorkBudget,
): { readonly value: JsonValue; readonly depth: number } | typeof OVER_BUDGET {
  if (!budget.values(1)) return OVER_BUDGET;
  const stack: CopyFrame[] = [];
  const top = copyNode(value, 1, budget, stack);
  if (top === OVER_BUDGET) return OVER_BUDGET;
  // A scalar pushed no frame and has depth 0; a container's frames bring theirs.
  let depth = 0;
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    depth = Math.max(depth, frame.depth);
    if (copyMembers(frame, budget, stack) === OVER_BUDGET) return OVER_BUDGET;
  }
  return { value: top, depth };
}

function copyMembers(
  frame: CopyFrame,
  budget: WorkBudget,
  stack: CopyFrame[],
): undefined | typeof OVER_BUDGET {
  const { source, target } = frame;
  if (Array.isArray(source)) {
    assert(Array.isArray(target), "a copy keeps its kind");
    if (!budget.values(source.length)) return OVER_BUDGET;
    for (const member of source) {
      const child = copyNode(member, frame.depth + 1, budget, stack);
      if (child === OVER_BUDGET) return OVER_BUDGET;
      target.push(child);
    }
    assert(target.length === source.length, "a copied array keeps every member");
    return undefined;
  }
  assert(!Array.isArray(target), "a copy keeps its kind");
  const keys = Object.keys(source);
  if (!budget.values(keys.length)) return OVER_BUDGET;
  for (const key of keys) {
    if (!budget.chars(key.length)) return OVER_BUDGET;
    const child = copyNode(memberOf(source, key), frame.depth + 1, budget, stack);
    if (child === OVER_BUDGET) return OVER_BUDGET;
    defineMember(target, key, child);
  }
  return undefined;
}

// One value whose unit is paid: a scalar copied (a string's content charged); a container
// replaced by an empty one of its kind, with a frame on `stack` to fill it later.
function copyNode(
  value: JsonValue,
  depth: number,
  budget: WorkBudget,
  stack: CopyFrame[],
): JsonValue | typeof OVER_BUDGET {
  const kind = kindOf(value);
  assert(kind !== undefined, NOT_JSON);
  if (!budget.chars(contentCost(value))) return OVER_BUDGET;
  if (kind !== "array" && kind !== "object") return value;
  const target: JsonContainer = kind === "array" ? [] : {};
  stack.push({ source: value as JsonContainer, target, depth });
  return target;
}

/**
 * Whether `a` and `b` are equal as RFC 6902 §4.6 `test` defines it: the same kind, numbers
 * of equal value (so 0 equals -0), strings of the same code units (no normalization),
 * arrays of equal members in order, objects of the same member names with equal values in
 * any order. Stops at the first difference; charges `a`'s nodes as it reaches them.
 */
export function jsonEqual(
  a: JsonValue,
  b: JsonValue,
  budget: WorkBudget,
): boolean | typeof OVER_BUDGET {
  if (!budget.values(1)) return OVER_BUDGET;
  const stack: [JsonValue, JsonValue][] = [[a, b]];
  for (let pair = stack.pop(); pair !== undefined; pair = stack.pop()) {
    const same = compareNode(pair[0], pair[1], budget, stack);
    if (same !== true) return same;
  }
  return true;
}

// Whether two values are equal as far as this node goes: scalars in full, containers by
// kind and size, with their members pushed on `stack` to compare next.
function compareNode(
  left: JsonValue,
  right: JsonValue,
  budget: WorkBudget,
  stack: [JsonValue, JsonValue][],
): boolean | typeof OVER_BUDGET {
  const kind = kindOf(left);
  assert(kind !== undefined && kindOf(right) !== undefined, NOT_JSON);
  if (!budget.chars(contentCost(left))) return OVER_BUDGET;
  if (kind !== kindOf(right)) return false;
  if (kind === "array") {
    return pushArrayPairs(left as JsonValue[], right as JsonValue[], budget, stack);
  }
  if (kind === "object") {
    return pushObjectPairs(left as JsonContainer, right as JsonContainer, budget, stack);
  }
  return left === right;
}

function pushArrayPairs(
  left: JsonValue[],
  right: JsonValue[],
  budget: WorkBudget,
  stack: [JsonValue, JsonValue][],
): boolean | typeof OVER_BUDGET {
  if (left.length !== right.length) return false;
  if (!budget.values(left.length)) return OVER_BUDGET;
  for (let index = 0; index < left.length; index++) {
    const l = left.at(index);
    const r = right.at(index);
    assert(l !== undefined && r !== undefined, NOT_JSON);
    stack.push([l, r]);
  }
  return true;
}

function pushObjectPairs(
  left: JsonContainer,
  right: JsonContainer,
  budget: WorkBudget,
  stack: [JsonValue, JsonValue][],
): boolean | typeof OVER_BUDGET {
  const keys = Object.keys(left);
  if (!budget.values(keys.length)) return OVER_BUDGET;
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!budget.chars(key.length)) return OVER_BUDGET;
    if (!Object.hasOwn(right, key)) return false;
    stack.push([memberOf(left, key), memberOf(right, key)]);
  }
  return true;
}

/**
 * The depth of `value`: containers nested, 0 for a scalar. Charges one value per value,
 * each before it is read.
 */
export function measureDepth(value: JsonValue, budget: WorkBudget): number | typeof OVER_BUDGET {
  if (!budget.values(1)) return OVER_BUDGET;
  const stack: [JsonValue, number][] = [[value, 0]];
  let depth = 0;
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [node, above] = entry;
    const kind = kindOf(node);
    assert(kind !== undefined, NOT_JSON);
    if (kind !== "array" && kind !== "object") continue;
    depth = Math.max(depth, above + 1);
    const scheduled = scheduleMembers(node as JsonContainer, above + 1, budget, stack);
    if (!scheduled) return OVER_BUDGET;
  }
  return depth;
}

// Push every member of `container` at `depth`, once they are paid for.
function scheduleMembers(
  container: JsonContainer,
  depth: number,
  budget: WorkBudget,
  stack: [JsonValue, number][],
): boolean {
  if (Array.isArray(container)) {
    if (!budget.values(container.length)) return false;
    for (const member of container) stack.push([member, depth]);
    return true;
  }
  const keys = Object.keys(container);
  if (!budget.values(keys.length)) return false;
  for (const key of keys) stack.push([memberOf(container, key), depth]);
  return true;
}
