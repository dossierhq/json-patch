import { assert } from "./assert.js";
import { kindOf } from "./json-value.js";

/**
 * Every bound this library holds its inputs and its own work to. Each is an integer of at
 * least 1; a caller may tighten a default but never raise one past its hard limit.
 *
 * COST is the unit the size limits count in, and it tracks a value's serialized length:
 * one unit per JSON value (a scalar, an array, an object) plus one per UTF-16 code unit of
 * every string and every member name. Counting characters, not just nodes, is what bounds
 * an amplification: `copy` shares no string, but it serializes one, so a patch that copies
 * a long string a thousand times is charged for a thousand strings.
 */
export interface JsonPatchLimits {
  /** Operations in one patch. */
  readonly maxOperations: number;
  /** UTF-16 code units in one pointer (a `path` or a `from`). */
  readonly maxPointerLength: number;
  /**
   * Containers nested inside one another: in a patch value, in the tokens of a pointer,
   * and in any value the patch places — the tokens of its path plus the value's own
   * nesting. A document the patch did not deepen is not measured.
   */
  readonly maxDepth: number;
  /** Cost of the whole patch document, operations and their members included. */
  readonly maxPatchCost: number;
  /**
   * Work one apply may do, in cost units: every pointer step, every value copied into the
   * result, every value a `test` compares, every member a copy-on-write container shifts.
   * The result's cost is at most the document's cost plus this, so it also bounds how much
   * a patch can grow a document.
   */
  readonly maxApplyWork: number;
  /**
   * Values one apply may reach: every value it copies, compares or measures, and every
   * member a copy-on-write container copies or an array insert or remove shifts. Cost
   * counts characters, which a copy shares for free; each value is an allocation. This is
   * what bounds an apply's time and memory when the values are small.
   */
  readonly maxApplyValues: number;
}

const MIB = 1024 * 1024;

/** The largest value a caller may configure for each limit. */
export const HARD_LIMITS: JsonPatchLimits = Object.freeze({
  maxOperations: 100_000,
  maxPointerLength: 64 * 1024,
  maxDepth: 1024,
  maxPatchCost: 256 * MIB,
  maxApplyWork: 1024 * MIB,
  maxApplyValues: 64 * MIB,
});

/**
 * The limits a caller gets without asking. Sized for an interactive document service
 * taking patches from people it does not trust: a patch is an edit someone made, not a
 * bulk import, and the worst one is refused in about 150 ms and 50 MB (the README's
 * "Denial of service" has the measurements).
 */
export const DEFAULT_LIMITS: JsonPatchLimits = Object.freeze({
  maxOperations: 10_000,
  maxPointerLength: 4096,
  maxDepth: 256,
  maxPatchCost: 4 * MIB,
  maxApplyWork: 16 * MIB,
  maxApplyValues: 256 * 1024,
});

const LIMIT_NAMES: ReadonlySet<string> = new Set([
  "maxOperations",
  "maxPointerLength",
  "maxDepth",
  "maxPatchCost",
  "maxApplyWork",
  "maxApplyValues",
]);

// The relations the code relies on, checked once when the module loads. Costs are summed
// in doubles, and a sum may pass its limit by one charge before it is refused, so twice a
// hard limit must still be a safe integer.
checkLimit(HARD_LIMITS.maxOperations, DEFAULT_LIMITS.maxOperations);
checkLimit(HARD_LIMITS.maxPointerLength, DEFAULT_LIMITS.maxPointerLength);
checkLimit(HARD_LIMITS.maxDepth, DEFAULT_LIMITS.maxDepth);
checkLimit(HARD_LIMITS.maxPatchCost, DEFAULT_LIMITS.maxPatchCost);
checkLimit(HARD_LIMITS.maxApplyWork, DEFAULT_LIMITS.maxApplyWork);
checkLimit(HARD_LIMITS.maxApplyValues, DEFAULT_LIMITS.maxApplyValues);

// Stryker disable next-line BlockStatement: nothing but assertions, which pass on the shipped limits.
function checkLimit(hard: number, fallback: number): void {
  assert(Number.isSafeInteger(2 * hard), "a hard limit keeps totals safe integers");
  assert(Number.isSafeInteger(fallback), "a default is an integer");
  assert(fallback >= 1 && fallback <= hard, "a default lies within its hard limit");
}

/**
 * The defaults with `overrides` applied. A caller that passes a limit outside
 * `[1, HARD_LIMITS]`, a non-integer, or a name that is not a limit has a bug, not a bad
 * input, so that throws a `RangeError` instead of coming back as a result. So does
 * anything but a plain object, which throws a `TypeError`: above all an `ApplyBudget` made
 * by another copy of this library, which this copy cannot draw on and must not mistake
 * for an empty set of overrides — the apply would run under the defaults, not the budget.
 */
export function resolveLimits(overrides: Partial<JsonPatchLimits> | undefined): JsonPatchLimits {
  if (overrides === undefined) return DEFAULT_LIMITS;
  if (kindOf(overrides) !== "object") {
    throw new TypeError(
      "JSON Patch limits must be a plain object, or an ApplyBudget made by this copy of the library",
    );
  }
  for (const name of Object.keys(overrides)) {
    if (!LIMIT_NAMES.has(name)) throw new RangeError(`Unknown JSON Patch limit: ${name}`);
  }
  return {
    maxOperations: pick(
      overrides.maxOperations,
      DEFAULT_LIMITS.maxOperations,
      HARD_LIMITS.maxOperations,
      "maxOperations",
    ),
    maxPointerLength: pick(
      overrides.maxPointerLength,
      DEFAULT_LIMITS.maxPointerLength,
      HARD_LIMITS.maxPointerLength,
      "maxPointerLength",
    ),
    maxDepth: pick(overrides.maxDepth, DEFAULT_LIMITS.maxDepth, HARD_LIMITS.maxDepth, "maxDepth"),
    maxPatchCost: pick(
      overrides.maxPatchCost,
      DEFAULT_LIMITS.maxPatchCost,
      HARD_LIMITS.maxPatchCost,
      "maxPatchCost",
    ),
    maxApplyWork: pick(
      overrides.maxApplyWork,
      DEFAULT_LIMITS.maxApplyWork,
      HARD_LIMITS.maxApplyWork,
      "maxApplyWork",
    ),
    maxApplyValues: pick(
      overrides.maxApplyValues,
      DEFAULT_LIMITS.maxApplyValues,
      HARD_LIMITS.maxApplyValues,
      "maxApplyValues",
    ),
  };
}

function pick(value: number | undefined, fallback: number, hard: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > hard) {
    throw new RangeError(`JSON Patch limit ${name} must be an integer in [1, ${hard}]`);
  }
  return value;
}

/**
 * A countdown of cost units. `charge` answers false, and charges nothing, once a charge
 * would take it below zero; a caller that sees false stops and reports the limit.
 */
export class Budget {
  #remaining: number;

  constructor(limit: number) {
    assert(Number.isSafeInteger(limit) && limit >= 0, "a budget is a non-negative integer");
    this.#remaining = limit;
  }

  /** Whether `units` would fit, charging nothing. */
  fits(units: number): boolean {
    assert(Number.isSafeInteger(units) && units >= 0, "a charge is a non-negative integer");
    return units <= this.#remaining;
  }

  charge(units: number): boolean {
    if (!this.fits(units)) return false;
    this.#remaining -= units;
    return true;
  }
}

/**
 * The two budgets an apply draws on. A value costs one unit of each: `values` charges
 * that. A string's characters, or a member name's, cost work only: `chars` charges that.
 * A charge that does not fit charges nothing and records which limit it met, so the
 * refusal can name it.
 */
export class WorkBudget {
  readonly #work: Budget;
  readonly #values: Budget;
  #exhausted: "maxApplyWork" | "maxApplyValues" | undefined;

  constructor(limits: JsonPatchLimits) {
    this.#work = new Budget(limits.maxApplyWork);
    this.#values = new Budget(limits.maxApplyValues);
  }

  /** The limit a charge met, once one has. */
  get exhausted(): "maxApplyWork" | "maxApplyValues" | undefined {
    return this.#exhausted;
  }

  values(count: number): boolean {
    if (!this.#work.fits(count)) return this.#exhaust("maxApplyWork");
    if (!this.#values.charge(count)) return this.#exhaust("maxApplyValues");
    const charged = this.#work.charge(count);
    assert(charged, "a charge that fits is charged");
    return true;
  }

  chars(count: number): boolean {
    return this.#work.charge(count) || this.#exhaust("maxApplyWork");
  }

  #exhaust(limit: "maxApplyWork" | "maxApplyValues"): false {
    this.#exhausted = limit;
    return false;
  }
}
