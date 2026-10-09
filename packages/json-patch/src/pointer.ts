import { assert } from "./assert.js";

/** A parsed RFC 6901 pointer: its reference tokens, unescaped, root first. Frozen. */
export type PointerTokens = readonly string[];

export type ParsedPointer =
  | { readonly ok: true; readonly tokens: PointerTokens }
  | {
      readonly ok: false;
      readonly code: "INVALID_POINTER" | "LIMIT_EXCEEDED";
      readonly detail: string;
    };

const DIGIT_ZERO = 0x30;
const DIGIT_ONE = 0x31;

const ROOT: PointerTokens = Object.freeze([]);

/**
 * The tokens of `pointer`, or why it is not one. Stricter than most readers of RFC 6901,
 * never looser:
 * - "" is the root; anything else starts with "/" (so "/" is the member named "").
 * - "~" is only ever "~0" or "~1": a bare "~2" or a trailing "~" is an error, not a
 *   literal, so every key has exactly one spelling.
 * - The pointer is well-formed UTF-16: no lone surrogate (I-JSON).
 * - At most `maxLength` code units and `maxDepth` tokens.
 * Array index syntax is not checked here: whether "01" is an index or a member name
 * depends on the container the token meets (see arrayIndex).
 */
export function parsePointer(pointer: string, maxLength: number, maxDepth: number): ParsedPointer {
  if (pointer.length > maxLength) {
    return { ok: false, code: "LIMIT_EXCEEDED", detail: "pointer is longer than maxPointerLength" };
  }
  if (pointer === "") return { ok: true, tokens: ROOT };
  if (!pointer.startsWith("/")) {
    return { ok: false, code: "INVALID_POINTER", detail: 'pointer does not start with "/"' };
  }
  if (!pointer.isWellFormed()) {
    return { ok: false, code: "INVALID_POINTER", detail: "pointer has a lone surrogate" };
  }
  const raw = pointer.slice(1).split("/");
  if (raw.length > maxDepth) {
    return { ok: false, code: "LIMIT_EXCEEDED", detail: "pointer is deeper than maxDepth" };
  }
  const tokens: string[] = [];
  for (const token of raw) {
    if (!hasValidEscapes(token)) {
      return {
        ok: false,
        code: "INVALID_POINTER",
        detail: 'pointer has a "~" not followed by 0 or 1',
      };
    }
    tokens.push(unescapeToken(token));
  }
  assert(tokens.length === raw.length, "every pointer token is kept");
  return { ok: true, tokens: Object.freeze(tokens) };
}

function hasValidEscapes(token: string): boolean {
  for (let at = token.indexOf("~"); at !== -1; at = token.indexOf("~", at + 1)) {
    const next = token.charCodeAt(at + 1);
    if (next !== DIGIT_ZERO && next !== DIGIT_ONE) return false;
  }
  return true;
}

// "~1" before "~0": the other order would read "~01" (the key "~1") as "/".
function unescapeToken(token: string): string {
  if (!token.includes("~")) return token;
  const unescaped = token.replaceAll("~1", "/").replaceAll("~0", "~");
  assert(unescaped.length < token.length, "an escaped token shrinks when unescaped");
  return unescaped;
}

/**
 * The RFC 6901 spelling of one reference token: "~" as "~0", then "/" as "~1" (the other
 * order would turn "/" into "~01"). The one spelling parsePointer reads back as `token`.
 */
export function escapeToken(token: string): string {
  const escaped = token.replaceAll("~", "~0").replaceAll("/", "~1");
  assert(unescapeToken(escaped) === token, "an escaped token unescapes to itself");
  return escaped;
}

// The digits above which an index can never be in range: no array holds 2^32 members, and
// fifteen digits stay a safe integer, so a longer index is parsed as "out of range".
const MAX_INDEX_DIGITS = 15;

// RFC 6901's `array-index`: "0", or a digit string not starting with 0. Anchored, and with
// no nested quantifier, so it runs in time linear in the token.
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * The array index `token` names, or -1 when it names none: RFC 6901 allows "0" and a
 * digit string without a leading zero — no sign, no exponent, no whitespace, no "-". An
 * index too long to be in range for any array comes back as Number.MAX_SAFE_INTEGER, which
 * every range check refuses.
 */
export function arrayIndex(token: string): number {
  if (!ARRAY_INDEX.test(token)) return -1;
  return token.length > MAX_INDEX_DIGITS ? Number.MAX_SAFE_INTEGER : Number(token);
}

/**
 * Whether the location `inner` names lies strictly inside the one `outer` names: `outer`'s
 * tokens are a proper prefix of `inner`'s. Compared token by token, so "/a" is not a prefix
 * of "/ab", and "/a~1b" (the key "a/b") is not a prefix of "/a/b/c".
 */
export function isStrictlyInside(inner: PointerTokens, outer: PointerTokens): boolean {
  return outer.length < inner.length && outer.every((token, at) => token === inner.at(at));
}

/** Whether two pointers name the same location. */
export function isSameLocation(a: PointerTokens, b: PointerTokens): boolean {
  return a.length === b.length && a.every((token, at) => token === b.at(at));
}
