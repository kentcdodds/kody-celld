# kody-celld

A self-hosted **Kody core** that runs on [Deno celld](https://celld.dev) — the
Cloudflare Workers + Durable Objects programming model on your own machines,
with an S3-compatible bucket for durability.

It is deliberately the _core_, not full product parity with
[kentcdodds/kody](https://github.com/kentcdodds/kody):

| Surface                                              | Status                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| MCP `search` + `execute` (streamable HTTP, JSON-RPC) | Working, smoke-tested                                                                                     |
| Packages (save local / in-memory, run, import)       | Working, smoke-tested (`kody:@scope/pkg/export`, `packageStorage`)                                        |
| Secrets (encrypted store + host-gated injection)     | Working, smoke-tested (`{{secret:name}}`, `{{secret-basic:...}}`)                                         |
| Jobs (package-owned cron / interval / once)          | Working, smoke-tested against the real celld cron trigger                                                 |
| Docker: single node (NAS / home server) and fleet    | Working, smoke-tested (`compose.yaml`, `compose.fleet.yaml` + MinIO + Caddy)                              |
| Master-key rotation                                  | Working, smoke-tested (`KODY_MASTER_KEY_PREVIOUS` + `POST /admin/secrets/rekey`)                          |
| Limits, quotas, `usageGet`, admin audit log          | Working, smoke-tested ([docs/operations.md](./docs/operations.md))                                        |
| npm imports inside `execute`                         | Experimental via esm.sh (see [provision matrix](./docs/known-gaps.md))                                    |
| AI, memories, email, webhooks, OAuth, web UI, …      | Planned as built-ins and/or adapters — status per feature in the [provision matrix](./docs/known-gaps.md) |

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
npm run smoke        # MCP + packages + secrets + jobs against http://127.0.0.1:8787
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

# 2. point any MCP client at $BASE/mcp with `Authorization: Bearer kody_...`
#    or call the tools by hand:
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
src/index.ts              Worker entry: /health, /mcp, /api/*, /admin/*, cron → dispatcher
src/lib/                  KodyError, limits/quotas from env, audit helper
src/mcp/                  JSON-RPC server (search, execute) + search ranking
src/capabilities/         the kody.<capability>() catalog (packages, secrets, jobs, runs, storage, system)
src/execute/              module graph → Worker Loader isolate; RuntimeHost RPC; kody:runtime source
src/secrets/              placeholders, host policy, FetchGateway (network-boundary injection)
src/cells/                Durable Objects: RegistryCell (users/tokens), UserCell (per-user state), PackageStorageCell
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
