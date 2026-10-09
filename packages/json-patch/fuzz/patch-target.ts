// The Jazzer.js fuzz target: raw bytes from libFuzzer, checked by the shared oracle
// against the BUILT library, which is what Jazzer instruments for coverage feedback
// (`pnpm fuzz` builds it first). See README.md in this directory.

import { applyPatch, createPatch, JsonPatchError, parsePatch } from "@dossierhq/json-patch";

import { checkFuzzInput } from "../src/test/fuzz-oracle.ts";

const library = { applyPatch, createPatch, JsonPatchError, parsePatch };

export function fuzz(data: Buffer): void {
  checkFuzzInput(data, library);
}
