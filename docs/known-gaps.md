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

| Capability                                     | Self-hosted built-in                                                                    | Adapter(s)                                                                                     | Status                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| MCP `search` + `execute`                       | celld Worker + Worker Loader isolates                                                   | —                                                                                              | **Built-in**, smoke-tested       |
| Packages (save / run / import)                 | per-user SQLite cells, `kody:` imports, `packageStorage()`                              | —                                                                                              | **Built-in**, smoke-tested       |
| Secrets + host-gated injection                 | AES-GCM store, `FetchGateway`, admin host approvals                                     | —                                                                                              | **Built-in**, smoke-tested       |
| Master-key rotation                            | `KODY_MASTER_KEY_PREVIOUS` + `POST /admin/secrets/rekey` ([secrets.md](./secrets.md))   | —                                                                                              | **Built-in**, smoke-tested       |
| Jobs (cron / interval / once)                  | celld cron trigger → per-user dispatcher                                                | —                                                                                              | **Built-in**, smoke-tested       |
| Durability / multi-node                        | celld fleet on any S3-compatible bucket                                                 | MinIO (bundled), AWS S3, R2, GCS, Azure Blob, … ([getting-started.md](./getting-started.md))   | **Built-in + adapter**, tested   |
| Docker / NAS run path                          | `Dockerfile`, `compose.yaml`, `compose.fleet.yaml`, `compose.minio.yaml`, Caddy         | any reverse proxy for TLS                                                                      | **Built-in**, tested             |
| npm imports inside `execute`                   | per-node module cache (memory)                                                          | esm.sh (default); self-hostable esm CDN adapter                                                | Experimental; durable cache M8   |
| Configurable timeouts / retention              | `KODY_EXECUTE_TIMEOUT_MS`, `KODY_RUN_RETENTION_*`, … ([operations.md](./operations.md)) | —                                                                                              | **Built-in**, smoke-tested       |
| Per-user quotas + `usageGet`                   | env defaults + `PUT /admin/users/:id/quota`, `usageGet` capability                      | —                                                                                              | **Built-in**, smoke-tested       |
| Admin audit log                                | registry-cell log, `GET /admin/audit` (names/ids only, never values)                    | —                                                                                              | **Built-in**, smoke-tested       |
| AI (`aiChat`, `aiEmbed`, `aiStatus`)           | — (bring a model server; `compose.ai.yaml` bundles Ollama)                              | OpenAI-compatible (Ollama, LM Studio, vLLM, OpenRouter, OpenAI…), Anthropic ([ai.md](./ai.md)) | **Adapter**, smoke-tested        |
| Memories (`metaMemory*`) + semantic search     | per-user `MemoryCell`: SQLite + FTS5 + sqlite-vec vectors, RRF hybrid ranking           | Qdrant vector store; optional LLM re-rank via the chat adapter ([ai.md](./ai.md))              | **Built-in + adapter**, tested   |
| Blob storage (`blob*`)                         | celld R2 binding `BLOBS` (local store / `r2/` prefix of the fleet bucket), signed links | any S3-compatible bucket via `KODY_BLOB_PROVIDER=s3` ([blobs.md](./blobs.md))                  | **Built-in + adapter**, tested   |
| Browser rendering (`browser*`)                 | — (bring Chromium; `compose.browser.yaml` bundles browserless)                          | browserless (self-hosted), Cloudflare Browser Rendering ([browser.md](./browser.md))           | **Adapter**, smoke-tested        |
| Rich MCP results (images/audio from `execute`) | `__mcpContent` blocks validated + size-capped, summarized in run history                | —                                                                                              | **Built-in**, smoke-tested       |
| Email inbound                                  | `mail-bridge` SMTP sidecar                                                              | generic JSON, Postmark, Mailgun, SendGrid, Cloudflare Email Worker forwarder                   | Planned (M5)                     |
| Email outbound                                 | via `mail-bridge` / SMTP                                                                | Resend, Postmark, Mailgun, SendGrid                                                            | Planned (M5)                     |
| Inbound webhooks (package-owned)               | mint / rotate / deliveries in the user cell                                             | —                                                                                              | Planned (M5)                     |
| OAuth integrations, `{{integration-token:…}}`  | connector flow + token refresh in the user cell                                         | bring-your-own OAuth app per provider                                                          | Planned (M6); parsed, denied now |
| `{{secret/provider:…}}` scoped secrets         | provider packages bound per user                                                        | —                                                                                              | Planned (M6); parsed, denied now |
| MCP auth for clients                           | OAuth 2.1 authorization server (DCR + PKCE)                                             | —                                                                                              | Planned (M7); static bearer now  |
| Sign-in + web UI                               | magic-link / invite sign-in, minimal account UI                                         | —                                                                                              | Planned (M7); admin API only     |
| Package registry / install from URL            | local publish/install registry, GitHub/URL install                                      | —                                                                                              | Planned (M8); `packageSave` now  |
| Queues, Workflows, KV, D1                      | available in celld                                                                      | —                                                                                              | Not needed by the core yet       |

## Roadmap (sequential PRs)

- **M1** Docker + compose (single node, fleet), getting-started docs, verified two-node fleet — _done_.
- **M2** Hardening: master-key rotation, configurable timeouts/retention, quotas + `usageGet`, admin audit log — _done_.
- **M3** AI adapter, memories with FTS + embeddings, Qdrant adapter, semantic search re-rank — _done_.
- **M4** Blob storage (R2 binding + S3 adapter, signed links), browser rendering adapters, MCP image blocks — _done_.
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
- **Run history** keeps the newest 500 runs per user (and optionally drops
  runs older than N days); logs are capped at 200 entries and oversized results
  are truncated with `truncated: true`. All of these are operator settings, see
  [operations.md](./operations.md).
- **`execute` timeout** defaults to 60 s per run and applies to jobs too
  (`KODY_EXECUTE_TIMEOUT_MS`, 1 s – 15 min).
- **Quotas** default to unlimited; a shared node should set
  `KODY_QUOTA_RUNS_PER_DAY` and friends. The daily execute-time budget is
  checked before a run starts, so the final run of the day may overshoot it.
- **Isolate reuse** is keyed by `(user, module graph hash)` per node. Module
  state (top-level variables) survives between runs on the same node; do not
  rely on it and do not rely on it being cleared.
- **Search** is lexical (token overlap + prefix boosts) over the capability
  catalog, guides and package names unless an embedding provider is configured;
  then it is hybrid (RRF of lexical + cosine) with optional LLM re-rank of the
  top 12. Semantic failures degrade to lexical with a `warnings` entry.
- **AI providers are operator-wide**, not per user: one chat/embedding endpoint
  and key per deployment (`KODY_AI_*`). Per-user model keys go through
  `{{secret:…}}` placeholders in package code instead. Changing the embedding
  model re-embeds memories lazily (32 per search) or eagerly via
  `POST /admin/users/:id/memories/reindex`.
- **Vector stores**: sqlite-vec keeps vectors in the user's cell (chunk size
  derived from the dimension to fit celld's SQLite value cap); Qdrant is one
  shared collection filtered by `userId`. Local vectors were exercised up to
  768 dimensions (Ollama `nomic-embed-text`); very large dimensions (≥ 4096)
  work but shrink the vec0 chunk to 32–64 rows.
- **Blob storage** keeps the index (and quotas) in the user's cell and the
  bytes in the R2 binding or the S3 adapter; there is no reconciliation job, so
  objects written to the bucket by other tools are invisible to `blobList`.
  Inline `blobGet` stops at 5 MB (use `blobUrl`/`/api/blobs`); uploads are
  buffered in memory up to `KODY_BLOB_MAX_BYTES` (25 MiB default). Signed links
  are HMAC-based and tied to the master key: rotating it invalidates them.
- **Browser rendering** is an operator-wide service, not per user, and the
  SSRF guard checks the literal URL only (no DNS resolution): keep the browser
  on an isolated network (as the compose overlay does) if untrusted users may
  render arbitrary URLs. Browser requests bypass the secrets gateway by design.
- **Admin API** is a single static bearer token (per-operator identities and
  OAuth: M7); its actions are recorded in the audit log as actor `admin`.
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
