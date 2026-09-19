# Run a fleet

> **Verification status:** a real two-node, bucket-backed fleet was run with
> the bundled [`compose.fleet.yaml` + `compose.minio.yaml`](../compose.fleet.yaml)
> (celld 0.5.0, MinIO RELEASE.2025-09-07, Caddy 2): `npm run smoke:cron`
> through the load balancer passed (MCP, packages, secrets, jobs, fleet-wide
> cron dispatch), and stopping `node-a` left `node-b` serving all state.
> The Docker path is the recommended way to run a fleet — see
> [getting-started.md](./getting-started.md#path-b-fleet-two-nodes--a-bucket).
> This page is the manual/bare-metal equivalent and the reference for the
> knobs the compose files set.

## Minimum fleet

| Piece                         | Minimum                  | Notes                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| celld nodes                   | 1 (2+ recommended)       | With one node every write waits for the bucket (`CELLD_DURABILITY=bucket` semantics); 2+ nodes get `fleet` durability and failover.                                                                                                   |
| S3-compatible bucket          | 1, dedicated or prefixed | Needs **conditional writes** (`If-None-Match`/`If-Match`) and read-after-write consistency. AWS S3, R2, GCS (`gs://`), Azure Blob (`az://`), MinIO ≥ RELEASE.2024-04 and Tigris are known to work with celld; check `celld diagnose`. |
| TLS terminator                | 1                        | celld's listener is plain HTTP. Put Caddy/nginx/a cloud LB in front and forward `X-Forwarded-Host/Proto` with `--trust-forwarded-headers`.                                                                                            |
| Private network between nodes | required for 2+ nodes    | Peer/operator traffic has no TLS or auth of its own. Use a VPC, WireGuard/Tailscale, or similar; never advertise a public IP.                                                                                                         |
| Local disk per node           | a few GB                 | `CELLD_WATCH` holds the SQLite working set and replication logs.                                                                                                                                                                      |

## 1. Generate operator secrets (once)

```sh
export KODY_ADMIN_TOKEN=$(openssl rand -hex 32)   # ≥ 24 chars enforced
export KODY_MASTER_KEY=$(openssl rand -hex 32)    # ≥ 32 chars enforced; losing it loses all user secrets
export KODY_PUBLIC_URL=https://kody.example.com   # https:// enforced by the renderer
```

Store them in your secret manager. The Worker refuses non-loopback requests
while the `wrangler.jsonc` placeholders are in effect, so a deploy that forgets
to render the fleet config fails closed with `insecure_configuration`.

## 2. Bucket credentials

```sh
export CELLD_BUCKET=s3://my-kody-bucket/kody-celld      # prefix optional; lets fleets share a bucket
export AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...  AWS_REGION=us-east-1
export S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # only for non-AWS S3-compatibles
celld diagnose --bucket $CELLD_BUCKET        # probes conditional write + list; fix before continuing
```

## 3. Deploy the Worker to the bucket

```sh
npm ci
npm run fleet:deploy
# = node scripts/render-fleet-config.mjs   → wrangler.fleet.jsonc (git-ignored, mode 600)
#   celld deploy wrangler.fleet.jsonc      → bundles with esbuild, writes version to the bucket
```

Running nodes poll the deployment pointer and adopt the new version in place;
nothing restarts. Re-run `fleet:deploy` for every code change.

## 4. Start nodes

On each node (same env as step 2; the Worker vars are already baked into the
deployed version, so nodes only need bucket access):

```sh
export CELLD_WATCH=/var/lib/celld
celld --bucket $CELLD_BUCKET \
      --listen 0.0.0.0:8080 \                 # public Worker listener (behind TLS terminator)
      --internal-listen 10.0.0.5:9000 \       # private NIC only
      --advertise 10.0.0.5:9000 \             # what peers dial
      --trust-forwarded-headers               # only if the proxy sets X-Forwarded-Host/Proto
```

Repeat on further nodes with their own private addresses. The cron trigger
(`* * * * *`) is fleet-wide: celld elects one owner for the scheduled handler,
so jobs dispatch once per minute, not once per node.

Systemd sketch:

```ini
[Service]
EnvironmentFile=/etc/kody-celld/node.env    # bucket + AWS_* + CELLD_* (no KODY_* needed here)
ExecStart=/usr/local/bin/celld --bucket ${CELLD_BUCKET} --listen 0.0.0.0:8080 --internal-listen ${PRIVATE_IP}:9000 --advertise ${PRIVATE_IP}:9000 --trust-forwarded-headers
Restart=always
```

## 5. TLS terminator

Caddyfile example:

```
kody.example.com {
	reverse_proxy 10.0.0.5:8080 10.0.0.6:8080 {
		header_up X-Forwarded-Host {host}
		header_up X-Forwarded-Proto {scheme}
	}
}
```

`KODY_PUBLIC_URL` must equal the public origin; `/health` echoes the MCP URL
it believes in.

## 6. Bootstrap and verify

```sh
curl -s https://kody.example.com/health
curl -s -X POST https://kody.example.com/admin/users \
  -H "authorization: Bearer $KODY_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"kent@example.com"}'            # -> { user, token }

# run the smoke scenarios that do not need a local echo server against the fleet
for s in mcp packages jobs; do
  KODY_URL=https://kody.example.com KODY_ADMIN_TOKEN=$KODY_ADMIN_TOKEN node smoke/run.mjs --only $s
done
```

The `secrets` scenario starts an HTTP echo server to prove injection and
denial without touching a third party. The Worker must be able to reach it:
set `SMOKE_ECHO_HOST` to the name the nodes can resolve (it binds `0.0.0.0`
when that is not loopback) and render `KODY_ALLOW_INSECURE_SECRET_HOSTS=<that
host>` into the config for the duration of the test. The compose fleet does
this with `host.docker.internal`.

## Operations

- **Rotate the admin token:** re-render + `fleet:deploy`. Existing user tokens
  are unaffected.
- **Rotate the master key:** see [secrets.md](./secrets.md#master-key-rotation).
- **Inspect cells:** `celld cell list UserCell --bucket $CELLD_BUCKET`.
- **Logs:** node stdout (`RUST_LOG=info`), plus `GET /admin/users/:id/runs`
  for per-user run history and gateway events.
- **Backups:** the bucket _is_ the durable copy; snapshot it with your
  provider's versioning/replication. User blobs live in the same bucket under
  `r2/kody-blobs/` unless you switch to `KODY_BLOB_PROVIDER=s3`
  ([blobs.md](./blobs.md)).
- **Browser rendering:** run one browserless container reachable from every
  node and set `KODY_BROWSER_*` before `fleet:deploy` ([browser.md](./browser.md)).

## Verified and not verified

Verified with the compose fleet on one Docker host:

- Deploy to a MinIO bucket, two nodes adopting the deployment, Caddy
  round-robin in front.
- Full smoke (`mcp`, `packages`, `secrets`, `jobs`) plus a real fleet-wide
  cron dispatch through the load balancer.
- Node loss: `docker compose stop node-a`, then the full smoke again against
  `node-b` alone, which served the state written earlier through `node-a`.

Not verified here (nothing in the code depends on it, but measure before you
rely on it):

- Nodes on separate machines over a real private network (same celld
  mechanics, different latency).
- Bucket providers other than MinIO and what celld's own test-suite covers
  (AWS S3, R2, GCS, Azure are supported by celld).
- Performance under concurrent `execute` load (Worker Loader isolate reuse is
  per node; a fleet cold-starts per node).
