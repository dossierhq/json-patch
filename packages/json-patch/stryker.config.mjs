import { declareValuePlugin, PluginKind } from "@stryker-mutator/api/plugin";

// Mutation testing for the library (`pnpm mutate`): Stryker changes the code under src/
// one small mutation at a time (a flipped comparison, a removed branch, an emptied string)
// and runs the tests that cover it. A mutant no test notices ("survived") is behavior the
// tests do not pin. Advisory, never in the gate: see the README for how to read a run.

// An assertion is a check, not behavior: weakening one (its condition to `true`, its
// message to "") changes nothing a passing test can see, so its mutants are equivalent
// by construction and would only bury the ones that matter. Skipped: every statement that
// is a call to `assert` (src/assert.ts) or to `checkLimit`, limits.ts's load-time check.
const ASSERTIONS = new Set(["assert", "checkLimit"]);

/**
 * The parts of Babel's AST this reads (Babel's own types are not a dependency here).
 * @typedef {{ type: string, name?: string }} Callee
 * @typedef {{ type: string, callee?: Callee }} Expression
 * @typedef {{ type: string, expression?: Expression }} Statement
 */

/** @param {Expression | undefined} expression */
function isAssertionCall(expression) {
  return expression?.type === "CallExpression" && isAssertionName(expression.callee);
}

/** @param {Callee | undefined} callee */
function isAssertionName(callee) {
  return callee?.type === "Identifier" && ASSERTIONS.has(callee.name ?? "");
}

export const strykerPlugins = [
  declareValuePlugin(PluginKind.Ignore, "assertions", {
    /** @param {{ node: Statement }} path */
    shouldIgnore({ node }) {
      const call = node.type === "ExpressionStatement" ? node.expression : undefined;
      return isAssertionCall(call) ? "An assertion: its mutants are equivalent." : undefined;
    },
  }),
];

// vitest-runner 10.0.0 is patched (pnpm-workspace.yaml `patchedDependencies`, patches/):
// it joins a suite chain and its test name with a space, where Vitest 5 matches
// `testNamePattern` against them joined with " > ", so unpatched no nested test runs against
// its mutant and every one of them survives (stryker-mutator/stryker-js#6210). Drop the
// patch with the vitest-runner release that fixes it; pnpm refuses to install until then
// anyway, since the patch names this exact version.
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner", import.meta.url],
  ignorers: ["assertions"],
  vitest: { configFile: "vitest.stryker.config.ts" },
  coverageAnalysis: "perTest",
  // Every mutant killed or justified where it lives (an assertion, or a `Stryker disable`
  // comment saying why it is equivalent): a new survivor fails the run, and is either a
  // test to write or a reason to write down.
  thresholds: { high: 100, low: 100, break: 100 },
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/test/**", "!src/index.ts"],
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // Stryker rewrites the tsconfig it is pointed at through TypeScript's JS API, which the
  // repo's TypeScript 7 (the native compiler) does not have. The rewrite only relocates
  // relative `extends` and project references into its sandbox, and tsconfig.json has
  // neither (it extends a package), so it is pointed at no file and skipped.
  tsconfigFile: "no-tsconfig-to-rewrite.json",
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};
