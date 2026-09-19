# Provision matrix

Production Kody leans on Cloudflare products. kody-celld replaces each one with
a **self-hosted built-in**, an **adapter** for whatever service you already
have, or both — nothing is written off as "Cloudflare-only". This page is the
per-feature status: what runs today, what the plan is for the rest, and where
the caveats of the current implementation are.

Status legend: **Built-in** ships in this repo and runs on your nodes;
**Adapter** talks to a service you provision. Every row of the original
roadmap is now shipped; the roadmap below is kept as the change log.

## Matrix

| Capability                                     | Self-hosted built-in                                                                                                                                                                        | Adapter(s)                                                                                                                 | Status                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| MCP `search` + `execute`                       | celld Worker + Worker Loader isolates                                                                                                                                                       | —                                                                                                                          | **Built-in**, smoke-tested     |
| Packages (save / run / import)                 | per-user SQLite cells, `kody:` imports, `packageStorage()`                                                                                                                                  | —                                                                                                                          | **Built-in**, smoke-tested     |
| Secrets + host-gated injection                 | AES-GCM store, `FetchGateway`, admin host approvals                                                                                                                                         | —                                                                                                                          | **Built-in**, smoke-tested     |
| Master-key rotation                            | `KODY_MASTER_KEY_PREVIOUS` + `POST /admin/secrets/rekey` ([secrets.md](./secrets.md))                                                                                                       | —                                                                                                                          | **Built-in**, smoke-tested     |
| Jobs (cron / interval / once)                  | celld cron trigger → per-user dispatcher                                                                                                                                                    | —                                                                                                                          | **Built-in**, smoke-tested     |
| Durability / multi-node                        | celld fleet on any S3-compatible bucket                                                                                                                                                     | MinIO (bundled), AWS S3, R2, GCS, Azure Blob, … ([getting-started.md](./getting-started.md))                               | **Built-in + adapter**, tested |
| Docker / NAS run path                          | `Dockerfile`, `compose.yaml`, `compose.fleet.yaml`, `compose.minio.yaml`, Caddy                                                                                                             | any reverse proxy for TLS                                                                                                  | **Built-in**, tested           |
| npm imports inside `execute`                   | fleet-wide durable module cache (`NpmCacheCell`, LRU + TTL, `/admin/npm-cache`) + per-node memo ([npm.md](./npm.md))                                                                        | any esm.sh-compatible CDN via `KODY_ESM_CDN_URL` (esm.sh default; `compose.esm.yaml` self-hosts one)                       | **Built-in + adapter**, tested |
| Configurable timeouts / retention              | `KODY_EXECUTE_TIMEOUT_MS`, `KODY_RUN_RETENTION_*`, … ([operations.md](./operations.md))                                                                                                     | —                                                                                                                          | **Built-in**, smoke-tested     |
| Per-user quotas + `usageGet`                   | env defaults + `PUT /admin/users/:id/quota`, `usageGet` capability                                                                                                                          | —                                                                                                                          | **Built-in**, smoke-tested     |
| Admin audit log                                | registry-cell log, `GET /admin/audit` (names/ids only, never values)                                                                                                                        | —                                                                                                                          | **Built-in**, smoke-tested     |
| AI (`aiChat`, `aiEmbed`, `aiStatus`)           | — (bring a model server; `compose.ai.yaml` bundles Ollama)                                                                                                                                  | OpenAI-compatible (Ollama, LM Studio, vLLM, OpenRouter, OpenAI…), Anthropic ([ai.md](./ai.md))                             | **Adapter**, smoke-tested      |
| Memories (`metaMemory*`) + semantic search     | per-user `MemoryCell`: SQLite + FTS5 + sqlite-vec vectors, RRF hybrid ranking                                                                                                               | Qdrant vector store; optional LLM re-rank via the chat adapter ([ai.md](./ai.md))                                          | **Built-in + adapter**, tested |
| Blob storage (`blob*`)                         | celld R2 binding `BLOBS` (local store / `r2/` prefix of the fleet bucket), signed links                                                                                                     | any S3-compatible bucket via `KODY_BLOB_PROVIDER=s3` ([blobs.md](./blobs.md))                                              | **Built-in + adapter**, tested |
| Browser rendering (`browser*`)                 | — (bring Chromium; `compose.browser.yaml` bundles browserless)                                                                                                                              | browserless (self-hosted), Cloudflare Browser Rendering ([browser.md](./browser.md))                                       | **Adapter**, smoke-tested      |
| Rich MCP results (images/audio from `execute`) | `__mcpContent` blocks validated + size-capped, summarized in run history                                                                                                                    | —                                                                                                                          | **Built-in**, smoke-tested     |
| Email inbound                                  | `mail-bridge` SMTP sidecar (`compose.mail.yaml`) → `/email/inbound/bridge`                                                                                                                  | generic JSON / rfc822, Postmark, Mailgun, SendGrid, Cloudflare Email Worker forwarder ([email.md](./email.md))             | **Built-in + adapter**, tested |
| Email outbound                                 | `mail-bridge` `POST /send` → your SMTP relay or direct MX                                                                                                                                   | Resend, Postmark, Mailgun, SendGrid (+ delivery-event webhooks) ([email.md](./email.md))                                   | **Built-in + adapter**, tested |
| Inbound webhooks (package-owned)               | `/webhooks/:userId/:handle/:secret`, in-cell HMAC + replay, mint/rotate/deliveries                                                                                                          | `webhookUrlApply` registers the URL with GitHub or any HTTP API ([webhooks.md](./webhooks.md))                             | **Built-in**, smoke-tested     |
| OAuth integrations, `{{integration-token:…}}`  | PKCE connect flow, encrypted tokens, host-side refresh + 401 replay in the user cell                                                                                                        | bring-your-own OAuth app per provider (`authorization_code` / `client_credentials`) ([integrations.md](./integrations.md)) | **Built-in + adapter**, tested |
| `{{secret/provider:…}}` scoped secrets         | provider packages run sealed, values injected only at the gateway; lock/grant per item                                                                                                      | any vault via a `kody.secretProvider` package (1Password Connect example) ([secret-providers.md](./secret-providers.md))   | **Built-in + adapter**, tested |
| MCP auth for clients                           | OAuth 2.1 authorization server: RFC 8414/9728 discovery, DCR, PKCE S256, refresh rotation + replay detection, RFC 7009 ([mcp-oauth.md](./mcp-oauth.md))                                     | — (static `kody_…` tokens still accepted)                                                                                  | **Built-in**, smoke-tested     |
| Sign-in + web UI                               | password / invite / reset / magic-link sign-in, account pages, operator console ([web-ui.md](./web-ui.md))                                                                                  | magic links ride on whichever outbound email adapter is configured                                                         | **Built-in**, smoke-tested     |
| Install packages from GitHub / URL             | `packageInstall` + `packageUpdate`: `github:owner/repo[/dir][#ref]`, tarball or JSON file-map URLs, host allowlist + SSRF guard ([packages.md](./packages.md#install-from-github-or-a-url)) | any host the operator lists in `KODY_PACKAGE_SOURCE_HOSTS` (Gitea/Forgejo/GitLab on the LAN included)                      | **Built-in**, smoke-tested     |
| Community package catalog                      | node-local registry in the registry cell: publish/unpublish, search, install/fork/update, public `/community` pages ([community.md](./community.md))                                        | —                                                                                                                          | **Built-in**, smoke-tested     |
| Queues, Workflows, KV, D1                      | available in celld                                                                                                                                                                          | —                                                                                                                          | Not needed by the core yet     |

## Roadmap (sequential PRs)

- **M1** Docker + compose (single node, fleet), getting-started docs, verified two-node fleet — _done_.
- **M2** Hardening: master-key rotation, configurable timeouts/retention, quotas + `usageGet`, admin audit log — _done_.
- **M3** AI adapter, memories with FTS + embeddings, Qdrant adapter, semantic search re-rank — _done_.
- **M4** Blob storage (R2 binding + S3 adapter, signed links), browser rendering adapters, MCP image blocks — _done_.
- **M5** Email inbound/outbound adapters, `mail-bridge` sidecar, package inbound webhooks — _done_.
- **M6** OAuth integrations (`{{integration-token:…}}`), provider-scoped secrets (`{{secret/provider:…}}`) — _done_.
- **M7** MCP OAuth 2.1 authorization server, sign-in, minimal web UI — _done_.
- **M8** Community package catalog, install from URL/GitHub, durable npm cache + self-hostable esm CDN adapter — _done_.

## Caveats of what is implemented today

- **npm imports** resolve bare specifiers through an esm.sh-compatible CDN at
  graph-build time and inline the result (≤ 40 modules / 6 MiB). Pure ESM
  packages (`ms`, `date-fns`…) work; packages needing Node built-ins beyond
  `nodejs_compat` or huge graphs fail clearly. There is no lockfile: pin the
  version in the specifier (`'ms@2.1.3'`). Fetched modules live in the durable
  `NpmCacheCell` (default 256 MiB / 30 days, LRU) so a fleet only asks the CDN
  once; an unpinned specifier is re-resolved when its cache entry expires.
- **Installing from GitHub / URLs** downloads on the server: the host must be
  on `KODY_PACKAGE_SOURCE_HOSTS` (GitHub by default), private/LAN hosts need an
  exact allowlist entry, and the guard checks hostnames, not resolved IPs — a
  public name pointing at a private address is only stopped by your network.
  There is no signature/checksum verification of what is downloaded.
- **The community catalog is per deployment** (one node or fleet), first
  publisher owns a name, and listings are a copy of the files at publish time.
  There is no cross-deployment federation, moderation queue or malware
  scanning: installing a community package means running someone else's code
  under your account, exactly like `packageSave`.
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
- **Email** is operator-configured per deployment (one domain, one outbound
  adapter); inbound authentication is the shared `KODY_EMAIL_INBOUND_TOKEN`
  plus Mailgun's signature when configured, so keep the inbound routes behind
  TLS. The `mail-bridge` does not do spam filtering, DKIM signing or greylisting
  itself: relay through a provider (or put a filtering MTA in front) for
  anything beyond personal use; direct MX delivery from residential IPs is
  often refused. Stored HTML is kept verbatim (capped), not sanitized for
  display — clients rendering it should treat it as untrusted.
- **Webhooks** verify HMAC-SHA256 only (the scheme GitHub, Stripe, Slack,
  Shopify and most providers use); providers with asymmetric signatures (e.g.
  Svix/Standard Webhooks Ed25519) can still be received unsigned behind the
  opaque URL. The rate limit and idempotency ledger live in the user's cell, so
  they are per user, not per node.
- **Admin API / console** is a single shared operator token (there are no
  per-operator identities); its actions are recorded in the audit log as actor
  `admin` (`via: 'console'` when driven from the web UI).
- **OAuth server** has no per-capability scopes (one grant = the whole
  assistant, like production Kody), no OpenID Connect ID tokens (only
  `/oauth/userinfo`), and no third-party identity providers for the sign-in
  page itself — accounts are local (password / invite / magic link). Consent
  is per client, not remembered across clients.
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
