# Getting started (from zero)

This guide takes you from nothing to a running self-hosted Kody with an MCP
client connected. Pick the path that matches where you want it to live:

| You have…                                       | Use                                                 | Time    |
| ----------------------------------------------- | --------------------------------------------------- | ------- |
| A NAS / home server / single VPS running Docker | [Path A — one container](#path-a-one-container)     | ~5 min  |
| Two or more machines, or you want failover      | [Path B — fleet](#path-b-fleet-two-nodes--a-bucket) | ~15 min |
| A laptop and you want to hack on the code       | [Path C — no Docker](#path-c-no-docker-local-dev)   | ~5 min  |

Every path ends with the same product: an MCP endpoint at
`<your URL>/mcp` exposing `search` and `execute`, an admin API for creating
users, and durable state you can back up.

## What you get

- **MCP** `search` + `execute` (streamable HTTP, JSON-RPC) for any MCP client
  (Claude, Cursor, Zed, custom agents…).
- **Packages** — saved code with exports, `kody:` imports, and per-package
  SQLite storage.
- **Secrets** — encrypted with a master key you own; only ever injected at the
  network boundary to hosts an admin approved.
- **Jobs** — package-owned cron / interval / once schedules on celld's real
  cron trigger.

Everything runs on [celld](https://celld.dev), Deno's self-hosted Cloudflare
Workers + Durable Objects runtime. No Cloudflare account is involved.

---

## Path A — one container

Best for a Synology/QNAP/Unraid NAS, a Raspberry Pi 4/5 (64-bit), a home
server, or one small VPS. State lives in one Docker volume.

### 1. Install Docker

- NAS: install the **Container Manager** (Synology) / **Container Station**
  (QNAP) / Docker (Unraid apps) package from your vendor's app store.
- Linux server: `curl -fsSL https://get.docker.com | sh`.
- Mac/Windows: Docker Desktop.

You need Docker 24+ with the `docker compose` plugin (`docker compose version`).

### 2. Get the project

```sh
git clone https://github.com/kentcdodds/kody-celld.git
cd kody-celld
```

(No git on the NAS? Download the ZIP from GitHub and unpack it into a shared
folder, then open a terminal/SSH session in that folder.)

### 3. Start it

```sh
docker compose up -d
```

The first run builds the image (a few minutes on a NAS), then prints:

```
kody-1  | [kody-celld] wrote operator values to /data/kody.env (admin token + master key).
kody-1  | [kody-celld] single node: MCP at http://localhost:8080/mcp (listening on 0.0.0.0:8080)
kody-1  |   ready  http://0.0.0.0:8080
```

Check it: `curl http://<nas-ip>:8080/health` → `{"ok":true, ...}`.

### 4. Read your admin token

The container generated a random **admin token** (lets you create users) and a
**master key** (encrypts every user secret). Both are in the volume:

```sh
docker compose exec kody cat /data/kody.env
```

**Back this file up.** If you lose the master key, stored secrets are gone for
good. If you would rather bring your own values, put them in `.env` (copy
`.env.example`) _before_ the first start; environment values always win over
the generated file.

### 5. Create your user and connect an MCP client

```sh
ADMIN=<KODY_ADMIN_TOKEN from kody.env>
BASE=http://<nas-ip>:8080

curl -s -X POST $BASE/admin/users \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
# -> {"user":{"id":"user_…"},"token":"kody_…"}
```

Give your MCP client the URL `$BASE/mcp` and the header
`Authorization: Bearer kody_…`. For clients that only take a URL + token,
that is all. For example, in Claude Code:

```sh
claude mcp add --transport http kody http://<nas-ip>:8080/mcp \
  --header "Authorization: Bearer kody_…"
```

Ask it to "search Kody for secrets" — you should see the capability catalog.

### 6. Make it reachable (optional but recommended)

- **On your LAN / Tailscale only:** you are done. Set
  `KODY_PUBLIC_URL=http://<hostname>:8080` in `.env` so `/health` and MCP
  metadata advertise the right address, then `docker compose up -d`.
- **From the internet:** put your NAS reverse proxy (Synology "Reverse Proxy",
  Nginx Proxy Manager, Caddy, Traefik) in front of port 8080 with a TLS
  certificate, set `KODY_PUBLIC_URL=https://kody.your-domain.example` in `.env`,
  and `docker compose up -d`. Do **not** publish port 8080 itself.

Secret-bearing requests from packages are only sent to `https://` hosts that an
admin approved (`POST /admin/users/:id/secret-hosts`), regardless of how Kody
itself is reached.

### 7. Day-2 operations

| Task                  | Command                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade               | `git pull && docker compose build && docker compose up -d` (state and operator values persist)                                                                            |
| Back up               | Stop, then copy the `kody-data` volume (`docker run --rm -v kody-celld_kody-data:/data -v $PWD:/backup alpine tar czf /backup/kody-data.tgz /data`); restore by untarring |
| Logs                  | `docker compose logs -f kody`                                                                                                                                             |
| Approve a secret host | `curl -X POST $BASE/admin/users/<id>/secret-hosts -H "authorization: Bearer $ADMIN" -d '{"host":"api.github.com"}'`                                                       |
| Force a job dispatch  | `curl -X POST $BASE/admin/jobs -H "authorization: Bearer $ADMIN"`                                                                                                         |
| Verify end to end     | `KODY_URL=$BASE KODY_ADMIN_TOKEN=$ADMIN SMOKE_ECHO_HOST=host.docker.internal npm run smoke` from a checkout on the Docker host (needs Node 22)                            |

The single-node mode uses celld's local object store, so there is no bucket to
manage. If you later want failover, move to Path B — the code, users, and MCP
contract are identical; only the storage layer changes.

---

## Path B — fleet (two nodes + a bucket)

Two or more celld nodes share one S3-compatible bucket; either node can serve
any request, and a node can die without losing state. The bundled
`compose.fleet.yaml` runs the whole thing on one Docker host (great for trying
it, or for a beefy NAS); spread the nodes over machines for real redundancy.

### 1. Configure

```sh
git clone https://github.com/kentcdodds/kody-celld.git && cd kody-celld
cp .env.example .env
```

Edit `.env` — uncomment the fleet block and set:

```ini
COMPOSE_FILE=compose.fleet.yaml:compose.minio.yaml
KODY_ADMIN_TOKEN=<32+ random chars>     # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
KODY_MASTER_KEY=<32+ random chars>
KODY_PUBLIC_URL=https://kody.example.com
KODY_SITE_ADDRESS=kody.example.com       # Caddy gets a Let's Encrypt cert for this
AWS_ACCESS_KEY_ID=kody-celld             # becomes MinIO's root user
AWS_SECRET_ACCESS_KEY=<20+ random chars>
```

LAN-only without TLS? Use `KODY_PUBLIC_URL=http://<host>:80`,
`KODY_ALLOW_HTTP_PUBLIC_URL=1`, `KODY_SITE_ADDRESS=:80`.

Already have S3 / Cloudflare R2 / GCS / Azure / a MinIO? Drop
`compose.minio.yaml` from `COMPOSE_FILE`, set `CELLD_BUCKET`, `S3_ENDPOINT`
(empty for AWS), `AWS_REGION` and the keys, and set `KODY_CREATE_BUCKET=1` if
the bucket does not exist yet. See [run-fleet.md](./run-fleet.md) for the
bucket requirements (conditional writes).

### 2. Start

```sh
docker compose up -d
```

Order of events: MinIO becomes healthy → the `deploy` job creates the bucket,
renders the fleet config from `.env`, and uploads the bundled Worker → `node-a`
and `node-b` start and adopt the deployment → Caddy starts routing.

```sh
curl -s http://<host>/health          # via Caddy, round-robin over both nodes
```

### 3. Redeploy after a code change

```sh
docker compose build && docker compose run --rm deploy
```

Nodes adopt the new version at their next pointer poll; nothing restarts.

### 4. Verify (what was actually tested)

This exact stack was run in the experiment with MinIO
`RELEASE.2025-09-07T16-13-09Z`, celld 0.5.0, Caddy 2:

- `npm run smoke:cron` through Caddy — MCP, packages, secrets, jobs, **and a
  real fleet-wide cron dispatch** passed.
- `docker compose stop node-a` then `npm run smoke` again — node-b served every
  request including the state node-a had written (both smoke users visible).

To repeat it:

```sh
source .env
KODY_URL=$KODY_PUBLIC_URL KODY_ADMIN_TOKEN=$KODY_ADMIN_TOKEN \
  SMOKE_ECHO_HOST=host.docker.internal npm run smoke:cron
```

(`SMOKE_ECHO_HOST` lets the secrets scenario reach the smoke's echo server on
the Docker host; set `KODY_ALLOW_INSECURE_SECRET_HOSTS=host.docker.internal`
in `.env` before deploying for that one scenario, and remove it afterwards.)

### 5. Spreading nodes over machines

Run `compose.fleet.yaml` per machine with only one `node-*` service each (or
run `celld` directly — see [run-fleet.md](./run-fleet.md)), pointing every
node at the same bucket. Requirements: a private network between nodes (VPC,
WireGuard, Tailscale) because celld's peer port 9000 has no auth of its own,
and `--advertise <private-host>:9000` per node.

---

## Path C — no Docker (local dev)

```sh
npm install                      # esbuild for celld's bundler
# install celld: https://celld.dev/docs (a single binary)
npm run dev                      # celld dev . --port 8787; state in .celld/dev
npm run smoke                    # in another terminal
```

The dev config in `wrangler.jsonc` uses placeholder operator values that only
work over loopback. See the [README](../README.md) for the day-to-day
workflow.

---

## Troubleshooting

| Symptom                                                       | Cause / fix                                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `500 insecure_configuration` on a non-loopback URL            | The dev placeholders are in effect. Path A: check `/data/kody.env` exists and was loaded. Path B: `KODY_*` missing in `.env` at deploy time.                       |
| `deploy` exits with `KODY_PUBLIC_URL must be an https:// URL` | Set a real https URL, or `KODY_ALLOW_HTTP_PUBLIC_URL=1` for a trusted LAN.                                                                                         |
| `/health` fails right after `up` on the fleet                 | Nodes only serve once the `deploy` job has published a version; `docker compose logs deploy`.                                                                      |
| `secret_host_not_approved`                                    | Approve the destination host for that user with `POST /admin/users/:id/secret-hosts`.                                                                              |
| `secret_requires_https`                                       | Secrets are only sent over https. For local testing add the host to `KODY_ALLOW_INSECURE_SECRET_HOSTS`.                                                            |
| Raspberry Pi build is slow / OOM                              | Build on a laptop with `docker buildx build --platform linux/arm64 -t kody-celld:local .`, push to a registry and set `KODY_IMAGE` in `.env`.                      |
| Where is the data?                                            | Path A: volume `kody-data` (`/data/celld` = celld's local object store, `/data/kody.env` = operator values). Path B: the bucket + per-node `/var/lib/celld` cache. |
