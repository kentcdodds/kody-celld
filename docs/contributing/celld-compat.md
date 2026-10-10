# celld compatibility

celld is not workerd. Things this codebase already works around — do not undo
them without re-testing on celld.

## Worker Loader import resolution

The Worker Loader resolves relative imports from the importing module's
directory (celld 0.6, denoland/celld#227). Every module is registered under its
full path and every import is rewritten to a real relative path
(`relativeSpecifier` in `src/execute/module-graph.ts`).

## Module types

Worker Loader modules must be **JS strings or wasm** — no `text`/`json` module
types. JSON becomes `export default {...}`; docs are left out of the graph.

## RPC error shape

RPC preserves only `name`/`message` on errors (hence the `KodyError` rule in
[security-invariants.md](./security-invariants.md)).

## Deploy layout

`celld deploy` requires `main` to live inside the config's directory, which is
why the rendered fleet config sits beside `wrangler.jsonc`.
