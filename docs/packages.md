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

## Install from GitHub or a URL

`packageInstall` downloads a package on the server and saves it exactly like
`packageSave` (same manifest validation, same 4 MiB cap), recording where it
came from in `source` so `packageUpdate` can pull it again later.

```ts
import { kody } from 'kody:runtime'
export default async function main() {
  // GitHub: github:owner/repo[/sub/dir][#ref] or a github.com URL
  await kody.packageInstall({ source: 'github:kentcdodds/kody-celld/examples/packages/http-probe#main' })
  await kody.packageInstall({ source: 'https://github.com/owner/repo/tree/v1.2.0/packages/hello' })
  // Any http(s) tarball (.tar.gz / .tgz) or JSON file map ({ "package.json": "...", ... } or { files: {...} })
  await kody.packageInstall({ source: 'https://example-cdn.test/hello-1.0.0.tgz', subdir: 'package' })
  // Later: re-fetch from the recorded source
  return await kody.packageUpdate({ name: '@kody-smoke/http-probe' })
}
```

The same form is on the account **Packages** page. Rules:

- GitHub sources become `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`
  (`HEAD` when no ref is given); the archive's common root directory is
  stripped and `subdir` (or the path in the source) selects the package root.
  When `package.json` is missing there, the error lists directories that do
  have one.
- Only `http(s)` URLs without embedded credentials, on a host in
  `KODY_PACKAGE_SOURCE_HOSTS` (default: GitHub's hosts; `*.suffix` patterns and
  `*` are accepted). Loopback/private/link-local addresses and `.local` /
  `.internal` / single-label names are refused unless the operator lists that
  exact host — do that for a Gitea/Forgejo/GitLab on your LAN. Every redirect
  hop is re-checked (max 3).
- Limits: 8 MiB download, 24 MiB after gunzip, 400 files, 20 s. `.git/` and
  `node_modules/` are skipped, non-UTF-8 files are skipped with a warning.
- Package code cannot call `packageInstall`/`packageUpdate` (403); only the
  user (via MCP `execute`, the REST call surface or the web UI) can.
- `packageUpdate` works for `github:`/URL sources and for community installs
  (`community:<name>@<version>`); packages saved from an in-memory file map or
  forks have nothing to update from.

## Sharing packages

The node has a public **community catalog** where users publish their saved
packages and others install or fork them — see [community.md](./community.md).
To run a package published to kody.codes, fetch its files and `packageSave`
them (or point `packageInstall` at the repository); the manifest and runtime
contracts are the same.

## npm dependencies

Bare imports inside a run or package (`import ms from 'ms@2.1.3'`) are
resolved through an esm.sh-compatible CDN at graph-build time, cached in the
durable `NpmCacheCell` and inlined into the isolate. See [npm.md](./npm.md)
for configuration, the self-hosted CDN overlay and limits.
