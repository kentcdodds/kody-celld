# Run a fleet

> **Verification status:** the local path (`celld dev`) and `celld deploy --dry-run`
> of the rendered fleet config were exercised in this experiment. A real
> bucket-backed multi-node fleet was **not** run — no S3 credentials were
> available. Everything below follows the celld 0.5 CLI/docs and should be
> treated as the checklist for that first fleet run.

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

# run the smoke scenarios that do not need loopback against the fleet
for s in mcp packages jobs; do
  KODY_URL=https://kody.example.com KODY_ADMIN_TOKEN=$KODY_ADMIN_TOKEN node smoke/run.mjs --only $s
done
```

The `secrets` scenario starts a loopback echo server to prove injection and
denial without touching a third party, so it only runs against a node on the
same machine (`celld dev`, or a fleet node reached over SSH port-forwarding
with `KODY_ALLOW_INSECURE_SECRET_HOSTS=127.0.0.1` rendered into the config).

## Operations

- **Rotate the admin token:** re-render + `fleet:deploy`. Existing user tokens
  are unaffected.
- **Rotate the master key:** not supported yet — the store keeps a single key
  id. See known gaps.
- **Inspect cells:** `celld cell list UserCell --bucket $CELLD_BUCKET`.
- **Logs:** node stdout (`RUST_LOG=info`), plus `GET /admin/users/:id/runs`
  for per-user run history and gateway events.
- **Backups:** the bucket _is_ the durable copy; snapshot it with your
  provider's versioning/replication.

## Not verified in this experiment

- Two-node ownership hand-off and `fleet` durability acks.
- Cron ownership election on a multi-node fleet (single-node `celld dev` cron
  was verified).
- Bucket providers other than what celld's own test-suite covers.
- Performance under concurrent `execute` load (Worker Loader isolate reuse is
  per node; a fleet will cold-start per node).

Provide bucket credentials (`AWS_*`, `S3_ENDPOINT`, `CELLD_BUCKET`) and two
hosts on a private network to close these.
