// How hard the fast-check properties run, steered from the environment so a hunt
// needs no edit to a test file (see `scripts/hunt-properties.ts` and the
// `test:hunt` script):
//
//   PROPERTY_RUN_MULT  multiplies every property's run count (default 1, which is
//                      what CI and `pnpm test` run)
//   PROPERTY_SEED      replays a reported counterexample: the `seed` fast-check
//   PROPERTY_PATH      printed, and the `path` next to it
//
// Each property keeps its own base count, because a run costs microseconds in one
// file and a server with three clients in another; the multiplier scales them all
// by the same factor. The timeout scales with it: it bounds a stuck run, and a
// healthy hunt is the base run that many times over.
//
// Imports neither vitest nor fast-check: everything under `src/test` ships in
// `dist/` (see the runtime-vitest-free rule), and both are devDependencies.

type PropertyParameters = { numRuns: number; seed?: number; path?: string };

function readMultiplier(): number {
  const raw = process.env.PROPERTY_RUN_MULT;
  if (raw === undefined || raw === "") return 1;
  const mult = Number(raw);
  if (!Number.isFinite(mult) || mult <= 0) {
    throw new Error(`PROPERTY_RUN_MULT must be a positive number, got "${raw}"`);
  }
  return mult;
}

function readSeed(): number | undefined {
  const raw = process.env.PROPERTY_SEED;
  if (raw === undefined || raw === "") return undefined;
  const seed = Number(raw);
  if (!Number.isInteger(seed)) {
    throw new Error(`PROPERTY_SEED must be an integer, got "${raw}"`);
  }
  return seed;
}

/** The `fc.assert` parameters for a property whose everyday run count is `baseRuns`. */
export function propertyParameters(baseRuns: number): PropertyParameters {
  const parameters: PropertyParameters = { numRuns: Math.ceil(baseRuns * readMultiplier()) };
  const seed = readSeed();
  if (seed !== undefined) parameters.seed = seed;
  const path = process.env.PROPERTY_PATH;
  if (path !== undefined && path !== "") parameters.path = path;
  return parameters;
}

/**
 * The test timeout for a property whose everyday timeout is `baseMs`. A multiplier
 * below 1 cuts the runs but never the timeout: the base value is already what bounds
 * a stuck run on a contended runner, and fewer runs do not make that runner faster.
 */
export function propertyTimeoutMs(baseMs: number): number {
  return Math.ceil(baseMs * Math.max(1, readMultiplier()));
}
