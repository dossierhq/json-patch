import { assert } from "./assert.js";
import { fail, ok, quote, type JsonPatchErrorCode, type JsonPatchResult } from "./errors.js";
import {
  defineMember,
  kindOf,
  type JsonContainer,
  type JsonObject,
  type JsonValue,
} from "./json-value.js";
import { resolveLimits, WorkBudget, type JsonPatchLimits } from "./limits.js";
import { operationsOf, type ParsedOperation, type ParsedPatch } from "./parse.js";
import { arrayIndex, isSameLocation, type PointerTokens } from "./pointer.js";
import { copyValue, jsonEqual, measureDepth, OVER_BUDGET } from "./walk.js";

/**
 * Apply `patch` to `document` and return the result, or the first operation that failed
 * and why. RFC 6902 semantics: operations in order, each on the result of the ones before,
 * and all or nothing.
 *
 * `document` is never modified. The result shares with it every container the patch did
 * not change or pass through (copy-on-write along each path), so treat both as immutable,
 * or copy the one you will mutate. The result shares no container with the patch, and
 * holds no container twice unless the document did: every value the patch places is a
 * fresh copy. It is safe to mutate after a deep copy of the document, or of the result.
 *
 * `document` must be JSON — a precondition, not something checked in full: the parts the
 * patch touches are asserted, and a violation is a `JsonPatchInvariantError`. A bad patch
 * cannot reach one; a document that is not JSON can.
 *
 * `limits` are this apply's own, or an {@link ApplyBudget} it shares with other applies.
 */
export function applyPatch(
  document: JsonValue,
  patch: ParsedPatch,
  limits?: Partial<JsonPatchLimits> | ApplyBudget,
): JsonPatchResult<JsonValue> {
  const budget = limits instanceof ApplyBudget ? limits : new ApplyBudget(limits);
  const internals = BUDGETS.get(budget);
  assert(internals !== undefined, "every ApplyBudget is registered when it is made");
  const operations = operationsOf(patch);
  const state = new PatchState(document, internals.work, internals.maxDepth);
  for (let index = 0; index < operations.length; index++) {
    const operation = operations.at(index);
    assert(operation !== undefined, "an operation index is in range");
    const refusal = state.apply(operation);
    if (refusal !== undefined) return fail(refusal.code, index, refusal.detail);
  }
  return ok(state.root);
}

/**
 * The work budget of one or more applies. `applyPatch` given limits makes one for itself;
 * given a budget, it draws on that one, so applies that share it are bounded together —
 * as one apply of all their operations would be. That is the budget to use when a caller
 * applies an untrusted patch a piece at a time (an operation per apply, say): each apply
 * alone is within the limits, however many there are, but together they are not.
 *
 * What an apply spends stays spent, whether it succeeds or fails: the work was done. Only
 * `maxApplyWork` and `maxApplyValues` are drawn down; `maxDepth` holds for each apply.
 * Opaque, and made only by its constructor, so it cannot be forged or refilled. It works
 * only with the copy of this library that made it: another copy throws a `TypeError`
 * rather than apply under its defaults.
 */
export class ApplyBudget {
  constructor(limits?: Partial<JsonPatchLimits>) {
    const resolved = resolveLimits(limits);
    BUDGETS.set(this, { work: new WorkBudget(resolved), maxDepth: resolved.maxDepth });
  }
}

// A budget's workings, kept out of reach of its holder.
const BUDGETS = new WeakMap<ApplyBudget, { work: WorkBudget; maxDepth: number }>();

// Why an operation failed. A class, not a shape: a function that returns a JSON value or
// a refusal must tell them apart by more than a member name, since a JSON object can have
// any member — and no JSON value is an instance of a class.
class Refusal {
  readonly code: JsonPatchErrorCode;
  readonly detail: string;

  constructor(code: JsonPatchErrorCode, detail: string) {
    this.code = code;
    this.detail = detail;
  }
}

const OVER_WORK = new Refusal("LIMIT_EXCEEDED", "the apply exceeds maxApplyWork");
const OVER_VALUES = new Refusal("LIMIT_EXCEEDED", "the apply exceeds maxApplyValues");
const TOO_DEEP = new Refusal(
  "LIMIT_EXCEEDED",
  "the value would be nested deeper than maxDepth at its path",
);

function isRefusal(value: unknown): value is Refusal {
  return value instanceof Refusal;
}

class PatchState {
  root: JsonValue;
  // The containers this apply made (copy-on-write copies of the document's) and so may
  // change in place: each is reachable once, from `root`, and from nowhere the caller
  // holds. Every other container belongs to the document and is copied before a change.
  readonly #owned = new Set<JsonContainer>();
  readonly #budget: WorkBudget;
  readonly #maxDepth: number;

  constructor(document: JsonValue, budget: WorkBudget, maxDepth: number) {
    this.root = document;
    this.#budget = budget;
    this.#maxDepth = maxDepth;
  }

  apply(operation: ParsedOperation): Refusal | undefined {
    // The pointers are paid for up front, by their length: that covers every step along
    // them, and every member name an operation adds (a name is never longer than the
    // pointer it came from), so a result's cost grows by no more than the work charged.
    // The operation itself is one value's worth, so maxApplyValues bounds operations too.
    const fromLength = "from" in operation ? operation.fromText.length : 0;
    if (!this.#budget.values(1)) return this.#over();
    if (!this.#budget.chars(operation.pathText.length + fromLength)) return this.#over();
    if (operation.op === "remove") {
      const removed = this.#remove(operation.path, operation.pathText);
      return isRefusal(removed) ? removed : undefined;
    }
    if ("from" in operation) {
      const { from, fromText, path, pathText } = operation;
      return operation.op === "move"
        ? this.#move(from, fromText, path, pathText)
        : this.#copy(from, fromText, path, pathText);
    }
    if (operation.op === "test")
      return this.#test(operation.path, operation.pathText, operation.value);
    return this.#place(operation.op, operation.path, operation.pathText, operation.value);
  }

  // An add or a replace of a copy of the patch's value: the result never holds the
  // patch's own (frozen) containers.
  #place(
    op: "add" | "replace",
    path: PointerTokens,
    pathText: string,
    value: JsonValue,
  ): Refusal | undefined {
    const copied = copyValue(value, this.#budget);
    if (copied === OVER_BUDGET) return this.#over();
    // parsePatch held the value to its maxDepth; the caller may apply under a tighter one.
    if (path.length + copied.depth > this.#maxDepth) return TOO_DEEP;
    return op === "add"
      ? this.#add(path, pathText, copied.value)
      : this.#replace(path, pathText, copied.value);
  }

  #add(path: PointerTokens, pathText: string, value: JsonValue): Refusal | undefined {
    if (path.length === 0) {
      this.root = value;
      return undefined;
    }
    const parent = this.#parentForWrite(path, pathText);
    if (isRefusal(parent)) return parent;
    const key = lastToken(path);
    if (Array.isArray(parent)) return this.#insert(parent, key, pathText, value);
    defineMember(parent, key, value);
    assert(
      Object.getOwnPropertyDescriptor(parent, key)?.value === value,
      "an add places its value",
    );
    return undefined;
  }

  // An add into an array: at an index up to its length, or at its end for "-".
  #insert(
    parent: JsonValue[],
    key: string,
    pathText: string,
    value: JsonValue,
  ): Refusal | undefined {
    const index = key === "-" ? parent.length : arrayIndex(key);
    if (index < 0 || index > parent.length) return notFound(pathText);
    // Inserting shifts every member after the index.
    if (!this.#budget.values(parent.length - index)) return this.#over();
    const length = parent.length;
    parent.splice(index, 0, value);
    assert(parent.length === length + 1 && parent.at(index) === value, "an add inserts its value");
    return undefined;
  }

  // The value removed, or why not.
  #remove(path: PointerTokens, pathText: string): JsonValue | Refusal {
    assert(path.length > 0, "parsePatch refuses a remove of the root");
    const parent = this.#parentForWrite(path, pathText);
    if (isRefusal(parent)) return parent;
    const key = lastToken(path);
    const removed = childOf(parent, key);
    if (removed === undefined) return notFound(pathText);
    if (Array.isArray(parent)) {
      const index = arrayIndex(key);
      // Removing shifts every member after the index (the removed one is not shifted).
      if (!this.#budget.values(parent.length - index - 1)) return this.#over();
      const length = parent.length;
      const [spliced] = parent.splice(index, 1);
      assert(spliced === removed && parent.length === length - 1, "a remove takes out its value");
    } else {
      Reflect.deleteProperty(parent, key);
      assert(!Object.hasOwn(parent, key), "a remove deletes its member");
    }
    return removed;
  }

  #replace(path: PointerTokens, pathText: string, value: JsonValue): Refusal | undefined {
    if (path.length === 0) {
      this.root = value;
      return undefined;
    }
    const parent = this.#parentForWrite(path, pathText);
    if (isRefusal(parent)) return parent;
    const key = lastToken(path);
    if (childOf(parent, key) === undefined) return notFound(pathText);
    setChild(parent, key, value);
    assert(childOf(parent, key) === value, "a replace places its value");
    return undefined;
  }

  #test(path: PointerTokens, pathText: string, expected: JsonValue): Refusal | undefined {
    const actual = resolve(this.root, path);
    // No value is a value that differs: the test's precondition does not hold.
    const equal = actual === undefined ? false : jsonEqual(actual, expected, this.#budget);
    if (equal === OVER_BUDGET) return this.#over();
    return equal ? undefined : new Refusal("TEST_FAILED", `test of ${quote(pathText)} failed`);
  }

  // RFC 6902 §4.4: a remove from `from`, then an add of the removed value at `path`. The
  // value moves as it is — not copied, so a move costs its pointers, not its size.
  #move(
    from: PointerTokens,
    fromText: string,
    path: PointerTokens,
    pathText: string,
  ): Refusal | undefined {
    const value = resolve(this.root, from);
    if (value === undefined) return fromNotFound(fromText);
    if (isSameLocation(from, path)) return undefined;
    // Moving a value deeper deepens the document by the difference; a value moved up or
    // across cannot exceed a depth it already had.
    if (path.length > from.length) {
      const depth = measureDepth(value, this.#budget);
      if (depth === OVER_BUDGET) return this.#over();
      if (path.length + depth > this.#maxDepth) return TOO_DEEP;
    }
    const removed = this.#remove(from, fromText);
    if (isRefusal(removed)) return removed;
    assert(removed === value, "a move removes the value it resolved");
    return this.#add(path, pathText, value);
  }

  #copy(
    from: PointerTokens,
    fromText: string,
    path: PointerTokens,
    pathText: string,
  ): Refusal | undefined {
    const source = resolve(this.root, from);
    if (source === undefined) return fromNotFound(fromText);
    const copied = copyValue(source, this.#budget);
    if (copied === OVER_BUDGET) return this.#over();
    if (path.length + copied.depth > this.#maxDepth) return TOO_DEEP;
    return this.#add(path, pathText, copied.value);
  }

  // The container `path`'s last token is a member of, made this apply's own — along with
  // every container above it — so it can change in place. Or why there is none.
  #parentForWrite(path: PointerTokens, pathText: string): JsonContainer | Refusal {
    assert(path.length > 0, "the root has no parent");
    const root = this.#own(this.root);
    if (root === undefined) return notFound(pathText);
    if (isRefusal(root)) return root;
    this.root = root;
    let container = root;
    for (let at = 0; at < path.length - 1; at++) {
      const token = path.at(at);
      assert(token !== undefined, "a pointer step is in range");
      const child = childOf(container, token);
      if (child === undefined) return notFound(pathText);
      const owned = this.#own(child);
      if (owned === undefined) return notFound(pathText);
      if (isRefusal(owned)) return owned;
      // Unconditionally: putting back a container this apply already owned is a no-op.
      setChild(container, token, owned);
      container = owned;
    }
    return container;
  }

  // The refusal for the limit the budget met.
  #over(): Refusal {
    const limit = this.#budget.exhausted;
    assert(limit !== undefined, "a walk stops over budget only once a charge failed");
    return limit === "maxApplyWork" ? OVER_WORK : OVER_VALUES;
  }

  // `value` if it is a container this apply owns; a shallow copy it now owns if it is one
  // of the document's; undefined if it is a scalar (nothing to write into); a limit's refusal if
  // the copy is over budget.
  #own(value: JsonValue): JsonContainer | Refusal | undefined {
    const kind = kindOf(value);
    assert(kind !== undefined, "the document is JSON");
    if (kind !== "array" && kind !== "object") return undefined;
    const container = value as JsonContainer;
    if (this.#owned.has(container)) return container;
    const copy = shallowCopy(container, this.#budget);
    if (copy === OVER_BUDGET) return this.#over();
    this.#owned.add(copy);
    return copy;
  }
}

function notFound(pathText: string): Refusal {
  return new Refusal("PATH_NOT_FOUND", `path ${quote(pathText)} does not resolve`);
}

function fromNotFound(fromText: string): Refusal {
  return new Refusal("FROM_NOT_FOUND", `from ${quote(fromText)} does not resolve`);
}

function lastToken(path: PointerTokens): string {
  const token = path.at(-1);
  assert(token !== undefined, "a non-root pointer has a last token");
  return token;
}

// A copy of the container's own members: one level, sharing every member. Charged one
// value per member, which is what the copy costs.
function shallowCopy(
  container: JsonContainer,
  budget: WorkBudget,
): JsonContainer | typeof OVER_BUDGET {
  if (Array.isArray(container)) {
    if (!budget.values(container.length)) return OVER_BUDGET;
    return container.slice();
  }
  if (!budget.values(Object.keys(container).length)) return OVER_BUDGET;
  // Spread defines the copy's members (it never assigns), so "__proto__" stays a member.
  return { ...container };
}

// The value `token` names in `container`, or undefined: an own member of an object, an
// in-range index of an array — never anything inherited.
function childOf(container: JsonContainer, token: string): JsonValue | undefined {
  if (Array.isArray(container)) {
    // `at` answers undefined past the end; only a negative index (no index at all) has to
    // be kept from it, since `at` counts those back from the end.
    const index = arrayIndex(token);
    return index >= 0 ? container.at(index) : undefined;
  }
  const member = Object.getOwnPropertyDescriptor(container, token);
  if (member === undefined) return undefined;
  assert("value" in member, "the document is JSON");
  return member.value as JsonValue;
}

// Overwrite a member `container` already holds.
function setChild(container: JsonContainer, token: string, value: JsonValue): void {
  // Stryker disable next-line ConditionalExpression: defining an index overwrites it as the
  // splice does; the branch keeps array writes on the array API.
  if (Array.isArray(container)) {
    const index = arrayIndex(token);
    assert(index >= 0 && index < container.length, "a set overwrites an existing index");
    container.splice(index, 1, value);
  } else {
    assert(Object.hasOwn(container, token), "a set overwrites an existing member");
    defineMember(container as JsonObject, token, value);
  }
}

// The value `tokens` lead to from `root`, or undefined.
function resolve(root: JsonValue, tokens: PointerTokens): JsonValue | undefined {
  let value = root;
  for (const token of tokens) {
    const kind = kindOf(value);
    assert(kind !== undefined, "the document is JSON");
    if (kind !== "array" && kind !== "object") return undefined;
    const child = childOf(value as JsonContainer, token);
    if (child === undefined) return undefined;
    value = child;
  }
  return value;
}
