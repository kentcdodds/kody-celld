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
- **Memories + AI** — durable per-user memories with full-text search out of
  the box; point it at Ollama / LM Studio / OpenAI / Anthropic (or add the
  bundled Ollama + Qdrant overlay) for embeddings, semantic recall and
  `kody.aiChat()`. See [ai.md](./ai.md).

Everything runs on [celld](https://celld.dev), Deno's self-hosted Cloudflare
Workers + Durable Objects runtime. No Cloudflare account is involved.

---

## Path A — one container

Best for a Synology/QNAP/Unraid NAS, a Raspberry Pi 4/5 (64-bit), a home
server, or one small VPS. State lives in one Docker volume.

### 0. Requirements

| What    | Minimum                                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker  | 24+ with the `docker compose` plugin (`docker compose version`)                                                                                                                               |
| CPU     | `linux/amd64` or `linux/arm64`; 1 core. The prebuilt image ships for both; 32-bit ARM is not supported (celld has no build for it).                                                           |
| RAM     | 1 GB for Kody. Measured on the reference build: ~60 MB idle, ~600 MB with a dozen heavy `execute` runs in flight. Overlays add their own (the Ollama one wants several GB).                   |
| Disk    | ~550 MB image + data. A fresh install writes 2 MB; growth is your packages, run history, memories and uploaded blobs (all SQLite/files in one volume).                                        |
| Network | One inbound TCP port (default `8080`) reachable by your browser and MCP clients. Outbound HTTPS so `execute` code can call APIs, `npm` imports resolve and packages install from GitHub/URLs. |

No domain or TLS is needed on a LAN or Tailscale network. No Cloudflare account
is involved at any point.

### 1. Install Docker

- NAS: install the **Container Manager** (Synology) / **Container Station**
  (QNAP) / Docker (Unraid apps) package from your vendor's app store.
- Linux server: `curl -fsSL https://get.docker.com | sh`.
- Mac/Windows: Docker Desktop.

You need Docker 24+ with the `docker compose` plugin (`docker compose version`).

### 2. Get a compose file

**Option 1 — prebuilt image (recommended on a NAS).** Nothing to clone or
build. Create a folder (say `kody`), save this as `compose.yaml` in it — or
paste it into Container Manager → Project / Container Station → Application /
Portainer → Stacks:

```yaml
services:
  kody:
    image: ghcr.io/kentcdodds/kody-celld:latest
    init: true
    restart: unless-stopped
    ports:
      - '8080:8080'
    environment:
      KODY_PUBLIC_URL: http://<kody-host>:8080 # see below
    volumes:
      - kody-data:/data
volumes:
  kody-data:
```

**Pick `KODY_PUBLIC_URL` first.** It is the exact address you will type into
the browser and give MCP clients — scheme, host and port. Sign-in cookies, the
OAuth issuer and redirect URIs are bound to it, so a mismatch shows up as a
rejected sign-in form or "invalid redirect":

| Where you run it                                    | `KODY_PUBLIC_URL`                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Trying it on this machine (Docker Desktop, laptop)  | `http://localhost:8080`                                                               |
| NAS / home server / VPS reached from other machines | `http://192.168.1.20:8080`, `http://nas.local:8080`, `http://nas.tailnet.ts.net:8080` |
| Behind a reverse proxy with TLS (step 6)            | `https://kody.example.com` (no port)                                                  |

`localhost` only works from the machine running Docker — for a NAS use its LAN
IP or hostname. The rest of this guide writes `<kody-host>:8080` wherever that
value goes. Every other setting is optional; the
[`.env.example`](../.env.example) lists them and any of them can go under
`environment:`.

The image is published for `linux/amd64` and `linux/arm64` by
[`publish.yml`](../.github/workflows/publish.yml) on every push to `main`
(`:latest`, `:main`, `:sha-…`) and on version tags (`:1.2.3`). Pin a tag if you
want to control when you upgrade.

**Option 2 — build from source.** Needed for the overlays (`compose.*.yaml`)
and the fleet, or if you want to hack on it:

```sh
git clone https://github.com/kentcdodds/kody-celld.git
cd kody-celld
cp .env.example .env     # KODY_PUBLIC_URL defaults to http://localhost:8080; change it per the table above
```

(No git on the NAS? Download the ZIP from GitHub and unpack it into a shared
folder, then open a terminal/SSH session in that folder.) `docker compose up -d`
builds the image under the same `ghcr.io/kentcdodds/kody-celld` name when it is
not present locally; `docker compose pull` swaps in the prebuilt one.

### 3. Start it

```sh
docker compose up -d
```

Pulling the image takes about a minute; building it from source takes a few
minutes on a laptop and 10+ on a small NAS. `docker compose logs kody` ends
with:

```
kody-1  | [kody-celld] wrote operator values to /data/kody.env (admin token + master key).
kody-1  | [kody-celld] single node: MCP at http://<kody-host>:8080/mcp (listening on 0.0.0.0:8080)
kody-1  |   ready  http://0.0.0.0:8080
```

Check it: `curl http://<kody-host>:8080/health` → `{"ok":true, ...}`.
The container also has a Docker health check, so `docker compose ps` shows
`healthy` once it is serving.

### 4. Read your admin token

The container generated a random **admin token** (lets you create users) and a
**master key** (encrypts every user secret). Both are in the volume:

```sh
docker compose exec kody cat /data/kody.env
```

**Back this file up** (a password manager entry is fine). If you lose the
master key, stored secrets are gone for good. If you would rather bring your
own values, set `KODY_ADMIN_TOKEN` / `KODY_MASTER_KEY` in the compose
`environment:` or in `.env` _before_ the first start; environment values always
win over the generated file and are written back to it.

### 5. Create your user and connect an MCP client

Open `http://<kody-host>:8080/` (your `KODY_PUBLIC_URL`) in a browser. With no accounts yet it shows
**Set up Kody**: paste the admin token, enter your email and a password
(12+ characters) — that creates your account and signs you in to `/account`
([web-ui.md](./web-ui.md)). Then point an OAuth-capable MCP client at the URL
only:

```sh
claude mcp add --transport http kody http://<kody-host>:8080/mcp
# first use opens the browser: sign in, click Approve
```

Cursor, VS Code and Claude Desktop work the same way (add an HTTP MCP server
with just the URL; see [mcp-oauth.md](./mcp-oauth.md)). Invite other people
from **/console → Users** (one-time invite links) — there is no open
registration.

Prefer the command line, or have a client that only takes a URL + header?
Create a user and a static API token instead. Note that **`/setup` is only
offered while the install has no users** — if you create the first user this
way, sign in on `/signin` with the returned API token (the "API token" option)
and set a password from `/account`.

```sh
ADMIN=<KODY_ADMIN_TOKEN from kody.env>
BASE=http://<kody-host>:8080   # your KODY_PUBLIC_URL

curl -s -X POST $BASE/admin/users \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
# -> {"user":{"id":"user_…"},"token":"kc_…"}
```

Give the client the URL `$BASE/mcp` and the header
`Authorization: Bearer kc_…` (in Claude Code: add
`--header "Authorization: Bearer kc_…"` to the command above). You can also
create and revoke tokens later from `/account/tokens`.

Ask it to "search Kody for secrets" — you should see the capability catalog.
Then have it run something: `execute` takes an ES module with a default
export (`export default async () => ({ hello: 'world' })`). Kody's own
capabilities are not a global — code that calls them starts with
`import { kody } from 'kody:runtime'` — and any `fetch`
that uses a `{{secret:…}}` placeholder is refused with `secret_host_not_approved`
until you approve that host once as admin (step 7).

### 6. Make it reachable (optional but recommended)

- **On your LAN / Tailscale only:** you are done, as long as
  `KODY_PUBLIC_URL` is the address other machines use (`http://<lan-ip>:8080`
  or `http://<hostname>:8080`, not `localhost`). Changing it later is fine:
  edit the compose `environment:` / `.env` and `docker compose up -d`; `/health`,
  the OAuth discovery metadata and the sign-in forms pick up the new origin.
  (OAuth issuer and cookie origin are derived from this value — a mismatch
  shows up as "invalid redirect" or a rejected sign-in form.)
- **From the internet:** put your NAS reverse proxy (Synology "Reverse Proxy",
  Nginx Proxy Manager, Caddy, Traefik) in front of port 8080 with a TLS
  certificate, set `KODY_PUBLIC_URL=https://kody.your-domain.example` in `.env`,
  and `docker compose up -d`. Do **not** publish port 8080 itself.

Secret-bearing requests from packages are only sent to `https://` hosts that an
admin approved (`POST /admin/users/:id/secret-hosts`), regardless of how Kody
itself is reached.

### 7. Day-2 operations

| Task                   | Command                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upgrade                | `docker compose pull && docker compose up -d`; from a source checkout `git pull && docker compose up -d --build`. State and operator values persist across upgrades      |
| Back up                | `docker compose stop`, then `docker run --rm -v <project>_kody-data:/data -v "$PWD":/backup alpine tar czf /backup/kody-data.tgz -C / data`, then `docker compose start` |
| Restore                | Same command with `tar xzf /backup/kody-data.tgz -C /` into a fresh (empty) `kody-data` volume, then `docker compose up -d`. `kody.env` travels with the data            |
| Uninstall              | `docker compose down` keeps the data; `docker compose down -v` deletes the volume — and with it every user, package, secret and the master key                           |
| Logs                   | `docker compose logs -f kody`                                                                                                                                            |
| Approve a secret host  | `curl -X POST $BASE/admin/users/<id>/secret-hosts -H "authorization: Bearer $ADMIN" -d '{"host":"api.github.com"}'`                                                      |
| Force a job dispatch   | `curl -X POST $BASE/admin/jobs -H "authorization: Bearer $ADMIN"`                                                                                                        |
| Turn on local AI       | `echo 'COMPOSE_FILE=compose.yaml:compose.ai.yaml' >> .env && docker compose up -d && docker compose exec ollama ollama pull nomic-embed-text` ([ai.md](./ai.md))         |
| Add a headless browser | `echo 'COMPOSE_FILE=compose.yaml:compose.browser.yaml' >> .env && docker compose up -d` (combine overlays with `:`; [browser.md](./browser.md))                          |
| Self-host the npm CDN  | `echo 'COMPOSE_FILE=compose.yaml:compose.esm.yaml' >> .env && docker compose up -d` — bare `import ms from 'ms@2.1.3'` stops depending on esm.sh ([npm.md](./npm.md))    |
| Install a package      | `packageInstall({ source: 'github:owner/repo/path' })` via MCP or the account Packages page; extra hosts via `KODY_PACKAGE_SOURCE_HOSTS` ([packages.md](./packages.md))  |
| Share packages         | Users publish saved packages to the install's own catalog at `$BASE/community` ([community.md](./community.md))                                                          |
| Verify end to end      | `KODY_URL=$BASE KODY_ADMIN_TOKEN=$ADMIN SMOKE_ECHO_HOST=host.docker.internal npm run smoke` from a checkout on the Docker host (needs Node 22)                           |

`<project>` in the volume name is the compose project — the folder name by
default (`kody-celld_kody-data` for a git checkout, `kody_kody-data` for a
folder called `kody`); `docker volume ls` shows it.

The single-node mode uses celld's local object store, so there is no bucket to
manage. If you later want failover, move to Path B — the code, users, and MCP
contract are identical; only the storage layer changes.

### What was actually run

A from-zero run of this path on a clean checkout (Docker 24, x86_64): `docker
compose up -d` → `/health` ok → `kody.env` generated → user + token via the
admin API → `search` and `execute` through a stock MCP client
(`@modelcontextprotocol/inspector --cli`) → `secretSave` + a `{{secret:…}}`
fetch denied with `secret_host_not_approved`, approved, then delivered over
https → `docker compose down && docker compose up -d` with the user, token,
secret and approval intact → sign-in with the API token and `/account`,
`/console` rendered. The OAuth client flow (DCR + PKCE + consent) is exercised
by the `oauth-server` smoke scenario that CI runs against this same image on
every PR.

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

| Symptom                                                       | Cause / fix                                                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `500 insecure_configuration` on a non-loopback URL            | The dev placeholders are in effect. Path A: check `/data/kody.env` exists and was loaded. Path B: `KODY_*` missing in `.env` at deploy time.                                                         |
| `deploy` exits with `KODY_PUBLIC_URL must be an https:// URL` | Set a real https URL, or `KODY_ALLOW_HTTP_PUBLIC_URL=1` for a trusted LAN.                                                                                                                           |
| `/health` fails right after `up` on the fleet                 | Nodes only serve once the `deploy` job has published a version; `docker compose logs deploy`.                                                                                                        |
| `secret_host_not_approved`                                    | Approve the destination host for that user with `POST /admin/users/:id/secret-hosts`.                                                                                                                |
| `secret_requires_https`                                       | Secrets are only sent over https. For local testing add the host to `KODY_ALLOW_INSECURE_SECRET_HOSTS`.                                                                                              |
| `/setup` redirects to `/signin`                               | A user already exists (created via the admin API or an earlier run). Sign in with that user's API token, or invite yourself from `/console`.                                                         |
| Sign-in form rejected / OAuth "invalid redirect"              | `KODY_PUBLIC_URL` does not match the address in the browser (e.g. it says `localhost` but you opened the NAS's IP). Set it to exactly what you type (scheme, host, port) and `docker compose up -d`. |
| `docker compose pull` says denied / not found                 | The package on ghcr.io is not public yet or the tag does not exist; build locally with `docker compose up -d --build` from a checkout instead.                                                       |
| Raspberry Pi build is slow / OOM                              | Use the prebuilt `linux/arm64` image (`docker compose pull`), or build on a laptop with `docker buildx build --platform linux/arm64` and set `KODY_IMAGE` in `.env`.                                 |
| Where is the data?                                            | Path A: volume `kody-data` (`/data/celld` = celld's local object store, `/data/kody.env` = operator values). Path B: the bucket + per-node `/var/lib/celld` cache.                                   |
