// A second implementation of this library's contract, written for obviousness instead of
// speed or safety, for the differential property test to hold the real one against.
//
// It shares no code with src/: its own value model (a tagged tree whose objects are Maps,
// so no prototype, no "__proto__" and no key order can matter), its own pointer parser
// (regexes straight from RFC 6901's grammar), its own reading of RFC 6902 (each operation
// as the RFC words it: a `move` IS a remove then an add, a `copy` IS an add of the value
// at `from`), all recursive and all immutable. Where the library diverges from the RFC on
// purpose — the members an operation may have, the I-JSON value domain, the root that
// cannot be removed, a `test` of nothing failing — this does too, independently.
//
// It ignores every limit: the property that compares the two gives the library limits the
// generated values never reach, or accepts LIMIT_EXCEEDED as the only way to differ.

export type Tree =
  | null
  | boolean
  | number
  | string
  | { readonly kind: "array"; readonly items: readonly Tree[] }
  | { readonly kind: "object"; readonly members: ReadonlyMap<string, Tree> };

export type ReferenceResult =
  | { readonly ok: true; readonly value: Tree }
  | { readonly ok: false; readonly code: string; readonly index: number | null };

/** The tree `value` denotes if it is an I-JSON value as the library defines one. */
export function toTree(value: unknown): Tree | undefined {
  if (typeof value !== "object" || value === null) return scalarToTree(value);
  if (Array.isArray(value)) return arrayToTree(value);
  return isPlainObject(value) ? objectToTree(value) : undefined;
}

function scalarToTree(value: unknown): Tree | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.isWellFormed() ? value : undefined;
  return undefined;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function objectToTree(value: object): Tree | undefined {
  const members = new Map<string, Tree>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !key.isWellFormed()) return undefined;
    const member = readData(value, key);
    if (member === undefined) return undefined;
    const tree = toTree(member.value);
    if (tree === undefined) return undefined;
    members.set(key, tree);
  }
  return { kind: "object", members };
}

function arrayToTree(value: unknown[]): Tree | undefined {
  if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return undefined;
  const items: Tree[] = [];
  for (let index = 0; index < value.length; index++) {
    const member = readData(value, String(index));
    if (member === undefined) return undefined;
    const tree = toTree(member.value);
    if (tree === undefined) return undefined;
    items.push(tree);
  }
  return { kind: "array", items };
}

function readData(value: object, key: string): { value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    return undefined;
  }
  return { value: descriptor.value as unknown };
}

export function treeEqual(a: Tree, b: Tree): boolean {
  if (a === null || typeof a !== "object" || b === null || typeof b !== "object") return a === b;
  if (a.kind === "array" && b.kind === "array") return itemsEqual(a.items, b.items);
  if (a.kind === "object" && b.kind === "object") return membersEqual(a.members, b.members);
  return false;
}

function itemsEqual(a: readonly Tree[], b: readonly Tree[]): boolean {
  return a.length === b.length && a.every((item, i) => treeEqual(item, b[i]!));
}

function membersEqual(a: ReadonlyMap<string, Tree>, b: ReadonlyMap<string, Tree>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, member] of a) {
    const other = b.get(key);
    if (other === undefined || !treeEqual(member, other)) return false;
  }
  return true;
}

// RFC 6901: "" or ("/" token)*, where a token's "~" is always "~0" or "~1".
function parsePointer(pointer: string): string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/") || !pointer.isWellFormed()) return undefined;
  const tokens = pointer.slice(1).split("/");
  if (tokens.some((token) => /~(?![01])/.test(token))) return undefined;
  return tokens.map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const INDEX = /^(0|[1-9][0-9]*)$/;

type Operation =
  | { op: "add" | "replace" | "test"; path: string[]; value: Tree }
  | { op: "remove"; path: string[] }
  | { op: "move" | "copy"; path: string[]; from: string[] };

const MEMBERS: Record<string, string[]> = {
  add: ["op", "path", "value"],
  remove: ["op", "path"],
  replace: ["op", "path", "value"],
  move: ["op", "path", "from"],
  copy: ["op", "path", "from"],
  test: ["op", "path", "value"],
};

type Parsed<T> = { ok: true; value: T } | { ok: false; code: string };

const INVALID = { ok: false, code: "INVALID_PATCH" } as const;

function parseOperation(raw: unknown): Parsed<Operation> {
  if (!isPlainObject(raw)) return INVALID;
  const op = readData(raw, "op")?.value;
  if (typeof op !== "string" || !Object.hasOwn(MEMBERS, op)) return INVALID;
  if (!hasOnlyMembers(raw, MEMBERS[op]!)) return INVALID;
  const pathText = readData(raw, "path")?.value;
  if (typeof pathText !== "string") return INVALID;
  const path = parsePointer(pathText);
  if (path === undefined) return { ok: false, code: "INVALID_POINTER" };
  return parseByOp(raw, op, path);
}

function parseByOp(raw: object, op: string, path: string[]): Parsed<Operation> {
  if (op === "remove") return path.length === 0 ? INVALID : { ok: true, value: { op, path } };
  if (op === "move" || op === "copy") return parseFromOperation(raw, op, path);
  return parseValueOperation(raw, op as "add" | "replace" | "test", path);
}

function hasOnlyMembers(raw: object, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(raw).every(
    (key) => typeof key === "string" && allowed.includes(key) && readData(raw, key) !== undefined,
  );
}

function parseFromOperation(raw: object, op: "move" | "copy", path: string[]): Parsed<Operation> {
  const fromText = readData(raw, "from")?.value;
  if (typeof fromText !== "string") return INVALID;
  const from = parsePointer(fromText);
  if (from === undefined) return { ok: false, code: "INVALID_POINTER" };
  const intoItself = from.length < path.length && from.every((token, i) => token === path[i]);
  if (op === "move" && intoItself) return INVALID;
  return { ok: true, value: { op, path, from } };
}

function parseValueOperation(
  raw: object,
  op: "add" | "replace" | "test",
  path: string[],
): Parsed<Operation> {
  const member = readData(raw, "value");
  if (member === undefined) return INVALID;
  const value = toTree(member.value);
  if (value === undefined) return { ok: false, code: "INVALID_VALUE" };
  return { ok: true, value: { op, path, value } };
}

/** Apply `patch` (anything) to `document` (a tree) the way the library's contract says. */
export function referenceApply(document: Tree, patch: unknown): ReferenceResult {
  if (!Array.isArray(patch) || Object.getPrototypeOf(patch) !== Array.prototype) {
    return { ok: false, code: "INVALID_PATCH", index: null };
  }
  if (Reflect.ownKeys(patch).length !== patch.length + 1) {
    return { ok: false, code: "INVALID_PATCH", index: null };
  }
  const operations: Operation[] = [];
  for (let index = 0; index < patch.length; index++) {
    const member = readData(patch, String(index));
    if (member === undefined) return { ok: false, code: "INVALID_PATCH", index: null };
    const parsed = parseOperation(member.value);
    if (!parsed.ok) return { ok: false, code: parsed.code, index };
    operations.push(parsed.value);
  }
  let current = document;
  for (const [index, operation] of operations.entries()) {
    const next = step(current, operation);
    if (typeof next === "string") return { ok: false, code: next, index };
    current = next.tree;
  }
  return { ok: true, value: current };
}

type Step = { tree: Tree } | "PATH_NOT_FOUND" | "FROM_NOT_FOUND" | "TEST_FAILED";

function step(tree: Tree, operation: Operation): Step {
  const handler = STEPS[operation.op] as (tree: Tree, operation: Operation) => Step;
  return handler(tree, operation);
}

type Handlers = {
  [Op in Operation["op"]]: (tree: Tree, operation: Extract<Operation, { op: Op }>) => Step;
};

const STEPS: Handlers = {
  add: (tree, { path, value }) => add(tree, path, value),
  remove: (tree, { path }) => remove(tree, path) ?? "PATH_NOT_FOUND",
  replace: (tree, { path, value }) => replace(tree, path, value),
  test: (tree, { path, value }) => {
    const actual = get(tree, path);
    return actual !== undefined && treeEqual(actual, value) ? { tree } : "TEST_FAILED";
  },
  move: (tree, { from, path }) => move(tree, from, path),
  copy: (tree, { from, path }) => {
    const value = get(tree, from);
    return value === undefined ? "FROM_NOT_FOUND" : add(tree, path, value);
  },
};

// RFC 6902 §4.3: "functionally identical to a remove followed by an add" — of a value that
// must exist. The root is replaced outright.
function replace(tree: Tree, path: readonly string[], value: Tree): Step {
  if (path.length === 0) return { tree: value };
  const removed = remove(tree, path);
  return removed === undefined ? "PATH_NOT_FOUND" : add(removed.tree, path, value);
}

// §4.4: a remove from `from`, then an add at `path` — which leaves a move onto itself as
// it was. The root can only be moved onto itself.
function move(tree: Tree, from: readonly string[], path: readonly string[]): Step {
  const value = get(tree, from);
  if (value === undefined) return "FROM_NOT_FOUND";
  if (from.length === 0) return { tree };
  return add(remove(tree, from)!.tree, path, value);
}

function child(tree: Tree, token: string): Tree | undefined {
  if (tree === null || typeof tree !== "object") return undefined;
  if (tree.kind === "object") return tree.members.get(token);
  if (!INDEX.test(token)) return undefined;
  return tree.items[Number(token)];
}

function get(tree: Tree, path: readonly string[]): Tree | undefined {
  let current: Tree | undefined = tree;
  for (const token of path) {
    if (current === undefined) return undefined;
    current = child(current, token);
  }
  return current;
}

// `tree` with `replacement` in place of the child `token` names (which exists).
function withChild(tree: Tree, token: string, replacement: Tree): Tree {
  if (tree === null || typeof tree !== "object") throw new Error("not a container");
  if (tree.kind === "object")
    return { kind: "object", members: new Map(tree.members).set(token, replacement) };
  const items = [...tree.items];
  items[Number(token)] = replacement;
  return { kind: "array", items };
}

function add(tree: Tree, path: readonly string[], value: Tree): Step {
  const [token, ...rest] = path;
  if (token === undefined) return { tree: value };
  if (rest.length === 0) return addMember(tree, token, value);
  const next = child(tree, token);
  if (next === undefined) return "PATH_NOT_FOUND";
  const added = add(next, rest, value);
  return typeof added === "string" ? added : { tree: withChild(tree, token, added.tree) };
}

function addMember(tree: Tree, token: string, value: Tree): Step {
  if (tree === null || typeof tree !== "object") return "PATH_NOT_FOUND";
  if (tree.kind === "object") {
    return { tree: { kind: "object", members: new Map(tree.members).set(token, value) } };
  }
  const index = token === "-" ? tree.items.length : INDEX.test(token) ? Number(token) : -1;
  if (index < 0 || index > tree.items.length) return "PATH_NOT_FOUND";
  const items = [...tree.items];
  items.splice(index, 0, value);
  return { tree: { kind: "array", items } };
}

function remove(tree: Tree, path: readonly string[]): { tree: Tree } | undefined {
  const [token, ...rest] = path;
  if (token === undefined) return undefined;
  const next = child(tree, token);
  if (next === undefined || tree === null || typeof tree !== "object") return undefined;
  if (rest.length > 0) {
    const removed = remove(next, rest);
    return removed === undefined ? undefined : { tree: withChild(tree, token, removed.tree) };
  }
  if (tree.kind === "object") {
    const members = new Map(tree.members);
    members.delete(token);
    return { tree: { kind: "object", members } };
  }
  const items = [...tree.items];
  items.splice(Number(token), 1);
  return { tree: { kind: "array", items } };
}
