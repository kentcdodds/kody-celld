# Provision matrix

Production Kody leans on Cloudflare products. kody-celld replaces each one with
a **self-hosted built-in**, an **adapter** for whatever service you already
have, or both — nothing is written off as "Cloudflare-only". This page is the
per-feature status: what runs today, what the plan is for the rest, and where
the caveats of the current implementation are.

Status legend: **Built-in** ships in this repo and runs on your nodes;
**Adapter** talks to a service you provision; **Planned (Mx)** is the milestone
it is scheduled for in the roadmap below.

## Matrix

| Capability                                    | Self-hosted built-in                                                                  | Adapter(s)                                                                                   | Status                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------- |
| MCP `search` + `execute`                      | celld Worker + Worker Loader isolates                                                 | —                                                                                            | **Built-in**, smoke-tested       |
| Packages (save / run / import)                | per-user SQLite cells, `kody:` imports, `packageStorage()`                            | —                                                                                            | **Built-in**, smoke-tested       |
| Secrets + host-gated injection                | AES-GCM store, `FetchGateway`, admin host approvals                                   | —                                                                                            | **Built-in**, smoke-tested       |
| Master-key rotation                           | `KODY_MASTER_KEY_PREVIOUS` + `POST /admin/secrets/rekey` ([secrets.md](./secrets.md)) | —                                                                                            | **Built-in**, smoke-tested       |
| Jobs (cron / interval / once)                 | celld cron trigger → per-user dispatcher                                              | —                                                                                            | **Built-in**, smoke-tested       |
| Durability / multi-node                       | celld fleet on any S3-compatible bucket                                               | MinIO (bundled), AWS S3, R2, GCS, Azure Blob, … ([getting-started.md](./getting-started.md)) | **Built-in + adapter**, tested   |
| Docker / NAS run path                         | `Dockerfile`, `compose.yaml`, `compose.fleet.yaml`, `compose.minio.yaml`, Caddy       | any reverse proxy for TLS                                                                    | **Built-in**, tested             |
| npm imports inside `execute`                  | per-node module cache (memory)                                                        | esm.sh (default); self-hostable esm CDN adapter                                              | Experimental; durable cache M8   |
| Configurable timeouts / retention             | —                                                                                     | —                                                                                            | Planned (M2)                     |
| Per-user quotas + `usageGet`                  | —                                                                                     | —                                                                                            | Planned (M2)                     |
| Admin audit log                               | —                                                                                     | —                                                                                            | Planned (M2)                     |
| AI (`kody.ai*`)                               | —                                                                                     | OpenAI-compatible (Ollama, LM Studio, OpenAI, OpenRouter…), Anthropic                        | Planned (M3)                     |
| Memories (`metaMemory*`) + semantic search    | SQLite FTS + local embedding vectors                                                  | Qdrant (or any vector store) behind the same interface                                       | Planned (M3)                     |
| Blob storage                                  | R2-shaped bucket binding on the celld bucket                                          | any S3-compatible bucket                                                                     | Planned (M4)                     |
| Browser rendering                             | —                                                                                     | browserless container (compose overlay) or any remote CDP endpoint                           | Planned (M4)                     |
| Email inbound                                 | `mail-bridge` SMTP sidecar                                                            | generic JSON, Postmark, Mailgun, SendGrid, Cloudflare Email Worker forwarder                 | Planned (M5)                     |
| Email outbound                                | via `mail-bridge` / SMTP                                                              | Resend, Postmark, Mailgun, SendGrid                                                          | Planned (M5)                     |
| Inbound webhooks (package-owned)              | mint / rotate / deliveries in the user cell                                           | —                                                                                            | Planned (M5)                     |
| OAuth integrations, `{{integration-token:…}}` | connector flow + token refresh in the user cell                                       | bring-your-own OAuth app per provider                                                        | Planned (M6); parsed, denied now |
| `{{secret/provider:…}}` scoped secrets        | provider packages bound per user                                                      | —                                                                                            | Planned (M6); parsed, denied now |
| MCP auth for clients                          | OAuth 2.1 authorization server (DCR + PKCE)                                           | —                                                                                            | Planned (M7); static bearer now  |
| Sign-in + web UI                              | magic-link / invite sign-in, minimal account UI                                       | —                                                                                            | Planned (M7); admin API only     |
| Package registry / install from URL           | local publish/install registry, GitHub/URL install                                    | —                                                                                            | Planned (M8); `packageSave` now  |
| Queues, Workflows, KV, D1                     | available in celld                                                                    | —                                                                                            | Not needed by the core yet       |

## Roadmap (sequential PRs)

- **M1** Docker + compose (single node, fleet), getting-started docs, verified two-node fleet — _done_.
- **M2** Hardening: master-key rotation (_done_), configurable timeouts/retention, quotas + `usageGet`, admin audit log.
- **M3** AI adapter, memories with FTS + embeddings, Qdrant adapter, semantic search re-rank.
- **M4** Blob storage on the celld bucket, browser rendering adapter.
- **M5** Email inbound/outbound adapters, `mail-bridge` sidecar, package inbound webhooks.
- **M6** OAuth integrations (`{{integration-token:…}}`), provider-scoped secrets (`{{secret/provider:…}}`).
- **M7** MCP OAuth 2.1 authorization server, sign-in, minimal web UI.
- **M8** Package registry, install from URL/GitHub, durable npm cache + self-hostable esm CDN adapter.

## Caveats of what is implemented today

- **npm imports are experimental.** Bare specifiers are resolved through
  esm.sh at run time and inlined (≤ 40 modules / 6 MiB). It works for pure ESM
  packages (`ms`, `date-fns`…) and fails clearly for packages needing Node
  built-ins beyond `nodejs_compat` or for large graphs. There is no lockfile or
  pinning beyond the version in the specifier; the module cache is per-node
  memory (durable cache: M8).
- **Job timezones** apply to `cron` schedules only (IANA via `Intl`); `interval`
  is anchored to the previous run (or first evaluation), not to wall-clock
  boundaries.
- **Run history** keeps the newest 500 runs per user; logs are truncated to
  200 entries and oversized results are truncated with `truncated: true`
  (configurable retention: M2).
- **`execute` timeout** is a fixed 60 s per run; jobs use the same limit
  (configurable: M2).
- **Isolate reuse** is keyed by `(user, module graph hash)` per node. Module
  state (top-level variables) survives between runs on the same node; do not
  rely on it and do not rely on it being cleared.
- **Search** is lexical (token overlap + prefix boosts) over the capability
  catalog, guides and package names (semantic re-rank: M3).
- **Admin API** is token-only with no audit log beyond node stdout (M2).
- **Fleet verification** covered two containers on one Docker host with MinIO;
  see [run-fleet.md](./run-fleet.md#verified-and-not-verified) for what was and was
  not exercised.

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
