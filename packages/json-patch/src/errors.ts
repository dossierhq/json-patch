/**
 * Why a patch was refused. The first four come from `parsePatch` and hold whatever the
 * document is; the rest come from `applyPatch` and depend on it.
 *
 * - `INVALID_PATCH` — the patch document is not an array of well-formed operation
 *   objects: not an array, an operation that is not an object, an unknown `op`, a member
 *   missing, of the wrong type, or not defined for the operation, a `remove` of the root,
 *   a `move` into its own subtree.
 * - `INVALID_POINTER` — a `path` or `from` that is not an RFC 6901 pointer.
 * - `INVALID_VALUE` — a `value` that is not I-JSON (see the README).
 * - `LIMIT_EXCEEDED` — a limit of `JsonPatchLimits`, from either function.
 * - `PATH_NOT_FOUND` — a `path` that does not lead where the operation needs it to: a
 *   missing member or parent, an array index out of range, a token that is not an index
 *   of the array it meets.
 * - `FROM_NOT_FOUND` — the same, for the `from` of a `move` or `copy`.
 * - `TEST_FAILED` — a `test` whose value differs from the document's, or that finds no
 *   value at its path.
 */
export type JsonPatchErrorCode =
  | "INVALID_PATCH"
  | "INVALID_POINTER"
  | "INVALID_VALUE"
  | "LIMIT_EXCEEDED"
  | "PATH_NOT_FOUND"
  | "FROM_NOT_FOUND"
  | "TEST_FAILED";

/**
 * A refused patch. The message names the operation and, where one is at fault, its
 * pointer (truncated and JSON-escaped, so it is safe to log) — never a value, of the patch
 * or of the document: an error is often logged or sent where the document may not go.
 */
export class JsonPatchError extends Error {
  override name = "JsonPatchError";
  readonly code: JsonPatchErrorCode;
  /** The index of the operation at fault, or null when the fault is the patch as a whole. */
  readonly operationIndex: number | null;

  constructor(code: JsonPatchErrorCode, operationIndex: number | null, detail: string) {
    super(operationIndex === null ? detail : `operation ${operationIndex}: ${detail}`);
    this.code = code;
    this.operationIndex = operationIndex;
  }
}

/** The outcome of a function that refuses bad input by value rather than by throwing. */
export type JsonPatchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: JsonPatchError };

export function ok<T>(value: T): JsonPatchResult<T> {
  return { ok: true, value };
}

export function fail<T>(
  code: JsonPatchErrorCode,
  operationIndex: number | null,
  detail: string,
): JsonPatchResult<T> {
  return { ok: false, error: new JsonPatchError(code, operationIndex, detail) };
}

const QUOTED_MAX = 64;

// A string from the patch (a pointer, an op name, a member name) as an error message may
// show it: at most QUOTED_MAX code units, then JSON-quoted, which escapes control
// characters and any surrogate the cut left alone — so a message is safe to log.
export function quote(text: string): string {
  return JSON.stringify(text.length > QUOTED_MAX ? `${text.slice(0, QUOTED_MAX)}…` : text);
}
