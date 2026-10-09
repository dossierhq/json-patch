#!/usr/bin/env node
import { spawn } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * Hunt with a package's fast-check properties: run them
 * many times harder than the gate does, without editing a test file.
 *
 *   pnpm --filter @dossierhq/json-patch test:hunt                      # every file with a property, 10× runs, 8 times over
 *   pnpm --filter @dossierhq/json-patch test:hunt pointer                # the files whose path contains the word
 *   pnpm --filter @dossierhq/json-patch test:hunt --mult 50 --repeat 16 diff
 *
 * The gate runs each property once at its base count, which catches a regression
 * of a known class. The classes a hunt is after turn up once in tens of thousands
 * of runs, so a single pass at the base count is not evidence.
 *
 * Two knobs, because they buy different things:
 *
 *   --mult N    multiplies every property's run count (PROPERTY_RUN_MULT, read by
 *               src/test/property-runs.ts, which scales the test timeout with it)
 *   --repeat N  runs each file N times, every time with a fresh seed
 *
 * A repeat is a process of its own, so repeats spread over the cores where one
 * long `fc.assert` would hold a single one — and a failing repeat does not stop
 * the others, so a hunt can come back with several counterexamples instead of the
 * first. Each failure is printed whole, followed by the command that replays it.
 *
 * No coverage, and not through turbo: a hunt must not overwrite the coverage map
 * fallow reads, and its result must never be a cache hit.
 */

// The package whose `test:hunt` script ran this: pnpm runs a script in its package's
// directory.
const PACKAGE_DIR = process.cwd();
const PACKAGE_NAME = (
  JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf8")) as { name: string }
).name;
// A property is found by what it calls, not by its file's name: some live beside
// the unit tests of the module they check (src/authz/authz-read.test.ts). The
// property-runs-from-helper lint rule is what makes every `fc.assert` found here
// one that reads the multiplier.
const TEST_GLOB = "src/**/*.test.ts";
const holdsProperty = (file: string) =>
  readFileSync(resolve(PACKAGE_DIR, file), "utf8").includes("fc.assert(");

const { values, positionals } = parseArgs({
  options: {
    mult: { type: "string", default: "10" },
    repeat: { type: "string", default: "8" },
    jobs: { type: "string", default: String(availableParallelism()) },
  },
  allowPositionals: true,
});

function positiveInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`--${name} must be a positive integer, got "${raw}"`);
    process.exit(2);
  }
  return value;
}

const mult = positiveInteger("mult", values.mult);
const repeat = positiveInteger("repeat", values.repeat);
const jobs = positiveInteger("jobs", values.jobs);

const files = globSync(TEST_GLOB, { cwd: PACKAGE_DIR })
  .filter(holdsProperty)
  .filter((file) => positionals.length === 0 || positionals.some((word) => file.includes(word)))
  .sort();
if (files.length === 0) {
  console.error(`No test file with a property matches ${positionals.join(", ")}`);
  process.exit(2);
}

type Unit = { file: string; round: number };
type Outcome = { unit: Unit; passed: boolean; output: string; seconds: number };

function runUnit(unit: Unit): Promise<Outcome> {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn("pnpm", ["exec", "vitest", "--run", unit.file], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, PROPERTY_RUN_MULT: String(mult), CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("close", (code) => {
      done({ unit, passed: code === 0, output, seconds: (performance.now() - started) / 1000 });
    });
  });
}

// fast-check reports a counterexample as `{ seed: 123, path: "45:1:0", endOnFailure: true }`.
// The path names the failing run, so a replay needs no multiplier to reach it.
// That line is fast-check's error text, not an API: should a version reword it, the
// match comes back empty, which `replayLines` says out loud instead of printing nothing.
function replayCommands(outcome: Outcome): string[] {
  const commands = new Set<string>();
  for (const [, seed, path] of outcome.output.matchAll(/seed: (-?\d+), path: "([^"]+)"/g)) {
    commands.add(
      `PROPERTY_SEED=${seed} PROPERTY_PATH="${path}" ` +
        `pnpm --filter ${PACKAGE_NAME} exec vitest --run ${outcome.unit.file}`,
    );
  }
  return [...commands];
}

// Failures that are the run's, not a property's: still failures, but a hunt that
// oversubscribes the machine produces them, so name them instead of letting them
// read as a counterexample the report failed to parse (issue #1889).
const HARNESS_FAILURES: { pattern: RegExp; says: string }[] = [
  {
    pattern: /Hook timed out in \d+ms/,
    says: "a hook timed out, not a property: the machine is oversubscribed, or a hook's work grows with the runs",
  },
  {
    pattern: /Worker exited unexpectedly/,
    says: "the vitest worker died, not a property: most likely out of memory",
  },
];

function replayLines(outcome: Outcome): string[] {
  const commands = replayCommands(outcome);
  if (commands.length > 0) return commands.map((command) => `replay: ${command}`);
  const harness = HARNESS_FAILURES.find(({ pattern }) => pattern.test(outcome.output));
  if (harness) return [`${harness.says} (fewer --jobs rules the load out)`];
  return [
    "no seed/path found in the output above: not a property failure, or fast-check's report changed",
  ];
}

function report(outcome: Outcome): void {
  const { unit, passed, seconds } = outcome;
  const label = `${unit.file} #${unit.round} (${seconds.toFixed(1)}s)`;
  if (passed) {
    console.log(`✓ ${label}`);
    return;
  }
  console.log(`✗ ${label}\n${outcome.output}`);
  for (const line of replayLines(outcome)) console.log(`  ${line}`);
}

// Rounds outermost, so an interrupted hunt has covered every file about equally.
const queue: Unit[] = [];
for (let round = 1; round <= repeat; round++) {
  for (const file of files) queue.push({ file, round });
}

console.log(
  `Hunting ${files.length} file(s) × ${repeat} repeat(s) at ${mult}× runs, ${Math.min(jobs, queue.length)} at a time`,
);

const failures: Outcome[] = [];
async function worker(): Promise<void> {
  for (let unit = queue.shift(); unit; unit = queue.shift()) {
    const outcome = await runUnit(unit);
    if (!outcome.passed) failures.push(outcome);
    report(outcome);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));

if (failures.length > 0) {
  console.log(`\n${failures.length} failing run(s):`);
  for (const failure of failures) {
    console.log(`  ${failure.unit.file} #${failure.unit.round}`);
    for (const line of replayLines(failure)) console.log(`    ${line}`);
  }
  process.exit(1);
}
console.log("\nNo counterexample found.");
