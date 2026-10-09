/**
 * A broken invariant: a bug in this library, or a caller that broke a documented
 * precondition (a document that is not JSON, a patch not made by `parsePatch`, a limit
 * out of range). Never a bad patch: whatever an untrusted patch holds comes back as a
 * `JsonPatchError` result, and the property tests fail on any assertion a generated patch
 * reaches. Catching this to carry on is always wrong — the state it was raised in is not
 * one the code was written for.
 */
export class JsonPatchInvariantError extends Error {
  override name = "JsonPatchInvariantError";
}

// The messages are constants on purpose: an assertion sits on the hot path, and a
// message built per call (a template literal) would be paid for on every call that
// passes.
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new JsonPatchInvariantError(message);
}
