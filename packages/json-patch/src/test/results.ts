// Unwrap a result in a test that expects one outcome: the other fails the test, so the
// assertions that follow run on every path rather than under an `if (result.ok)`.

import type { JsonPatchError, JsonPatchResult } from "../errors.js";

/** The value of a result the test expects to succeed; a refusal fails with its own error. */
export function okValue<T>(result: JsonPatchResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** The error of a result the test expects to be refused; a value fails the test. */
export function errorOf<T>(result: JsonPatchResult<T>): JsonPatchError {
  if (result.ok) throw new Error("expected a refusal, got a value");
  return result.error;
}
