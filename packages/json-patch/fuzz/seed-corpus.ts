// Seed the fuzz corpus with every conformance suite record, as the `{ doc, patch }` object
// the oracle reads as one case, plus every pinned regression. Idempotent: libFuzzer keeps
// adding its own finds to the same directory, and a seed already there is left alone.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const CORPUS = new URL("corpus/", import.meta.url);
const CRASHES = new URL("crashes/", import.meta.url);
const REGRESSIONS = new URL("regressions/", import.meta.url);
const SUITE = new URL("../src/conformance/", import.meta.url);

mkdirSync(CORPUS, { recursive: true });
mkdirSync(CRASHES, { recursive: true });

let seeded = 0;
for (const file of ["tests.json", "spec_tests.json"]) {
  const records = JSON.parse(readFileSync(new URL(file, SUITE), "utf8")) as Record<
    string,
    unknown
  >[];
  records.forEach((record, index) => {
    if (!Object.hasOwn(record, "patch")) return;
    const seed = new URL(`suite-${file.replace(".json", "")}-${index}.json`, CORPUS);
    if (existsSync(seed)) return;
    writeFileSync(seed, JSON.stringify({ doc: record.doc, patch: record.patch }));
    seeded++;
  });
}
for (const name of readdirSync(REGRESSIONS)) {
  if (name.startsWith(".") || name.endsWith(".md")) continue;
  const seed = new URL(`regression-${name}`, CORPUS);
  if (existsSync(seed)) continue;
  copyFileSync(new URL(name, REGRESSIONS), seed);
  seeded++;
}
console.log(`fuzz corpus: ${seeded} new seed(s) in ${CORPUS.pathname}`);
