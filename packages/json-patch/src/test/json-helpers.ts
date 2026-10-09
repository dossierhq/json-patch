// Walks over a value's containers for the tests: freeze them, count them, measure the value.
// Recursive and unguarded — test inputs are small and known JSON.

/** Freeze `value` and every container inside it; returns `value`. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

/** How many times each container is reachable from `value` (a tree holds each once). */
export function containerCounts(
  value: unknown,
  counts = new Map<object, number>(),
): Map<object, number> {
  if (typeof value === "object" && value !== null) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    for (const member of Object.values(value)) containerCounts(member, counts);
  }
  return counts;
}

/** A value's cost, as JsonPatchLimits defines it. */
export function jsonCost(value: unknown): number {
  if (typeof value === "string") return 1 + value.length;
  if (typeof value !== "object" || value === null) return 1;
  let cost = 1;
  for (const [key, member] of Object.entries(value)) {
    cost += (Array.isArray(value) ? 0 : key.length) + jsonCost(member);
  }
  return cost;
}

/** How many values `value` holds, itself included: what maxApplyValues counts. */
export function jsonValueCount(value: unknown): number {
  if (typeof value !== "object" || value === null) return 1;
  return 1 + Object.values(value).reduce((sum: number, member) => sum + jsonValueCount(member), 0);
}

/** Nesting of containers: 0 for a scalar. */
export function jsonDepth(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  return 1 + Math.max(0, ...Object.values(value).map(jsonDepth));
}
