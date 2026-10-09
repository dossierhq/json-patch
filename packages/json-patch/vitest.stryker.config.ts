import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config.ts";

// The test run Stryker makes for each mutant (stryker.config.mjs). A mutant counts as
// killed only if a test fails on it, so every test must fail the same way every time: the
// properties run from a fixed seed, and at a tenth of their runs, which a mutant the
// deterministic tests miss still meets hundreds of times. No coverage: Stryker measures
// its own, per test.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      env: { PROPERTY_SEED: "20260924", PROPERTY_RUN_MULT: "0.1" },
      coverage: { enabled: false },
    },
  }),
);
