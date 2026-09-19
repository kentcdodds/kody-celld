# kody-celld

A self-hosted **Kody core** that runs on [Deno celld](https://celld.dev) — the
Cloudflare Workers + Durable Objects programming model on your own machines,
with an S3-compatible bucket for durability.

It is a standalone reimplementation of
[kentcdodds/kody](https://github.com/kentcdodds/kody) for your own hardware:
the same MCP contract (`search` + `execute`, packages, secrets, jobs) plus every
surface production Kody gets from Cloudflare, provided here as a self-hosted
built-in, an adapter for a service you already run, or both — see the
[provision matrix](./docs/known-gaps.md) for how each piece is provided.

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

## Self-host it (Docker, five minutes)

**What you need**

| Requirement | Notes                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker      | 24+ with the `docker compose` plugin, on anything that runs Compose files: Synology Container Manager, QNAP Container Station, Unraid, Portainer, Docker Desktop, plain Linux.         |
| CPU / arch  | `linux/amd64` or `linux/arm64` (Raspberry Pi 4/5 64-bit, Apple-silicon Docker Desktop). 1 core is enough; 32-bit ARM is not supported.                                                 |
| RAM         | ~60 MB idle; ~600 MB measured with a dozen heavy `execute` runs in flight (each run is a V8 isolate). Plan 1 GB for Kody alone; the optional Ollama overlay wants several GB on top.   |
| Disk        | ~550 MB image + your data (SQLite files in one volume; a fresh install is 2 MB). Uploaded blobs live in the same volume.                                                               |
| Network     | One TCP port (default `8080`). Outbound HTTPS for `execute` code that calls APIs, `npm` imports and package installs. No Cloudflare account, no domain required for LAN/Tailscale use. |
| Time        | Pulling the prebuilt image: about a minute. Building from source instead: ~2 min on a laptop, 10+ min on a small NAS.                                                                  |

**1. Start it** — save this as `compose.yaml` in a folder (or paste it into your
NAS's Compose/"stack" UI) and run `docker compose up -d`:

```yaml
services:
  kody:
    image: ghcr.io/kentcdodds/kody-celld:latest
    init: true
    restart: unless-stopped
    ports:
      - '8080:8080'
    environment:
      # The address browsers and MCP clients will actually use — change it when
      # you put Kody behind a hostname or reverse proxy (sign-in and OAuth
      # depend on it). Empty admin token / master key are generated on first
      # start and persisted in the volume.
      KODY_PUBLIC_URL: http://192.168.1.20:8080
    volumes:
      - kody-data:/data
volumes:
  kody-data:
```

Prefer to build from source (or want the AI / browser / mail / fleet overlays)?
`git clone https://github.com/kentcdodds/kody-celld && cd kody-celld && docker compose up -d`
uses the same image name and builds it locally when it is not present.

**2. Check it and read your admin token**

```sh
curl http://192.168.1.20:8080/health           # {"ok":true, ...}
docker compose exec kody cat /data/kody.env    # KODY_ADMIN_TOKEN + KODY_MASTER_KEY — back this up
```

**3. Create your account** — open `http://192.168.1.20:8080/` in a browser. The
**Set up Kody** page asks for the admin token, your email and a password and
signs you in to `/account`. (Created the first user with the admin API
instead? `/setup` disappears once any user exists; sign in on `/signin` with the
`kc_…` API token it returned, then set a password on `/account`.)

**4. Connect an MCP client** — OAuth-capable clients only need the URL and
open the browser for sign-in + consent on first use:

```sh
claude mcp add --transport http kody http://192.168.1.20:8080/mcp
```

Cursor / VS Code / Claude Desktop: add an HTTP MCP server with that URL. Clients
that only take a URL + header use a static token from `/account/tokens`:
`Authorization: Bearer kc_…`. Then ask it to "search Kody" — you should get the
capability catalog back.

**Where things live and how to keep them**

| Task     | How                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data     | Everything (users, packages, secrets, jobs, blobs, `kody.env`) is in the `kody-data` volume. Nothing is written elsewhere; deleting the container is safe, `docker compose down -v` is not.            |
| Back up  | `docker compose stop && docker run --rm -v <project>_kody-data:/data -v "$PWD":/backup alpine tar czf /backup/kody-data.tgz -C / data && docker compose start` — restore by untarring into the volume. |
| Upgrade  | `docker compose pull && docker compose up -d` (from a source checkout: `git pull && docker compose up -d --build`). State and generated keys are kept.                                                 |
| TLS      | Put your reverse proxy (Synology Reverse Proxy, Nginx Proxy Manager, Caddy, Traefik) in front of `8080` with a certificate and set `KODY_PUBLIC_URL=https://kody.example.com`. Do not expose `8080`.   |
| Logs     | `docker compose logs -f kody`                                                                                                                                                                          |
| Failover | Two or more nodes sharing an S3-compatible bucket (MinIO bundled): `compose.fleet.yaml` — see the guide.                                                                                               |

The full walkthrough — NAS specifics, LAN/Tailscale vs. internet exposure,
inviting people, approving secret hosts, every overlay (local AI, headless
browser, SMTP, self-hosted npm CDN), the fleet path, and troubleshooting — is
[docs/getting-started.md](./docs/getting-started.md).

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
# -> { "user": {...}, "token": "kc_..." }

# 2. point any MCP client at $BASE/mcp. OAuth-capable hosts (Claude Code, Cursor,
#    VS Code, …) need only the URL: they get sent to the built-in sign-in +
#    consent page (docs/mcp-oauth.md). Others take `Authorization: Bearer kc_...`.
#    Or call the tools by hand:
curl -s $BASE/mcp -H "authorization: Bearer kc_..." -H 'content-type: application/json' \
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
import { kody } from 'kody:runtime'
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
import { kody } from 'kody:runtime'
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
npm run dev          # builds the browser bundle (vite) then `celld dev` on :8787
npm run smoke        # needs `npm run dev` running
```

Layout:

```
src/index.ts              Worker entry: /health, /mcp, /api/*, /admin/*, OAuth + HTML routes, cron → dispatcher
src/lib/                  KodyError, limits/quotas from env, audit helper
src/auth/                 bearer authentication (API + OAuth tokens), passwords (PBKDF2), cookies/CSRF, account store
src/oauth/                MCP OAuth 2.1 authorization server: protocol rules, registry-cell store, routes
src/web/                  browser route handlers: sign-in/setup, account pages, operator console, community (build loader data → renderPage)
src/app/                  SSR: renderPage (remix/ui/server), document shell, security headers — mirrors kody's packages/worker/src/app
client/                   remix/ui page components, shell, hydration islands — mirrors kody's packages/worker/client
universal/                typed routes, loader-data contracts, design tokens/primitives/icons shared by Worker + browser — mirrors kody's universal/
public/                   static assets served by celld: styles.css, fonts, page-init.js, build/ (vite output)
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
