#!/usr/bin/env node
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rewrite an Istanbul coverage map's file keys to repo-relative POSIX paths.
 *
 * Istanbul keys every file by its ABSOLUTE path, which makes the map a
 * machine-specific artifact — and the package's coverage map is not one:
 * `.fallowrc.json` feeds it to fallow as the input for coverage-aware CRAP
 * scores, and turbo caches `coverage/**` as an output of the `test` task, in a
 * REMOTE cache shared by CI and every developer machine. A cache hit therefore
 * restores whatever root produced the entry. When that is a laptop
 * (`/Users/<name>/…`) and the consumer is a CI runner
 * (`/home/runner/_work/…`), fallow matches 0 of ~12k functions, silently falls
 * back to its pessimistic static estimate for all of them, and the audit gate
 * changes meaning — failing a PR for complexity its author's own green gate
 * scored as covered. Whoever warms the task hash first decides, so the gate is
 * not even deterministic (issue: the Fallow job's coverage-blind audit).
 *
 * Relative keys make the artifact portable, so the shared cache stays useful and
 * the gate means the same thing everywhere. fallow resolves them against its own
 * root; `check-coverage-map.ts` is the guard that the map a run is about to use
 * actually matches this checkout.
 *
 * Runs as the tail of the coverage-producing script, so the file turbo caches is
 * already portable. Idempotent: a key that is not under the repo root is left
 * exactly as it is (a map already relativized, or one describing another
 * project, which the guard reports rather than this script rewriting).
 */

// The root fallow resolves coverage paths against — the workspace root, found by
// walking up rather than counted in "..": this script lives with the package whose
// coverage it rewrites, and a move should not silently change what the paths are
// relative to.
async function findWorkspaceRoot(from: string): Promise<string> {
  for (let dir = from; dir !== parse(dir).root; dir = dirname(dir)) {
    const found = await access(resolve(dir, "pnpm-workspace.yaml")).then(
      () => true,
      () => false,
    );
    if (found) return dir;
  }
  throw new Error(`relativize-coverage: no pnpm-workspace.yaml above ${from}`);
}

const repoRoot = await findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: relativize-coverage.ts <coverage-final.json>");
  process.exit(1);
}

let raw: string;
try {
  raw = await readFile(target, "utf8");
} catch {
  // Chained after the coverage run, so this means the run produced no map (the
  // reporter turned off, a path changed) — say which file, rather than dying on an
  // unhandled rejection halfway through a test task's output.
  console.error(`relativize-coverage: ${target} was not written by the coverage run`);
  process.exit(1);
}
const map = JSON.parse(raw) as Record<string, Record<string, unknown> & { path?: string }>;

// A file under the repo root, as a POSIX-separated repo-relative path; null for
// anything else (already relative, or outside this checkout).
//
// The two sides of this rewrite learn how to spell the checkout from different
// places: the root from this module's own path (which Node resolves through
// symlinks), the keys from wherever the test runner resolved them (which may not).
// A checkout reached through a link — macOS `/tmp` for `/private/tmp`, a synced
// folder, a convenience symlink — then has keys under a root that is the same
// directory by another name, and a plain prefix test leaves every one of them
// absolute: no rewrite, and a guard failure that reads like a stale cache. So a key
// that does not match by name is resolved and tried again. (A case-insensitive
// filesystem can differ in a third way, by case alone; that is left alone
// deliberately — lowercasing paths would corrupt them on the platforms that care.)
function underRoot(path: string): string | null {
  if (!path.startsWith(repoRoot + sep)) return null;
  return relative(repoRoot, path).split(sep).join("/");
}

async function repoRelative(key: string): Promise<string | null> {
  // Only an absolute key is a candidate: a relative one is already what this script
  // produces, and resolving it would just resolve against the cwd and rewrite it to
  // itself — work, and a count, for nothing.
  if (!isAbsolute(key)) return null;
  const byName = underRoot(key);
  if (byName !== null) return byName;
  const real = await realpath(key).then(
    (resolved) => resolved,
    () => null,
  );
  return real === null ? null : underRoot(real);
}

const rewritten: Record<string, Record<string, unknown>> = {};
let changed = 0;
for (const [key, entry] of Object.entries(map)) {
  const relativeKey = await repoRelative(key);
  if (relativeKey === null) {
    rewritten[key] = entry;
    continue;
  }
  // `path` inside the entry is the same absolute path; keep the two in step.
  rewritten[relativeKey] = { ...entry, path: relativeKey };
  changed++;
}

if (changed > 0) {
  await writeFile(target, JSON.stringify(rewritten));
}
console.log(
  `relativize-coverage: ${changed} of ${Object.keys(map).length} file(s) rewritten relative to ${repoRoot}`,
);
