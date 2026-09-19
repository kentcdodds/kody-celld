# Architecture

kody-celld is one Worker plus four Durable Object classes and two Worker
Entrypoints, all in a single `celld` deployment. Everything a user does enters
through MCP (`/mcp`) or the equivalent direct API (`/api/call/:capability`);
operators use `/admin/*` with the admin token.

```
                ┌──────────────────────────── celld node(s) ────────────────────────────┐
 MCP client ──► │ src/index.ts (Worker)                                                 │
  Bearer token  │   /mcp  ─► mcp/server.ts ─► search | execute                          │
                │   /api  ─► capabilities (host-side call)                              │
 admin ───────► │   /admin ─► users, tokens, secret hosts, jobs, runs, quotas, audit    │
                │   cron * * * * * ─► jobs/dispatcher.ts                                 │
                │                                                                       │
                │   RegistryCell (DO, 1)     users + hashed API tokens, audit log,      │
                │                            OAuth clients/sessions, community catalog  │
                │   UserCell (DO, per user)  packages, secrets (encrypted), hosts,      │
                │                            jobs, runs, gateway events, daily usage    │
                │   PackageStorageCell (DO, per user×package)  KV + free-form SQLite    │
                │   MemoryCell (DO, per user)  memories + FTS5, sqlite-vec vectors,     │
                │                              embedding cache ──► AI adapter / Qdrant   │
                │   NpmCacheCell (DO, 1)     npm modules by URL (LRU + TTL) ◄─ ESM CDN   │
                │                                                                       │
                │   execute ─► module graph ─► LOADER.get(hash) ──► isolate             │
                │        env.KODY = RuntimeHost({props})      ◄─ kody.<capability>()    │
                │        globalOutbound = FetchGateway({props}) ◄─ fetch()  ─► internet │
                └───────────────────────────────────────────────────────────────────────┘
                                          ▲ S3-compatible bucket (celld durability)
```

## Request lifecycle: `execute`

1. `POST /mcp` → JSON-RPC `tools/call` `execute` with `{ source, params?, idempotencyKey? }`.
2. `authenticateUser` resolves the bearer token in `RegistryCell` and gets the
   caller's `UserCell` stub.
3. `executeRun` (`src/execute/engine.ts`) records a `run` row (idempotency
   replay happens here), then `buildModuleGraph` produces a flat module map:
   - the caller's source becomes `main.js` wrapped by `wrapper-module.ts`
     (console capture, `AsyncLocalStorage` run context, result serialisation);
   - `kody:runtime` is the host-owned source string in `runtime-module.ts`;
   - `kody:@scope/pkg/export` pulls saved package files from `UserCell`,
     stamps `packageStorage()` with the declaring package name, rewrites every
     relative import to `./<full path>`, converts JSON to ES modules and drops
     docs;
   - bare npm specifiers are fetched from an esm.sh-compatible CDN
     (`KODY_ESM_CDN_URL`), cached in `NpmCacheCell` and inlined
     ([npm.md](./npm.md)).
4. `env.LOADER.get(hash(user, modules))` creates or reuses an isolate whose
   only bindings are `KODY` (a `RuntimeHost` Worker Entrypoint with
   `props = { userId, email, packageName }`) and `globalOutbound`
   (`FetchGateway`, same props). The isolate has **no** access to the host
   `Env`, other users, or the network except through those two.
5. The wrapper runs `default(params)`, captures logs, and posts
   `{ result | error, logs }` back. `engine.ts` finalises the run row and
   returns `{ runId, ok, result, logs, warnings, gateway, packages }`.

`kody.<capability>(args)` inside the isolate is a Proxy that RPCs
`RuntimeHost.capability(name, args, { runId, packageName })`. `RuntimeHost`
rebuilds a `CapabilityContext` with `fromRuntime: true`, so host-only
capabilities (e.g. `packageRun`, host approval) refuse sandbox callers.

## Secrets at the boundary

Outbound `fetch()` in an isolate goes to `FetchGateway.fetch` on the host:

1. Scan URL, headers and body for placeholders (`src/secrets/placeholders.ts`).
2. No placeholders → forward as-is, record `outcome: 'forwarded'`.
3. Placeholders → check the destination host against the user's approved list
   (`host-policy.ts`, exact or `*.example.com`), require HTTPS unless the host
   is a configured loopback dev host, decrypt referenced secrets, replace,
   forward, record `outcome: 'injected'` with secret **names** only.
4. Any failure → `outcome: 'denied'` and a synthetic 403/404 JSON response;
   nothing leaves the box.

Values are encrypted in `UserCell` with AES-GCM under an HKDF key derived from
`KODY_MASTER_KEY` and the user id (`src/lib/crypto.ts`). Each row records the
16-hex `key_id` of the master key that sealed it; retired keys stay readable
via `KODY_MASTER_KEY_PREVIOUS` until `POST /admin/secrets/rekey` has re-sealed
every row (see [secrets.md](./secrets.md#master-key-rotation)).

Two more placeholder kinds resolve in the same `FetchGateway.fetch` call, so
there is still exactly one place where values meet requests:

- `{{integration-token:<name>}}` — `src/integrations/store.ts` (inside
  `UserCell`) keeps OAuth client secrets and access/refresh tokens in the same
  encrypted-column shape as secrets, runs the PKCE connect flow
  (`src/integrations/connect.ts`, routes `/connect/oauth/*`) and refreshes
  tokens host-side; the gateway checks the integration's own `allowedHosts`
  and usage grant, injects, and on a 401 refreshes once and replays.
  [integrations.md](./integrations.md).
- `{{secret/<provider>:<ref>}}` — `src/secrets/provider-store.ts` binds a
  provider id to a saved package declaring `kody.secretProvider`. The gateway
  runs that package's `./secretProvider` export through `executeRun` with
  `sealed: true` (no result/logs persisted; `module-graph.ts` refuses the entry
  as a direct run or import target), caches the `{ value, hosts, canonicalRef }`
  in cell memory, enforces item hosts and per-package grants, then injects.
  The provider reaches its vault with an ordinary `{{secret:<door>}}`.
  [secret-providers.md](./secret-providers.md).

## Jobs

`package.json#kody.jobs` is validated on `packageSave` (`src/packages/manifest.ts`,
`src/jobs/schedule.ts`) and reconciled into `UserCell.jobs`. celld's cron
trigger calls `scheduled()` every minute → `dispatchDueJobs` iterates users,
asks each `UserCell` to atomically claim due jobs (advancing `next_run_at`
before running so a crash cannot double-fire), then executes the entry via
`executeRun` with `kind: 'job'` and records a `job_run`.

## Durable Objects

| Class                | Key                      | Holds                                                                                                                                                                                                                                  |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RegistryCell`       | `"registry"` (singleton) | users, SHA-256 token hashes → user id, admin audit log, password hashes + lockout, browser sessions (hashed), one-time sign-in tokens (hashed), OAuth clients / codes / grants / tokens (hashed, refresh families)                     |
| `UserCell`           | user id                  | packages (files + manifest), secrets (ciphertext), approved hosts, jobs, job runs, runs, gateway events, per-UTC-day usage, quota override, blob index, integrations + connect tickets (ciphertext), secret provider bindings + grants |
| `PackageStorageCell` | `${userId}:${package}`   | `__kody_kv` table + whatever tables package `sql()` creates                                                                                                                                                                            |
| `MemoryCell`         | user id                  | memories, `memories_fts` (FTS5), suppressions, embedding cache, `memory_vectors` (sqlite-vec, local provider)                                                                                                                          |

All state is SQLite inside the DO; celld replicates it to the bucket. The only
other binding is the R2-compatible `BLOBS` bucket for blob bytes (stored under
`r2/kody-blobs/` in the same fleet bucket), so the footprint stays "DOs +
bucket"; no KV/D1/Queues are used.

## Blobs and browser rendering

`src/blobs/store.ts` defines a small `BlobStore` interface (put/get/head/
delete/list) with two implementations: the celld R2 binding (default) and a
SigV4 S3 client over `fetch` (`src/blobs/s3.ts`). `BlobService` sits on top:
key normalization (`src/blobs/keys.ts`), the per-user `users/<id>/` prefix,
SHA-256 hashing, quota reservation and the index in `UserCell`, and HMAC-signed
download links (HKDF from the master key + user id) served by the Worker at
`/blobs/:userId/:key`. Capabilities (`blob*`) and the raw routes under
`/api/blobs/` share the service; sandbox code never receives a bucket client or
credentials. [blobs.md](./blobs.md).

`src/browser/providers.ts` wraps browserless and Cloudflare Browser Rendering
behind one `BrowserRenderer` (content/screenshot/pdf) and hosts `assertRenderableUrl`,
the SSRF guard. Screenshots become MCP `image` blocks through the
`__mcpContent` convention in `src/mcp/content.ts`: `executeRun` extracts and
validates the blocks, the MCP server emits them ahead of the JSON text block,
and run history keeps only a size summary. [browser.md](./browser.md).

## Email and webhooks

Both are HTTP-boundary features of the Worker (`src/index.ts` routes
`/webhooks/*`, `/email/inbound/*`, `/email/events/*`) that end in an ordinary
`executeRun` with package provenance, so package code sees the same
`packageStorage()` / `{{secret:…}}` world as a job or an MCP call.

`src/webhooks/ingress.ts` resolves `/webhooks/:userId/:handle/:secret`, asks
the `UserCell` to admit the delivery (constant-time secret compare against the
current and — during rotation — previous secret, enabled flag, rate limit),
verifies HMAC signatures **inside the cell** (`webhookSignatureCheck`, so the
stored secret never crosses RPC), applies replay/idempotency rules, records the
delivery and runs the declared export with `kind: 'webhook'`. Credentials are
revealed only by `GET /api/webhooks/:handle/url` (audited); `webhookUrlApply`
pushes them to a provider through the secrets gateway as a `{{webhookUrl}}`
placeholder so neither the client nor package code needs to read them.
[webhooks.md](./webhooks.md).

`src/email/inbound.ts` turns each provider's payload (JSON, multipart form or
raw `message/rfc822` via `postal-mime`) into one `InboundEmail`;
`src/email/service.ts` authenticates the request with the deployment inbound
token, routes recipients to inbox owners through the `RegistryCell`
(`inbox_locals`, plus-addressing), classifies by sender rules, stores in the
`UserCell` (`email_messages`, `email_attachments`) and dispatches
`email.message.*` subscriptions. `src/email/outbound.ts` builds provider
requests (bridge, Resend, Postmark, Mailgun, SendGrid) with the operator token
attached host-side; `src/email/events.ts` normalizes delivery webhooks back
onto stored messages. `mail-bridge/` is the self-hosted SMTP sidecar that makes
the `bridge` provider real. [email.md](./email.md).

## AI, memories, semantic search

`src/ai/config.ts` parses `KODY_AI_*` / `KODY_VECTOR_*` once per cell;
`src/ai/providers.ts` implements the OpenAI-compatible chat + embeddings and
Anthropic chat adapters (plain `fetch`, host-side, keys only in request
headers); `src/ai/vector-store.ts` implements the `VectorStore` interface for
sqlite-vec (`vec0`, inside the cell) and Qdrant (REST). `MemoryCell` owns the
per-user memories and embeds them on write; `memorySearch` fuses FTS5 and vector
ranks with reciprocal-rank fusion. The MCP `search` tool reuses the same cell
(`embedCached`) to rank capabilities, guides and packages semantically and can
ask the chat adapter for a final re-rank. AI calls never go through the
sandbox: `aiChat`/`aiEmbed` are ordinary capabilities dispatched by
`RuntimeHost`, so sandbox code never sees a provider key. Details:
[ai.md](./ai.md).

## Limits, quotas, audit

`src/lib/limits.ts` parses the `KODY_*` limit/quota variables once per cell.
`UserCell` enforces quotas at the point of mutation (`runStart`, `packageSave`,
`secretSave`, job reconciliation) and throws `quota_exceeded` (429); `runFinish`
accrues duration/errors into `usage_daily` and prunes runs past the retention
count/age. `executeRun` reads the same limits for the timeout, log cap and
result cap. Audit entries are appended to the registry cell through
`src/lib/audit.ts` with names and ids only. Operator guide:
[operations.md](./operations.md).

## Authentication, MCP OAuth, web UI

`authenticateBearer()` (`src/auth/authenticate.ts`) is the one entry point for
`/mcp` and `/api`: a `mcpat_…` bearer is resolved as an OAuth access token, a
`kc_…` bearer as a legacy API token; both yield the same `Principal`
(`user`, `userCell`, `via`, `clientName`). Unauthenticated `/mcp` requests get
a `WWW-Authenticate: Bearer … resource_metadata="…"` challenge so spec-compliant
MCP hosts discover the built-in authorization server
([mcp-oauth.md](./mcp-oauth.md)). `src/oauth/protocol.ts` holds the pure
protocol rules (metadata, DCR parsing, redirect matching, PKCE, scope
normalization, client auth), `src/oauth/server-store.ts` the registry-cell
persistence (hashed clients/codes/tokens, refresh-token families with replay
detection), `src/oauth/routes.ts` the HTTP surface incl. the signed consent
form.

Browser sign-in (`src/web/*`, `src/auth/*`) is server-rendered HTML with a
hashed session cookie, PBKDF2 passwords with lockout, one-time invite / reset /
magic tokens, session-bound CSRF + same-origin checks, and a separate
admin-token console cookie. The account pages and the operator console call
exactly the same cell methods and `/admin` helpers the JSON API uses; there is
no second code path for mutations ([web-ui.md](./web-ui.md)). Account-side
credential management is also reachable from `execute` via the `account`
capability domain (`mcpClientList/Revoke`, `apiTokenList/Create/Revoke`,
`sessionList/Revoke`); minting or revoking credentials is refused when the
call originates from package/runtime code rather than a direct MCP request.

## Trust boundaries

- **Admin token** (`KODY_ADMIN_TOKEN`): creates users/tokens/invites, approves secret
  hosts, sets quotas, forces job dispatch, reads the audit log, signs in to the
  operator console. Never accepted from the isolate (sandbox `fetch`
  to `/admin` is denied by the gateway).
- **User token** (`kc_...`) and **OAuth access token** (`mcpat_...`): full
  access to that user's cell, nothing else. OAuth tokens expire hourly and are
  refreshed by the client; either kind can be revoked from the account UI.
- **Browser session cookie**: same authority as a user token but only over the
  HTML routes, and only with a same-origin `POST` + CSRF token for mutations.
- **Isolate**: talks only to `RuntimeHost` and `FetchGateway`, both scoped by
  `props.userId`. Reused isolates are keyed by user, so code never shares an
  isolate across users.
- **Sealed runs** (`kind: 'secret-provider'`): started only by the gateway, run
  only a `kody.secretProvider` entry, persist no result or console output. The
  entry cannot be run or imported from anywhere else.
- Non-loopback requests are refused outright while the dev placeholder
  `KODY_ADMIN_TOKEN`/`KODY_MASTER_KEY` are in effect (`insecureConfigError`).
