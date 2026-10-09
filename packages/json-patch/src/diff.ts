import { assert } from "./assert.js";
import {
  JsonPatchError,
  ok,
  quote,
  type JsonPatchErrorCode,
  type JsonPatchResult,
} from "./errors.js";
import {
  importValue,
  kindOf,
  type JsonContainer,
  type JsonKind,
  type JsonValue,
} from "./json-value.js";
import { Budget, resolveLimits, WorkBudget, type JsonPatchLimits } from "./limits.js";
import { escapeToken } from "./pointer.js";

/** A JSON Patch operation, as `createPatch` writes one and `parsePatch` reads one. */
export type Operation =
  | { readonly op: "add"; readonly path: string; readonly value: JsonValue }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "replace"; readonly path: string; readonly value: JsonValue }
  | { readonly op: "move"; readonly path: string; readonly from: string }
  | { readonly op: "copy"; readonly path: string; readonly from: string }
  | { readonly op: "test"; readonly path: string; readonly value: JsonValue };

export interface CreatePatchOptions {
  /**
   * Guard every `replace` and `remove` with a `test` of the value it overwrites, so the
   * patch refuses (`TEST_FAILED`) a document that no longer holds what `source` held there.
   * An `add` has nothing to guard. Default false.
   */
  readonly tests?: boolean;
  /**
   * The patch is held to the limits `parsePatch` enforces (`maxOperations`,
   * `maxPointerLength`, `maxDepth`, `maxPatchCost`), so it parses under the same limits; the
   * diff's own work, what it reads and what it copies into the patch, is held to
   * `maxApplyWork` and `maxApplyValues`. Default DEFAULT_LIMITS.
   */
  readonly limits?: Partial<JsonPatchLimits>;
}

const OPTION_NAMES: ReadonlySet<string> = new Set(["tests", "limits"]);

type Refused = { readonly ok: false; readonly error: JsonPatchError };

/**
 * The patch that turns `source` into `target`, or why there is none that fits the limits.
 *
 * The patch has the shape of fast-json-patch's `compare` (3.1), operation for operation, on
 * every input where `compare` is right, so a caller can move from one to the other without
 * a changed patch. That shape keeps every location stable: a `replace` overwrites in place,
 * an array only loses members from its end and only gains them at its end, and no two
 * writes touch overlapping locations. So each operation's path names the same place in
 * `source`, in `target` and in the document between them:
 * - members are compared in reverse key order, depth first; the members `target` adds come
 *   after, in its key order;
 * - a member whose values are containers of one kind is diffed into; any other change is a
 *   `replace` of the member;
 * - numbers compare by value (`-0` equals `0`) and strings by code unit, as `test` does.
 * Where `compare` is wrong, this is not: a changed scalar root is replaced (compare returns
 * no operations), and so is a root whose kind changed.
 *
 * Total: any input comes back as a result, never a throw (a Proxy aside, whose traps are
 * its own). `source` and `target` are read as `parsePatch` reads a value, through property
 * descriptors, so a getter is refused, never run. A value the diff reads that is not JSON,
 * or a value or member name it would write into the patch that is not I-JSON (a lone
 * surrogate), is `INVALID_VALUE`. A container `source` and `target` share is not read at
 * all: it is the same on both sides. A limit is `LIMIT_EXCEEDED`. Errors have no operation
 * index, and their messages name a location, never a value.
 *
 * The patch and every value in it are frozen, and it shares no container with `source` or
 * `target`. A limit or an option name out of range is a caller bug, and throws a RangeError;
 * limits that are not a plain object throw a TypeError.
 */
export function createPatch(
  source: unknown,
  target: unknown,
  options: CreatePatchOptions = {},
): JsonPatchResult<readonly Operation[]> {
  for (const name of Object.keys(options)) {
    if (!OPTION_NAMES.has(name)) throw new RangeError(`Unknown createPatch option: ${name}`);
  }
  if (options.tests !== undefined && typeof options.tests !== "boolean") {
    throw new RangeError("The createPatch option tests must be a boolean");
  }
  const limits = resolveLimits(options.limits);
  const budget = new WorkBudget(limits);
  const writer = new PatchWriter(limits, options.tests === true, budget);
  const refused = diffRoots(source, target, writer, budget);
  return refused ?? ok(writer.finish());
}

function diffRoots(
  source: unknown,
  target: unknown,
  writer: PatchWriter,
  budget: WorkBudget,
): Refused | undefined {
  const sourceKind = kindOf(source);
  if (sourceKind === undefined) return notJson("source", "");
  const targetKind = kindOf(target);
  if (targetKind === undefined) return notJson("target", "");
  if (!budget.values(2)) return overBudget(budget);
  const pair = comparePair(source, sourceKind, target, targetKind, budget);
  if (pair === DESCEND) {
    return new Walk(writer, budget).run(source as JsonContainer, target as JsonContainer);
  }
  if (pair === CHANGED) return writer.changed("", 0, source, target);
  return pair === SAME ? undefined : overBudget(budget);
}

const SAME = 0;
const DESCEND = 1;
const CHANGED = 2;
const OVER_BUDGET: unique symbol = Symbol("over budget");

// What the diff does with two JSON values at one location: nothing, when they are equal
// scalars or one container; diff into them, when they are distinct containers of one kind;
// replace one with the other, otherwise. A string comparison is paid for by its length.
function comparePair(
  before: unknown,
  kind: JsonKind,
  after: unknown,
  afterKind: JsonKind,
  budget: WorkBudget,
): typeof SAME | typeof DESCEND | typeof CHANGED | typeof OVER_BUDGET {
  if (kind !== afterKind) return CHANGED;
  if (kind === "array" || kind === "object") return before === after ? SAME : DESCEND;
  if (kind === "string" && !budget.chars((before as string).length)) return OVER_BUDGET;
  return before === after ? SAME : CHANGED;
}

// A member as the diff reads it: its value; ABSENT when the container has no own,
// enumerable member of that name (what JSON.stringify would not write); NOT_DATA when the
// member is an accessor. Read through the descriptor, so a getter is never run.
const ABSENT: unique symbol = Symbol("absent");
const NOT_DATA: unique symbol = Symbol("not a data member");

// Whether an object has an own, enumerable member of a name, without reading it.
function isOwnEnumerable(container: object, key: string): boolean {
  return Object.prototype.propertyIsEnumerable.call(container, key);
}

function memberOf(container: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined || descriptor.enumerable !== true) return ABSENT;
  return "value" in descriptor ? descriptor.value : NOT_DATA;
}

// Two containers of one kind being diffed, and how far: `cursor` counts down through
// `source`'s members, which are visited last to first, as compare visits them.
interface Frame {
  readonly source: JsonContainer;
  readonly target: JsonContainer;
  readonly pointer: string;
  // The tokens of `pointer`: 0 for the root.
  readonly depth: number;
  // An object's keys, as Object.keys lists them; undefined for an array.
  readonly sourceKeys: readonly string[] | undefined;
  readonly targetKeys: readonly string[] | undefined;
  readonly sourceCount: number;
  readonly targetCount: number;
  cursor: number;
  // Whether a member of `source` is gone from `target`.
  removed: boolean;
}

// The walk over two containers of one kind, with an explicit stack, never recursion: the
// frames on the stack are the containers along one path, the deepest on top. A frame's
// operations are written as its members are visited, and those of the members `target`
// adds once they all have been: that is compare's order.
class Walk {
  readonly #writer: PatchWriter;
  readonly #budget: WorkBudget;
  readonly #stack: Frame[] = [];

  constructor(writer: PatchWriter, budget: WorkBudget) {
    this.#writer = writer;
    this.#budget = budget;
  }

  run(source: JsonContainer, target: JsonContainer): Refused | undefined {
    const opened = this.#open(source, target, "", 0);
    if (opened !== undefined) return opened;
    for (let frame = this.#stack.at(-1); frame !== undefined; frame = this.#stack.at(-1)) {
      let refused: Refused | undefined;
      if (frame.cursor >= 0) refused = this.#visit(frame);
      else {
        this.#stack.pop();
        refused = this.#addMembers(frame);
      }
      if (refused !== undefined) return refused;
    }
    return undefined;
  }

  // Push a frame for two containers of one kind, once their members are paid for: one
  // value each, before any is read. An array's length is known up front; an object's keys
  // are listed first, as walk.ts lists them.
  #open(
    source: JsonContainer,
    target: JsonContainer,
    pointer: string,
    depth: number,
  ): Refused | undefined {
    const isArray = Array.isArray(source);
    assert(isArray === Array.isArray(target), "a frame pairs two containers of one kind");
    const sourceKeys = isArray ? undefined : Object.keys(source);
    const targetKeys = isArray ? undefined : Object.keys(target);
    const sourceCount = sourceKeys?.length ?? (source as JsonValue[]).length;
    const targetCount = targetKeys?.length ?? (target as JsonValue[]).length;
    if (!this.#budget.values(sourceCount + targetCount)) return overBudget(this.#budget);
    this.#stack.push({
      source,
      target,
      pointer,
      depth,
      sourceKeys,
      targetKeys,
      sourceCount,
      targetCount,
      cursor: sourceCount - 1,
      // Stryker disable next-line BooleanLiteral: it only skips the add pass (see #addMembers).
      removed: false,
    });
    return undefined;
  }

  // The member of `frame.source` at its cursor, against `frame.target`'s member of that key.
  #visit(frame: Frame): Refused | undefined {
    const index = frame.cursor;
    assert(index >= 0 && index < frame.sourceCount, "a frame's cursor is in range");
    frame.cursor = index - 1;
    const key = frame.sourceKeys === undefined ? String(index) : frame.sourceKeys.at(index);
    assert(key !== undefined, "a key index is in range");
    if (frame.sourceKeys !== undefined && !this.#budget.chars(key.length)) {
      return overBudget(this.#budget);
    }
    const before = memberOf(frame.source, key);
    const beforeKind = kindOf(before);
    if (beforeKind === undefined) return notJson("source", childPointer(frame, key));
    const after = targetMemberOf(frame, index, key);
    if (after === ABSENT) {
      frame.removed = true;
      return this.#writer.removed(childPointer(frame, key), frame.depth + 1, before);
    }
    const afterKind = kindOf(after);
    if (afterKind === undefined) return notJson("target", childPointer(frame, key));
    const pair = comparePair(before, beforeKind, after, afterKind, this.#budget);
    return this.#follow(pair, frame, key, before, after);
  }

  // What a compared pair of members calls for: a frame to diff into them, a replace, or
  // nothing — or the refusal of a comparison over budget.
  #follow(
    pair: ReturnType<typeof comparePair>,
    frame: Frame,
    key: string,
    before: unknown,
    after: unknown,
  ): Refused | undefined {
    const depth = frame.depth + 1;
    if (pair === DESCEND) {
      const pointer = childPointer(frame, key);
      return this.#open(before as JsonContainer, after as JsonContainer, pointer, depth);
    }
    if (pair === CHANGED) {
      return this.#writer.changed(childPointer(frame, key), depth, before, after);
    }
    return pair === SAME ? undefined : overBudget(this.#budget);
  }

  // The members `frame.target` has and `frame.source` does not, added in `target`'s order:
  // an array's past the source's end, appended; an object's new keys. None unless a member
  // was removed or the counts differ, since otherwise every key of `target` is `source`'s.
  #addMembers(frame: Frame): Refused | undefined {
    assert(frame.cursor === -1, "a frame adds once all its members are visited");
    // Without the shortcut the pass would find nothing to add, 12% slower on a large document.
    // Stryker disable next-line ConditionalExpression: a shortcut, so equivalent by design.
    if (!frame.removed && frame.sourceCount === frame.targetCount) return undefined;
    return frame.targetKeys === undefined
      ? this.#appendMembers(frame)
      : this.#addKeys(frame, frame.targetKeys);
  }

  #appendMembers(frame: Frame): Refused | undefined {
    for (let index = frame.sourceCount; index < frame.targetCount; index++) {
      const added = this.#addMember(frame, String(index));
      if (added !== undefined) return added;
    }
    return undefined;
  }

  #addKeys(frame: Frame, keys: readonly string[]): Refused | undefined {
    for (const key of keys) {
      // A key `source` lists was visited already; a non-enumerable member is no member.
      if (isOwnEnumerable(frame.source, key)) continue;
      if (!this.#budget.chars(key.length)) return overBudget(this.#budget);
      const added = this.#addMember(frame, key);
      if (added !== undefined) return added;
    }
    return undefined;
  }

  #addMember(frame: Frame, key: string): Refused | undefined {
    const pointer = childPointer(frame, key);
    const after = memberOf(frame.target, key);
    if (kindOf(after) === undefined) return notJson("target", pointer);
    return this.#writer.added(pointer, frame.depth + 1, after);
  }
}

// `frame.target`'s member `key`, against the source member at `index`: ABSENT when it is
// gone — past the end of the target array, or a key the target object does not have — and
// NOT_DATA for a hole within the array, which is not JSON.
function targetMemberOf(frame: Frame, index: number, key: string): unknown {
  if (frame.targetKeys !== undefined) return memberOf(frame.target, key);
  if (index >= frame.targetCount) return ABSENT;
  const member = memberOf(frame.target, key);
  return member === ABSENT ? NOT_DATA : member;
}

// The pointer to `frame`'s member `key`. Built only for an operation or an error, never for
// a member that is the same on both sides.
function childPointer(frame: Frame, key: string): string {
  return `${frame.pointer}/${escapeToken(key)}`;
}

// What parsePatch charges an operation before its path's characters and its value: the
// object, the names of its members, the `op` string, and the path string's own unit.
function operationCost(op: Operation["op"], members: readonly string[]): number {
  return 1 + members.reduce((sum, name) => sum + name.length, 0) + (1 + op.length) + 1;
}

const VALUE_MEMBERS = ["op", "path", "value"] as const;
const OPERATION_COST: ReadonlyMap<Operation["op"], number> = new Map([
  ["add", operationCost("add", VALUE_MEMBERS)],
  ["replace", operationCost("replace", VALUE_MEMBERS)],
  ["test", operationCost("test", VALUE_MEMBERS)],
  ["remove", operationCost("remove", ["op", "path"])],
]);

const NO_VALUE: unique symbol = Symbol("no value");

// The patch as it is written, held to the limits parsePatch holds it to, each checked
// before the operation that would break it is written: the operation count, each path's
// length and tokens, and the cost of the whole — charged as parsePatch charges it, so the
// patch parses under a maxPatchCost exactly when it fits here. Copying a value into the
// patch is the diff's work too, so it is charged to `work` as the walk's reads are.
class PatchWriter {
  readonly #operations: Operation[] = [];
  readonly #limits: JsonPatchLimits;
  readonly #tests: boolean;
  readonly #cost: Budget;
  readonly #work: WorkBudget;

  constructor(limits: JsonPatchLimits, tests: boolean, work: WorkBudget) {
    this.#limits = limits;
    this.#tests = tests;
    this.#work = work;
    this.#cost = new Budget(limits.maxPatchCost);
    const chargedArray = this.#cost.charge(1);
    assert(chargedArray, "maxPatchCost is at least 1, the cost of the array");
  }

  /** The value at `pointer` changed from `before` to `after`. */
  changed(pointer: string, depth: number, before: unknown, after: unknown): Refused | undefined {
    const guarded = this.#tests ? this.#write("test", pointer, depth, before, "source") : undefined;
    return guarded ?? this.#write("replace", pointer, depth, after, "target");
  }

  /** The member at `pointer`, `before`, is gone. */
  removed(pointer: string, depth: number, before: unknown): Refused | undefined {
    const guarded = this.#tests ? this.#write("test", pointer, depth, before, "source") : undefined;
    return guarded ?? this.#write("remove", pointer, depth, NO_VALUE, "source");
  }

  /** The member at `pointer`, `after`, is new. */
  added(pointer: string, depth: number, after: unknown): Refused | undefined {
    return this.#write("add", pointer, depth, after, "target");
  }

  finish(): readonly Operation[] {
    assert(this.#operations.length <= this.#limits.maxOperations, "a patch fits maxOperations");
    return Object.freeze(this.#operations);
  }

  #write(
    op: "add" | "replace" | "test" | "remove",
    pointer: string,
    depth: number,
    value: unknown,
    side: "source" | "target",
  ): Refused | undefined {
    const refused = this.#refusePath(pointer, depth, side);
    if (refused !== undefined) return refused;
    const cost = OPERATION_COST.get(op);
    assert(cost !== undefined, "every operation the diff writes has a cost");
    if (!this.#cost.charge(cost + pointer.length)) return overCost();
    assert((op === "remove") === (value === NO_VALUE), "a remove, and only a remove, has no value");
    if (op === "remove") {
      this.#operations.push(Object.freeze({ op, path: pointer }));
      return undefined;
    }
    // A placed value nests inside its path's containers; a tested one is only compared.
    const maxDepth = op === "test" ? this.#limits.maxDepth : this.#limits.maxDepth - depth;
    const imported = importValue(value, this.#cost, maxDepth, this.#work);
    if (imported.ok) {
      this.#operations.push(Object.freeze({ op, path: pointer, value: imported.value }));
      return undefined;
    }
    // A failed work charge ends the diff, so a recorded one is this copy's.
    return this.#work.exhausted === undefined
      ? refuseValue(imported.code, side, pointer)
      : overBudget(this.#work);
  }

  // Why one more operation at `pointer` cannot be written, if it cannot: the operation
  // count, the path's length and tokens, or a member name on it that is not I-JSON.
  #refusePath(pointer: string, depth: number, side: "source" | "target"): Refused | undefined {
    const limits = this.#limits;
    if (this.#operations.length >= limits.maxOperations) {
      return refuse("LIMIT_EXCEEDED", "the patch has more than maxOperations operations");
    }
    if (pointer.length > limits.maxPointerLength) {
      return refuse("LIMIT_EXCEEDED", `path ${quote(pointer)} is longer than maxPointerLength`);
    }
    if (depth > limits.maxDepth) {
      return refuse("LIMIT_EXCEEDED", `path ${quote(pointer)} is deeper than maxDepth`);
    }
    // A member name on the path with a lone surrogate: no pointer parsePatch reads.
    return pointer.isWellFormed() ? undefined : notJson(side, pointer);
  }
}

function refuseValue(
  code: "INVALID_VALUE" | "LIMIT_EXCEEDED",
  side: "source" | "target",
  pointer: string,
): Refused {
  return code === "INVALID_VALUE"
    ? notJson(side, pointer)
    : refuse(
        "LIMIT_EXCEEDED",
        `the value at ${quote(pointer)} exceeds maxPatchCost or, at its path, maxDepth`,
      );
}

function refuse(code: JsonPatchErrorCode, detail: string): Refused {
  return { ok: false, error: new JsonPatchError(code, null, detail) };
}

function notJson(side: "source" | "target", pointer: string): Refused {
  return refuse("INVALID_VALUE", `the ${side} is not I-JSON at ${quote(pointer)}`);
}

function overCost(): Refused {
  return refuse("LIMIT_EXCEEDED", "the patch costs more than maxPatchCost");
}

function overBudget(budget: WorkBudget): Refused {
  const limit = budget.exhausted;
  assert(limit !== undefined, "a walk stops over budget only once a charge failed");
  return refuse("LIMIT_EXCEEDED", `the diff exceeds ${limit}`);
}
