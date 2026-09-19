# kody-celld

A self-hosted **Kody core** that runs on [Deno celld](https://celld.dev) — the
Cloudflare Workers + Durable Objects programming model on your own machines,
with an S3-compatible bucket for durability.

It is deliberately the _core_, not full product parity with
[kentcdodds/kody](https://github.com/kentcdodds/kody):

| Surface                                                            | Status                                                                                                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP `search` + `execute` (streamable HTTP, JSON-RPC)               | Working, smoke-tested                                                                                                                                                                         |
| Packages (save local / in-memory, run, import)                     | Working, smoke-tested (`kody:@scope/pkg/export`, `packageStorage`)                                                                                                                            |
| Secrets (encrypted store + host-gated injection)                   | Working, smoke-tested (`{{secret:name}}`, `{{secret-basic:...}}`)                                                                                                                             |
| Jobs (package-owned cron / interval / once)                        | Working, smoke-tested against the real celld cron trigger                                                                                                                                     |
| Docker: single node (NAS / home server) and fleet                  | Working, smoke-tested (`compose.yaml`, `compose.fleet.yaml` + MinIO + Caddy)                                                                                                                  |
| Master-key rotation                                                | Working, smoke-tested (`KODY_MASTER_KEY_PREVIOUS` + `POST /admin/secrets/rekey`)                                                                                                              |
| Limits, quotas, `usageGet`, admin audit log                        | Working, smoke-tested ([docs/operations.md](./docs/operations.md))                                                                                                                            |
| AI chat/embeddings (Ollama, LM Studio, vLLM, OpenAI, Anthropic, …) | Working, smoke-tested adapters ([docs/ai.md](./docs/ai.md))                                                                                                                                   |
| Memories (`metaMemory*`) + semantic search                         | Working, smoke-tested: FTS5 + sqlite-vec built in, Qdrant adapter, optional LLM re-rank ([docs/ai.md](./docs/ai.md))                                                                          |
| Blob storage (`blob*`, raw HTTP routes, signed links)              | Working, smoke-tested: celld R2 binding built in, direct S3 adapter ([docs/blobs.md](./docs/blobs.md))                                                                                        |
| Browser rendering (content, screenshots, PDF)                      | Working, smoke-tested adapters: self-hosted browserless overlay or Cloudflare ([docs/browser.md](./docs/browser.md))                                                                          |
| npm imports inside `execute`                                       | Working, smoke-tested: durable module cache, esm.sh or a self-hosted CDN overlay ([docs/npm.md](./docs/npm.md))                                                                               |
| Email (inboxes, send/reply, subscriptions)                         | Working, smoke-tested: self-hosted SMTP `mail-bridge` overlay + Postmark/Mailgun/SendGrid/Resend/Cloudflare adapters ([docs/email.md](./docs/email.md))                                       |
| Package inbound webhooks (mint/rotate, HMAC, replay, deliveries)   | Working, smoke-tested ([docs/webhooks.md](./docs/webhooks.md))                                                                                                                                |
| OAuth integrations (`{{integration-token:…}}`)                     | Working, smoke-tested: bring-your-own OAuth app, PKCE connect, encrypted tokens, host-side refresh ([docs/integrations.md](./docs/integrations.md))                                           |
| Provider-backed secrets (`{{secret/<provider>:…}}`)                | Working, smoke-tested: vault packages run sealed, values injected only at the gateway ([docs/secret-providers.md](./docs/secret-providers.md))                                                |
| MCP OAuth 2.1 authorization server (DCR + PKCE, refresh rotation)  | Working, smoke-tested: MCP clients connect with no token pasting ([docs/mcp-oauth.md](./docs/mcp-oauth.md))                                                                                   |
| Sign-in + web UI (account pages, operator console)                 | Working, smoke-tested: password / invite / magic-link sign-in, tokens, clients, secrets, packages, jobs, runs, inbox ([docs/web-ui.md](./docs/web-ui.md))                                     |
| Install packages from GitHub / URL, community catalog              | Working, smoke-tested: `packageInstall` with host allowlist + SSRF guard, per-install `/community` catalog ([docs/packages.md](./docs/packages.md), [docs/community.md](./docs/community.md)) |

**New here? Start with [docs/getting-started.md](./docs/getting-started.md)** —
it goes from zero to a running Kody in one Docker container (or a two-node
fleet) and shows how to connect an MCP client.

Read [docs/architecture.md](./docs/architecture.md) for how it fits together
and [docs/decision-standalone-vs-adapters.md](./docs/decision-standalone-vs-adapters.md)
for why this is a standalone project rather than a fork of production Kody.

## Run with Docker

```sh
cp .env.example .env            # optional; empty values are generated and persisted
docker compose up -d            # one node on http://localhost:8080, state in the kody-data volume
docker compose exec kody cat /data/kody.env   # KODY_ADMIN_TOKEN / KODY_MASTER_KEY
```

Fleet (two nodes + MinIO + Caddy): `COMPOSE_FILE=compose.fleet.yaml:compose.minio.yaml`
in `.env`, then `docker compose up -d`. Details, TLS, backups and swapping
MinIO for S3/R2/GCS/Azure: [docs/getting-started.md](./docs/getting-started.md).

## Run locally (no Docker)

Prerequisites: Node ≥ 22.18, `celld` ≥ 0.5 on your `PATH`
([install](https://celld.dev/docs)), and `npm install` (provides `esbuild`,
which celld uses to bundle the Worker).

```sh
npm install
npm run dev          # celld dev . --port 8787  (state persists in .celld/dev)
```

In another terminal:

```sh
npm run smoke        # mcp, packages, secrets, jobs, limits, memory, blobs, browser, webhooks, email, integrations, secret-providers, oauth-server, web, npm, install, community against http://127.0.0.1:8787
npm run smoke:cron   # same, plus waits (~60s) for celld's real cron trigger to run a job
```

The dev config ships placeholder `KODY_ADMIN_TOKEN` / `KODY_MASTER_KEY` values
in `wrangler.jsonc`. They only work against loopback: the Worker refuses to
serve non-loopback requests while those placeholders are in effect. Put real
values in a `.dev.vars` file (git-ignored) if you want to expose a dev node.

> `celld dev` rebuilds on any project file change, including edits under
> `smoke/`; pass `--watch-ignore 'smoke/**'` if you edit tests while a smoke run
> is in flight.

### Bootstrap a user and talk MCP

```sh
ADMIN=dev-admin-token
BASE=http://127.0.0.1:8787

# 1. create a user + API token (admin only)
curl -s -X POST $BASE/admin/users -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
# -> { "user": {...}, "token": "kody_..." }

# 2. point any MCP client at $BASE/mcp. OAuth-capable hosts (Claude Code, Cursor,
#    VS Code, …) need only the URL: they get sent to the built-in sign-in +
#    consent page (docs/mcp-oauth.md). Others take `Authorization: Bearer kody_...`.
#    Or call the tools by hand:
curl -s $BASE/mcp -H "authorization: Bearer kody_..." -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"secrets"}}}'
```

`execute` runs an ES module with a default export, exactly like Kody:

```ts
import { kody } from 'kody:runtime'
export default async function main(params) {
  const me = await kody.whoami()
  return { me, sum: params.a + params.b }
}
```

`search` returns the capability catalog (`kody.<capability>(args)` inside
`execute`), guides, and saved packages. Everything a client can do goes through
those two tools; there is no other MCP surface.

## Packages

A package is a file map with `package.json`, a non-empty `README.md` and
`AGENTS.md`, JS modules, and optional `kody.jobs`. Save it with
`kody.packageSave({ files })` (or `POST /api/call/packageSave`), then either
run an export (`packageRun`, host-side) or import it from any run:

```ts
import increment from 'kody:@kody-smoke/counter/increment'
export default async () => increment({ by: 2 })
```

Inside package code `import { packageStorage } from 'kody:runtime'` gives that
package a private SQLite-backed Durable Object with `get/set/delete/list/clear`
and raw `sql()`. Provenance is stamped at graph-build time, so a package's
storage stays its own even when ad hoc code imports it. Ad hoc code has no
scratch storage (same rule as Kody).

Two example packages live in [`examples/packages`](./examples/packages) and are
what the smoke suite installs. See [docs/packages.md](./docs/packages.md).

## Secrets

```ts
await kody.secretSave({ name: 'github', value: '...' }) // value is never echoed back
await fetch('https://api.github.com/user', {
  headers: { authorization: 'Bearer {{secret:github}}' },
})
```

Placeholders are replaced **only** at the network boundary (the `FetchGateway`
Worker Entrypoint that every isolate's outbound `fetch` is routed through), and
only when:

1. the destination host is on the user's approved list (`POST /admin/users/:id/secret-hosts`),
2. the request is HTTPS (loopback hosts listed in `KODY_ALLOW_INSECURE_SECRET_HOSTS` excepted), and
3. every referenced secret exists.

Otherwise the request is denied _before_ leaving the box and the run sees a
403/404 `Response` with a machine-readable reason. Sandbox code cannot approve
hosts, read values, or reach `/admin`. Values are AES-GCM encrypted with a
per-user HKDF key derived from `KODY_MASTER_KEY`; run history records secret
_names_ only. See [docs/secrets.md](./docs/secrets.md).

Two more placeholder kinds ride the same gateway:

```ts
// OAuth: bring your own app, connect once in the browser, tokens refresh host-side
await kody.integrationSave({
  name: 'github',
  authorizeUrl,
  tokenUrl,
  clientId,
  clientSecret,
  scopes: ['repo'],
  allowedHosts: ['api.github.com'],
})
const { url } = await kody.integrationConnect({ name: 'github' }) // open in a browser
await fetch('https://api.github.com/user', { headers: { authorization: 'Bearer {{integration-token:github}}' } })

// Vault-backed: a bound provider package (1Password Connect, Vault, …) fetches the item in a sealed run
await kody.secretProviderBind({
  providerId: '1password',
  packageName: '@kody-examples/onepassword-connect',
  doorSecretName: 'op-connect-token',
  config: { baseUrl: 'https://connect.example.com' },
})
await fetch('https://api.stripe.com/v1/charges', {
  headers: { authorization: 'Bearer {{secret/1password:vaults/Ops/items/Stripe/fields/credential}}' },
})
```

[docs/integrations.md](./docs/integrations.md), [docs/secret-providers.md](./docs/secret-providers.md).

## Jobs

Declare them in `package.json`:

```json
"kody": {
  "jobs": {
    "tick": { "entry": "./tick.js", "schedule": { "type": "interval", "every": "5m" } },
    "nightly": { "entry": "./report.js", "schedule": { "type": "cron", "expression": "0 3 * * *" }, "timezone": "America/Denver" },
    "backfill": { "entry": "./backfill.js", "schedule": { "type": "once", "runAt": "2026-10-01T09:00:00Z" } }
  }
}
```

celld's cron trigger (`* * * * *`) wakes the dispatcher every minute; it claims
due jobs per user, runs the entry with `{ jobName, packageName, scheduledFor, trigger, jobId }`, and records a
run (`jobRuns`, `jobGet`). `jobRunNow`, `jobUpdate` (enable/disable) and
`POST /admin/jobs` (force a dispatch) exist for operators. See
[docs/jobs.md](./docs/jobs.md).

## Limits, quotas and audit

The execute timeout, run retention, log/result caps and per-user quotas (runs
and execute time per day, package/secret/job counts) are environment variables
with sane defaults (`KODY_EXECUTE_TIMEOUT_MS`, `KODY_QUOTA_RUNS_PER_DAY`, …;
quotas default to unlimited). Admins override quotas per user with
`PUT /admin/users/:id/quota`, users check their budget with `kody.usageGet()`,
and every admin or state-changing user action lands in `GET /admin/audit`
(names and ids only — never secret values or tokens). See
[docs/operations.md](./docs/operations.md).

## AI, memories and semantic search

Memories (`metaMemoryVerify` → `metaMemoryUpsert` / `metaMemoryDelete`,
`metaMemorySearch`, `metaMemoryGet`) are built in: a per-user SQLite cell with
FTS5, so they work with no AI configured. Point `KODY_AI_*` at any
OpenAI-compatible server (Ollama, LM Studio, vLLM, OpenRouter, OpenAI) or
Anthropic and you get `kody.aiChat()`, `kody.aiEmbed()`, embedding-based memory
recall and hybrid ranking in `search` — vectors live in sqlite-vec inside the
cell by default, or in Qdrant (`KODY_VECTOR_PROVIDER=qdrant`);
`KODY_SEARCH_RERANK=llm` adds a chat-model re-rank. Provider keys stay
operator-side and never reach sandboxed code.

```sh
# fully local: Ollama + Qdrant containers next to the single node
echo 'COMPOSE_FILE=compose.yaml:compose.ai.yaml' >> .env
docker compose up -d && docker compose exec ollama ollama pull nomic-embed-text
```

Variables, recipes (Ollama on the host, hosted models, fleet) and how ranking
works: [docs/ai.md](./docs/ai.md).

## Blobs and browser rendering

`kody.blobPut/Get/Head/List/Delete/Url/Usage` store per-user files on celld's
R2-compatible bucket binding (local disk on a single node, the fleet bucket in
a fleet) or, with `KODY_BLOB_PROVIDER=s3`, in any S3-compatible bucket you
already run. Files are also reachable as raw bytes at `/api/blobs/<key>` and
through HMAC-signed `blobUrl` links served by Kody, so bucket credentials never
leave the server. Per-user count/byte quotas, size caps and key rules:
[docs/blobs.md](./docs/blobs.md).

`kody.browserContent/Screenshot/Pdf` render pages in a real browser through an
adapter — the bundled self-hosted browserless container or Cloudflare Browser
Rendering. Screenshots come back as protocol-valid MCP `image` blocks from
`execute` (`__mcpContent`) or land in blob storage. Private/loopback targets
are refused unless allowlisted. [docs/browser.md](./docs/browser.md).

```sh
echo 'COMPOSE_FILE=compose.yaml:compose.browser.yaml' >> .env && docker compose up -d
```

## Run a fleet

```sh
export KODY_ADMIN_TOKEN=$(openssl rand -hex 32)
export KODY_MASTER_KEY=$(openssl rand -hex 32)
export KODY_PUBLIC_URL=https://kody.example.com
export CELLD_BUCKET=s3://my-kody-bucket/kody-celld   # + AWS_* creds, S3_ENDPOINT for non-AWS
npm run fleet:deploy            # renders wrangler.fleet.jsonc, celld deploy → bucket
celld --bucket $CELLD_BUCKET --listen 0.0.0.0:8080 --internal-listen 10.0.0.5:9000 --advertise 10.0.0.5:9000
```

Minimum: one node + one S3-compatible bucket with conditional writes; two or
more nodes for `fleet` durability and failover; TLS terminated in front of
celld; peer traffic on a private network. The Docker fleet
(`compose.fleet.yaml` + `compose.minio.yaml`) was run for real: `npm run
smoke:cron` through Caddy passed and stopping a node left the other serving
all state. Bare-metal walkthrough, bucket requirements, and exactly what was
and was not verified: [docs/run-fleet.md](./docs/run-fleet.md).

## Development

```sh
npm run validate     # typecheck + lint (oxlint) + prettier --check + unit tests (node --test)
npm run smoke        # needs `npm run dev` running
```

Layout:

```
src/index.ts              Worker entry: /health, /mcp, /api/*, /admin/*, OAuth + HTML routes, cron → dispatcher
src/lib/                  KodyError, limits/quotas from env, audit helper
src/auth/                 bearer authentication (API + OAuth tokens), passwords (PBKDF2), cookies/CSRF, account store
src/oauth/                MCP OAuth 2.1 authorization server: protocol rules, registry-cell store, routes
src/web/                  server-rendered HTML: sign-in/setup, account pages, operator console
src/mcp/                  JSON-RPC server (search, execute) + search ranking
src/capabilities/         the kody.<capability>() catalog (packages, community, secrets, jobs, runs, storage, memories, ai, blobs, browser, account, system)
src/execute/              module graph → Worker Loader isolate; RuntimeHost RPC; kody:runtime source; npm resolver + durable module cache
src/packages/             remote package sources (GitHub / tarball / JSON) with host allowlist + SSRF guard, tar reader, community catalog store
src/secrets/              placeholders, host policy, FetchGateway (network-boundary injection)
src/blobs/                blob store abstraction: R2 binding + S3 SigV4 adapter, keys, signed links
src/browser/              browser rendering adapters (browserless, Cloudflare) + SSRF guard
src/cells/                Durable Objects: RegistryCell (users/tokens/sessions/OAuth/community), UserCell (per-user state + blob index), PackageStorageCell, MemoryCell, NpmCacheCell
src/jobs/                 schedule parsing + dispatcher
smoke/                    real workloads against a running node (npm run smoke; smoke/rekey.mjs for key rotation)
examples/packages/        @kody-smoke/counter, @kody-smoke/http-probe
docker/                   entrypoint (single / deploy / node), healthcheck, Caddyfile, bucket bootstrap
docs/                     getting started, architecture, run paths, operations, decision record, provision matrix
```

See [AGENTS.md](./AGENTS.md) for contributor rules.

## License

[FSL-1.1-ALv2](./LICENSE) — the same Functional Source License as
[kentcdodds/kody](https://github.com/kentcdodds/kody). Use, modify, and
self-host freely; competing commercial use is not permitted until the
Apache-2.0 future license kicks in.
