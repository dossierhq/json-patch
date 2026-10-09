import { expect, test } from "vitest";

// The library checks its limits when its modules load (limits.ts). A module that throws
// while loading fails every test file importing it before any test runs — which a test
// runner can report as "no test failed" (Stryker's vitest runner does, and counts the
// mutant that broke the load as survived). Importing it inside a test turns a broken load
// into a failed test.
test("the library loads, with the documented default limits", async () => {
  const library = await import("./index.js");
  expect(library.DEFAULT_LIMITS).toEqual({
    maxOperations: 10_000,
    maxPointerLength: 4096,
    maxDepth: 256,
    maxPatchCost: 4 * 1024 * 1024,
    maxApplyWork: 16 * 1024 * 1024,
    maxApplyValues: 256 * 1024,
  });
  expect(library.HARD_LIMITS).toEqual({
    maxOperations: 100_000,
    maxPointerLength: 64 * 1024,
    maxDepth: 1024,
    maxPatchCost: 256 * 1024 * 1024,
    maxApplyWork: 1024 * 1024 * 1024,
    maxApplyValues: 64 * 1024 * 1024,
  });
  expect(Object.isFrozen(library.DEFAULT_LIMITS) && Object.isFrozen(library.HARD_LIMITS)).toBe(
    true,
  );
});
