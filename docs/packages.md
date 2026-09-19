# Packages

A package is a set of files saved into the caller's `UserCell`. The format is
the production Kody manifest so packages move between kody.codes and a
self-hosted node unchanged.

## Manifest

```json
{
  "name": "@kody-smoke/counter",
  "version": "1.0.0",
  "description": "Durable counter backed by packageStorage(), with a recurring tick job.",
  "exports": {
    ".": "./status.js",
    "./increment": "./increment.js",
    "./tick": "./tick.js"
  },
  "kody": {
    "hidden": false,
    "dependencies": { "@kody-smoke/other": "^1" },
    "jobs": {
      "tick": { "entry": "./tick.js", "schedule": { "type": "interval", "every": "1m" } }
    }
  }
}
```

Rules enforced by `src/packages/manifest.ts` on `packageSave`:

- valid npm-style `name` (scoped or not), `version`, `description`;
- non-empty `README.md` (for humans) and `AGENTS.md` (for agents; `search`
  surfaces it);
- `exports` must point at files present in the upload; `.` is the default
  export used by `packageRun` when no `export` is given;
- `kody.jobs[*].entry` must be an uploaded module and `schedule` must parse
  (see [jobs.md](./jobs.md));
- `kody.dependencies` is validated and kept on the manifest for tooling; at run
  time packages simply `import` each other via `kody:@scope/pkg/...` (there is
  no install step).

## Lifecycle capabilities

| Capability                                                                                         | From `execute`?                               | Notes                                                                                             |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packageSave({ files })`                                                                           | yes                                           | `files` is `{ "path": "contents" }`. Re-saving reconciles jobs (adds, updates schedule, removes). |
| `packageList()` / `packageGet({ name })`                                                           | yes                                           | `packageGet` returns manifest, README, AGENTS, file list.                                         |
| `packageDelete({ name })`                                                                          | yes                                           | Also deletes its jobs. Package storage is kept until `packageStorageClear`.                       |
| `packageRun({ name, export?, params? })`                                                           | **no** (host only via `/api/call/packageRun`) | Inside a run, import the export instead — it is cheaper and keeps one run record.                 |
| `packageStorageInspect({ packageName, prefix?, limit? })` / `packageStorageClear({ packageName })` | yes (a package may only inspect its own)      | KV entries, KV count, SQL tables.                                                                 |

## Importing packages from code

```ts
import status from 'kody:@kody-smoke/counter' // "." export
import increment from 'kody:@kody-smoke/counter/increment'
export default async () => {
  await increment({ by: 2 })
  return status()
}
```

The module graph (`src/execute/module-graph.ts`) pulls the package's files into
the isolate under `packages/<name>/<path>`, rewrites its internal relative
imports to celld-friendly root paths, and stamps `packageStorage()` →
`packageStorage('<name>')`. Transitive `kody:` imports between packages work
the same way. Cycles are rejected.

## `packageStorage()`

```ts
import { packageStorage } from 'kody:runtime'
const store = packageStorage()
await store.set('count', 1) // JSON values
await store.get('count')
await store.list({ prefix: 'user:', limit: 50 })
await store.delete('count')
await store.sql('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, kind TEXT)')
await store.sql('INSERT INTO events (kind) VALUES (?)', 'tick') // -> { rows, rowsWritten, ... }
await store.clear()
store.id // 'package-storage:@kody-smoke/counter'
```

Each `(user, package)` gets its own `PackageStorageCell` Durable Object — a
private SQLite database. `__kody_kv` is the KV table; anything else is the
package's own schema. Only the declaring package's code can obtain its
storage handle; ad hoc `execute` code calling `packageStorage()` gets a clear
error. Deleting a package does **not** clear its storage (call
`packageStorageClear` first if that is what you want).

## Loading a published package

kody-celld has no registry. To run a package published to kody.codes, fetch
its files (README, AGENTS, package.json, modules) and `packageSave` them —
the manifest and runtime contracts are the same. The smoke suite does exactly
this with `examples/packages/*` via `readPackageDir` + `packageSave`.

## npm dependencies (experimental)

Bare imports inside a run or package (`import ms from 'ms'`) are resolved via
esm.sh at graph-build time and inlined. Pin versions in the specifier
(`'ms@2.1.3'`) if you rely on it. Limits: 40 modules, 6 MiB, 15 s per fetch.
The run's `warnings` array tells you when this path was used.
