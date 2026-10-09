import fc from "fast-check";

// Generators for the property tests. Documents and patches draw member names from one
// SMALL alphabet on purpose: two independent draws then share and miss paths constantly,
// so every kind of failure is common instead of a lottery. The alphabet holds a pointer
// escape of each kind ("k/ey", "t~de"), the empty name, names an array index could be
// mistaken for ("0", "01", "-"), and the names a plain object or an array inherits or
// owns ("__proto__", "constructor", "toString", "length") — the ones a lookup through the
// prototype chain would get wrong.

export const MEMBER_NAMES = [
  "a",
  "b",
  "",
  "k/ey",
  "t~de",
  "0",
  "1",
  "01",
  "-",
  "__proto__",
  "constructor",
  "toString",
  "length",
] as const;

const memberNameArb = fc.constantFrom(...MEMBER_NAMES);

const scalarArb = fc.oneof(
  fc.constantFrom(0, 1, -0, 2.5, -1e300),
  fc.constantFrom("", "x", "a/b", "~0", "\u{1F600}"),
  fc.boolean(),
  fc.constant(null),
);

/** An object with the given members, each DEFINED so "__proto__" is a member like any. */
function objectOf(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    Object.defineProperty(object, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return object;
}

/** A JSON value, as JSON.parse would make it, at most a few levels deep. */
export const jsonArb: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    scalarArb,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.array(fc.tuple(memberNameArb, tie("value")), { maxLength: 4 }).map(objectOf),
  ),
})).value;

/** A document: usually a container, since a scalar root takes little patching. */
export const documentArb = fc.oneof(
  { weight: 9, arbitrary: jsonArb.filter((value) => typeof value === "object" && value !== null) },
  { weight: 1, arbitrary: scalarArb },
);

/** RFC 6901 escaping, for tests that build pointers from tokens. */
export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((token) => `/${token.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

const tokenArb = fc.oneof(memberNameArb, fc.constantFrom("2", "3", "00", "1e0", "-1"));

const wellFormedPointerArb = fc.array(tokenArb, { maxLength: 3 }).map(formatPointer);

/** Strings that are not pointers, or are only by a reading looser than RFC 6901's. */
const hostilePointerArb = fc.oneof(
  fc.constantFrom("a", "#/a", "/~2", "/~", "/a~", "/\uD800", "/a/\uDC00b", " /a"),
  fc.string({ maxLength: 6 }),
);

/** Values a patch may hold that are not I-JSON: each is refused as INVALID_VALUE. */
const nonJsonValueArb = fc.oneof(
  fc.constantFrom(undefined, Number.NaN, Number.POSITIVE_INFINITY, "\uD800", "a\uDFFFb", 1n),
  fc.constant(null).map(() => new Date(0)),
  fc.constant(null).map(() => {
    const holey: unknown[] = [];
    holey[0] = 1;
    holey[2] = 3;
    return holey;
  }),
  fc.constant(null).map(() => Object.assign([1], { extra: true })),
  fc.constant(null).map(() => ({ [Symbol("s")]: 1 })),
  fc.constant(null).map(() => ({ "\uD800": 1 })),
  fc.constant(null).map(() => Object.defineProperty({}, "hidden", { value: 1, enumerable: false })),
  fc.constant(null).map(() => ({
    get trap(): never {
      throw new Error("a getter in a patch value ran");
    },
  })),
);

const OPERATION_MEMBERS = {
  add: ["path", "value"],
  remove: ["path"],
  replace: ["path", "value"],
  move: ["path", "from"],
  copy: ["path", "from"],
  test: ["path", "value"],
} as const;

type OpName = keyof typeof OPERATION_MEMBERS;

function wellFormedOperationArb(pointer: fc.Arbitrary<string>, value: fc.Arbitrary<unknown>) {
  return fc
    .record({
      op: fc.constantFrom<OpName>("add", "remove", "replace", "move", "copy", "test"),
      path: pointer,
      from: pointer,
      value,
    })
    .map(({ op, path, from, value }) => {
      const members: Record<string, unknown> = { path, from, value };
      return objectOf([
        ["op", op],
        ...OPERATION_MEMBERS[op].map((name) => [name, members[name]] as const),
      ]);
    });
}

/** Operation objects that are malformed as a whole: each is refused as INVALID_PATCH. */
function malformedOperationArb(wellFormed: fc.Arbitrary<Record<string, unknown>>) {
  return fc.oneof(
    // A member missing, a member of the wrong type, a member its op does not define.
    wellFormed.chain((operation) =>
      fc
        .constantFrom(...Object.keys(operation))
        .map((drop) => objectOf(Object.entries(operation).filter(([key]) => key !== drop))),
    ),
    wellFormed.map((operation) => objectOf([...Object.entries(operation), ["path", 7]])),
    wellFormed.map((operation) => objectOf([...Object.entries(operation), ["xyz", 1]])),
    fc.constantFrom("spam", "ADD", "", 1).map((op) => ({ op, path: "/a", value: 1 })),
    fc.constantFrom(null, 1, "add", [], [{ op: "add" }]),
    fc.constant(null).map(() => ({
      op: "add",
      get path(): never {
        throw new Error("a getter in an operation ran");
      },
      value: 1,
    })),
    fc.constant(null).map(() => {
      const operation = Object.create({ op: "add" }) as Record<string, unknown>;
      operation.path = "/a";
      operation.value = 1;
      return operation;
    }),
  );
}

interface Location {
  readonly tokens: readonly string[];
  readonly value: unknown;
}

/** Every location in `document` and the value there, root first. */
function locationsOf(document: unknown, above: readonly string[] = []): Location[] {
  const locations: Location[] = [{ tokens: above, value: document }];
  if (typeof document !== "object" || document === null) return locations;
  for (const [key, member] of Object.entries(document)) {
    locations.push(...locationsOf(member, [...above, key]));
  }
  return locations;
}

/** The locations an add could create: a new member, an array's end, its next index. */
function insertionsOf(document: unknown): string[][] {
  return locationsOf(document).flatMap(({ tokens, value }) => {
    if (typeof value !== "object" || value === null) return [];
    return Array.isArray(value)
      ? [
          [...tokens, "-"],
          [...tokens, String(value.length)],
          [...tokens, "0"],
        ]
      : [
          [...tokens, "new"],
          [...tokens, "__proto__"],
        ];
  });
}

function cloneJson(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  return objectOf(Object.entries(value).map(([key, member]) => [key, cloneJson(member)] as const));
}

/**
 * A patch for `document`: each operation mostly aims at a location the document has (or,
 * for an add, one it could have), and a `test` mostly expects the value it finds there,
 * so operations succeed often enough for long patches to get far — the pointers are drawn
 * from the ORIGINAL document, so the ones before an operation still move them out from
 * under it now and then. One patch in four is hostile: it mixes in pointers, values and
 * operations that neither the RFC nor this library accepts.
 */
function patchFor(document: unknown): fc.Arbitrary<unknown[]> {
  const locations = locationsOf(document);
  const existing = fc.constantFrom(...locations);
  const insertions = insertionsOf(document).map(formatPointer);
  const somewhere = fc.oneof(
    { weight: 4, arbitrary: existing.map(({ tokens }) => formatPointer(tokens)) },
    {
      weight: 2,
      arbitrary: insertions.length > 0 ? fc.constantFrom(...insertions) : wellFormedPointerArb,
    },
    { weight: 1, arbitrary: wellFormedPointerArb },
  );
  // Below the root: removing the root, or moving it anywhere but onto itself, is refused
  // before the document is looked at — a hostile patch covers that, a clean one need not.
  const below = locations.slice(1).map(({ tokens }) => formatPointer(tokens));
  const at = below.length > 0 ? fc.constantFrom(...below) : wellFormedPointerArb;
  const clean = fc
    .oneof(
      fc.record({ op: fc.constant("add"), path: somewhere, value: jsonArb }),
      fc.record({
        op: fc.constant("remove"),
        path: fc.oneof({ weight: 4, arbitrary: at }, { weight: 1, arbitrary: somewhere }),
      }),
      fc.record({
        op: fc.constant("replace"),
        path: fc.oneof({ weight: 4, arbitrary: at }, { weight: 1, arbitrary: somewhere }),
        value: jsonArb,
      }),
      fc.record({ op: fc.constant("move"), from: at, path: somewhere }),
      fc.record({ op: fc.constant("copy"), from: at, path: somewhere }),
      fc.oneof(
        {
          weight: 3,
          arbitrary: existing.map(({ tokens, value }) => ({
            op: "test",
            path: formatPointer(tokens),
            value: cloneJson(value),
          })),
        },
        {
          weight: 1,
          arbitrary: fc.record({ op: fc.constant("test"), path: somewhere, value: jsonArb }),
        },
      ),
    )
    .map((operation) => objectOf(Object.entries(operation)));
  const hostile = fc.oneof(
    { weight: 3, arbitrary: clean },
    {
      weight: 1,
      arbitrary: wellFormedOperationArb(
        fc.oneof(somewhere, hostilePointerArb),
        fc.oneof(jsonArb, nonJsonValueArb),
      ),
    },
    { weight: 1, arbitrary: malformedOperationArb(clean) },
  );
  return fc.oneof(
    { weight: 3, arbitrary: fc.array(clean, { minLength: 1, maxLength: 8 }) },
    { weight: 1, arbitrary: fc.array(hostile, { maxLength: 8 }) },
  );
}

/** A document and two patches for it. */
export const scenarioArb = documentArb.chain((document) =>
  fc.record({
    document: fc.constant(document),
    patch: patchFor(document),
    next: patchFor(document),
  }),
);

/** A document and a patch of `test`s, each of a location it has and the value there. */
export const passingTestsArb = documentArb.chain((document) =>
  fc.record({
    document: fc.constant(document),
    patch: fc.array(
      fc.constantFrom(...locationsOf(document)).map(({ tokens, value }) => ({
        op: "test",
        path: formatPointer(tokens),
        value: cloneJson(value),
      })),
      { maxLength: 4 },
    ),
  }),
);
