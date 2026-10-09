import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Stryker's sandbox is a copy of the package, tests included.
    exclude: ["dist/**", "node_modules/**", ".stryker-tmp/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test/**"],
      // `json` writes coverage/coverage-final.json, which the root
      // `coverage:merge` folds into the map fallow reads.
      reporter: ["text", "html", "json"],
      // Every statement and every branch: this is the code that runs on patches from
      // anyone, and a branch no test takes is one no test has seen refuse or accept.
      // An unreachable branch is an assertion, not an untested `if`.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
