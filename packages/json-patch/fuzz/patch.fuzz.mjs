// Jazzer.js loads a fuzz target by a `.js`/`.mjs`/`.cjs` path (it appends `.js` to any
// other), so this entry re-exports the TypeScript one, which Node runs by type stripping.
export { fuzz } from "./patch-target.ts";
