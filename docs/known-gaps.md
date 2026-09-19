# Known gaps and deferred features

## Deferred by design (out of v1 scope)

| Production Kody feature                                         | kody-celld                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Memories / Vectorize semantic search                            | Not present. celld has no vector index; a future option is sqlite-vec inside a DO or an external store.                                       |
| Workers AI / AI Gateway (`kody.ai*`)                            | Not present. Bring your own model via `fetch` + `{{secret:...}}` to an approved host.                                                         |
| Email Routing / inboxes                                         | Not present.                                                                                                                                  |
| OAuth connectors, `{{integration-token:...}}`                   | Placeholder is parsed but the gateway denies it with `placeholder_kind_unsupported`. Only `{{secret:...}}` and `{{secret-basic:...}}` inject. |
| `{{secret/provider:...}}` scoped provider secrets               | Same: parsed, denied as deferred.                                                                                                             |
| Web UI / Remix app, sign-in, OAuth for MCP                      | None. Users are created by an admin; MCP auth is a static bearer token.                                                                       |
| Published package registry (`kody.packagePublish`, marketplace) | Packages are per-user only. "Load a published package" is done by saving its files (`packageSave`) — the manifest format is the same.         |
| Queues, Workflows, Browser Rendering, R2, D1, KV                | Not used; the core needs only DOs. celld supports KV/D1/Queues if a later capability needs them.                                              |
| Webhooks (inbound)                                              | Not present.                                                                                                                                  |
| Multi-tenant SaaS controls (quotas, billing)                    | Not present. Per-user isolation exists; quotas do not.                                                                                        |

## Known limitations of what _is_ implemented

- **npm imports are experimental.** Bare specifiers are resolved through
  esm.sh at run time and inlined (≤ 40 modules / 6 MiB). It works for pure ESM
  packages (`ms`, `date-fns`…) and fails clearly for packages needing Node
  built-ins beyond `nodejs_compat` or for large graphs. There is no lockfile or
  pinning beyond the version in the specifier; the module cache is per-node
  memory.
- **Master key rotation** is not implemented. Secrets are encrypted under a
  key derived from the single `KODY_MASTER_KEY`; changing it orphans existing
  values.
- **Job timezones** apply to `cron` schedules only (IANA via `Intl`); `interval`
  is anchored to the previous run (or first evaluation), not to wall-clock
  boundaries.
- **Run history** keeps the newest 500 runs per user; logs are truncated to
  200 entries and oversized results are truncated with `truncated: true`.
- **`execute` timeout** is a fixed 60 s per run; jobs use the same limit.
- **Isolate reuse** is keyed by `(user, module graph hash)` per node. Module
  state (top-level variables) survives between runs on the same node; do not
  rely on it and do not rely on it being cleared.
- **Search** is lexical (token overlap + prefix boosts) over the capability
  catalog, guides and package names — good enough for a client that knows what
  it wants, not a semantic index.
- **Admin API** is token-only with no audit log beyond node stdout.
- **Fleet path is documented but unverified** — see
  [run-fleet.md](./run-fleet.md#not-verified-in-this-experiment).

## celld-specific caveats

- Import resolution in Worker Loader isolates is exact-name; the module graph
  rewrites everything to `./<full path>`. Packages that build specifiers
  dynamically (`import(\`./${x}.js\`)`) are not rewritten and will fail.
- Worker Loader accepts only JS source and wasm; JSON is converted to
  `export default`, and non-code assets (README/AGENTS, images) are not
  available to running code.
- RPC error objects arrive as plain `Error` with `name`/`message`; `KodyError`
  round-trips its code and status through `name`.
- `celld deploy` refuses `main` outside the config directory, so the rendered
  fleet config must sit beside `wrangler.jsonc`.
