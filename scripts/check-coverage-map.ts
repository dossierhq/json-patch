#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fail when the coverage map fallow is about to read does not describe THIS
 * checkout.
 *
 * fallow reads `health.coverage` from `.fallowrc.json` for coverage-aware CRAP
 * scores, and a map whose paths it cannot match is not an error to it: it says so
 * in one line of notes and scores every function by its pessimistic static
 * estimate instead. That turns the audit gate into a different gate — strict
 * enough to fail a PR for complexity the author's own (matching) run scored as
 * covered — without failing anything, which is exactly how it went unnoticed.
 *
 * The map can stop matching without anyone touching it: turbo caches
 * `coverage/**` as an output of the `test` task in a cache shared between CI and
 * developer machines, and an Istanbul map keys files by absolute path, so a cache
 * hit can restore another root's paths. `relativize-coverage.ts` makes newly
 * produced maps portable; this guard is what catches a map that predates it, or
 * one from a project this checkout is not.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The single source of truth for where the map lives — read from the same config
// fallow reads, so the two can't drift. JSONC, of which only WHOLE-LINE `//`
// comments are handled: stripping trailing ones with a regex would eat the `//` in a
// URL-valued setting, and a real JSONC parser is more dependency than a path lookup
// deserves. A config that outgrows that gets a failure naming the cause rather than
// a bare SyntaxError from a script whose whole job is failing legibly.
const configPath = resolve(repoRoot, ".fallowrc.json");
let config: { health?: { coverage?: string } };
try {
  config = JSON.parse(
    (await readFile(configPath, "utf8")).replace(/^\s*\/\/.*$/gm, ""),
  ) as typeof config;
} catch (error) {
  console.error(
    `check-coverage-map: could not parse ${configPath} after stripping whole-line // comments: ${
      error instanceof Error ? error.message : String(error)
    }\n  Only whole-line comments are supported here — move a trailing or block comment onto its own line.`,
  );
  process.exit(1);
}
const configured = config.health?.coverage;
if (configured === undefined) {
  console.error(
    "check-coverage-map: .fallowrc.json declares no health.coverage; nothing to check (remove this guard, or restore the setting)",
  );
  process.exit(1);
}

const mapPath = resolve(repoRoot, configured);
let raw: string;
try {
  raw = await readFile(mapPath, "utf8");
} catch {
  console.error(
    `check-coverage-map: ${configured} is missing — run \`pnpm fallow:coverage\` before any fallow command (fallow errors out without it)`,
  );
  process.exit(1);
}

const files = Object.keys(JSON.parse(raw) as Record<string, unknown>);
if (files.length === 0) {
  console.error(`check-coverage-map: ${configured} describes no files`);
  process.exit(1);
}

// --force: turbo keys the cache on inputs, so deleting coverage/ and rerunning would
// just restore the same map.
const regenerate =
  "pnpm turbo run test --force --filter=@dossierhq/json-patch && pnpm check-coverage-map";
const silently =
  "fallow would not fail on a map it cannot match: it scores every function by its pessimistic static\n" +
  "  estimate instead, which silently changes what the audit gate means.";

// ABSOLUTE paths are the portability failure itself, whether or not they happen to
// resolve on the machine running this. An Istanbul map is keyed by path, turbo
// caches coverage/ in a cache shared between CI and developer machines, and the
// consumer of a cache hit is rarely the producer — so an absolute map is a landmine
// for whoever restores it next even when it looks fine here. Newly produced maps
// are relativized (relativize-coverage.ts); this rejects the ones that predate it.
const absolute = files.filter((file) => isAbsolute(file));
if (absolute.length > 0) {
  console.error(
    `check-coverage-map: ${absolute.length} of ${files.length} path(s) in ${configured} are ABSOLUTE, e.g.\n` +
      `${absolute
        .slice(0, 3)
        .map((file) => `    ${file}`)
        .join("\n")}\n` +
      `  Such a map matches only the checkout root that produced it, and turbo caches it for every other one.\n` +
      `  Regenerate it here: \`${regenerate}\`.\n  ${silently}`,
  );
  process.exit(1);
}

// Relative paths still have to land on files THIS checkout has — a map restored from
// a sibling checkout at another commit is relative and wrong.
const resolvable = await Promise.all(
  files.map((file) =>
    access(resolve(repoRoot, file)).then(
      () => true,
      () => false,
    ),
  ),
);
const missing = files.filter((_, index) => !resolvable[index]);
if (missing.length > 0) {
  console.error(
    `check-coverage-map: ${missing.length} of ${files.length} file(s) in ${configured} do not exist in this checkout, e.g.\n` +
      `${missing
        .slice(0, 3)
        .map((file) => `    ${file}`)
        .join("\n")}\n` +
      `  The map describes a different tree than the one being analyzed. Regenerate it here: \`${regenerate}\`.\n  ${silently}`,
  );
  process.exit(1);
}

console.log(
  `check-coverage-map: ${files.length} repo-relative file(s) in ${configured} all resolve in this checkout`,
);
