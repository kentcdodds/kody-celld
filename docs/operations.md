# Operations: limits, quotas, usage, audit

Everything an operator can tune or inspect at run time, beyond the secrets and
fleet mechanics covered in [secrets.md](./secrets.md) and
[run-fleet.md](./run-fleet.md), and the AI/vector settings in [ai.md](./ai.md). All of it is built in; nothing here needs an
external service.

Every setting is an environment variable read by the Worker (`src/lib/limits.ts`).
Set them in `.env` for Docker (`compose.yaml` and `compose.fleet.yaml` pass them
through), in `.dev.vars` for `celld dev`, or in the rendered fleet config. On a
fleet they are baked into the deployed Worker config: re-run the `deploy`
service (or `celld deploy`) after changing them. Invalid values fail loudly at
startup rather than silently falling back.

## Runtime limits

| Variable                       | Default    | Range           | Effect                                                                                                            |
| ------------------------------ | ---------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `KODY_EXECUTE_TIMEOUT_MS`      | `60000`    | 1 s … 15 min    | Wall-clock cap per run (`execute`, `packageRun`, jobs). Exceeding it → `execute_timeout` (504).                   |
| `KODY_RUN_RETENTION_COUNT`     | `500`      | 10 … 100 000    | Newest runs kept per user; older finished rows are pruned as runs start and finish.                               |
| `KODY_RUN_RETENTION_DAYS`      | `0`        | 0 … 3650        | Also drop runs older than N days (`0` = count-only).                                                              |
| `KODY_RUN_LOG_LIMIT`           | `200`      | 0 … 10 000      | Console entries persisted per run (the run response is capped the same way).                                      |
| `KODY_RESPONSE_LIMIT_BYTES`    | `100000`   | 1 KB … 10 MB    | Default `responseLimit` for `execute` results; callers may pass a smaller one.                                    |
| `KODY_AUDIT_RETENTION_COUNT`   | `10000`    | 100 … 1 000 000 | Admin audit entries kept in the registry cell.                                                                    |
| `KODY_MCP_CONTENT_LIMIT_BYTES` | `512000`   | 10 KB … 50 MB   | Serialized cap for `__mcpContent` blocks (images/audio) an `execute` run may return ([browser.md](./browser.md)). |
| `KODY_BLOB_MAX_BYTES`          | `26214400` | 1 KB … 1 GiB    | Per-object size cap for blob uploads ([blobs.md](./blobs.md)).                                                    |

`GET /admin/limits` returns the effective limits and quota defaults so you can
confirm what a node actually loaded.

## Quotas

Quotas protect a shared node from one user (or one runaway agent). Defaults come
from the environment; an admin can override any subset per user. `0` means
unlimited everywhere.

| Variable                        | Counts                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| `KODY_QUOTA_RUNS_PER_DAY`       | Runs started per UTC day (`execute`, `packageRun`, job runs) |
| `KODY_QUOTA_EXECUTE_MS_PER_DAY` | Summed run duration per UTC day                              |
| `KODY_QUOTA_PACKAGES`           | Saved packages                                               |
| `KODY_QUOTA_SECRETS`            | Stored secrets (updating an existing secret never counts)    |
| `KODY_QUOTA_JOBS`               | Jobs registered from package manifests                       |
| `KODY_QUOTA_BLOBS`              | Stored blobs (objects) per user                              |
| `KODY_QUOTA_BLOB_BYTES`         | Total blob bytes per user (overwrites count the size delta)  |

Enforcement happens in the user's Durable Object, before the work starts:

- a run over `runsPerDay` / `executeMsPerDay` is rejected with
  `quota_exceeded` (HTTP 429) and is **not** recorded or counted;
- `packageSave`, `secretSave` (new name) and manifest jobs over their count are
  rejected the same way, leaving existing data untouched;
- `blobPut` (capability or `PUT /api/blobs/…`) over `blobs` / `blobBytes` is
  rejected before anything is written to the bucket;
- `executeMsPerDay` is checked against usage accumulated _before_ the run, so
  the last run of the day may finish past the line — the cap is a budget, not a
  hard kill (the timeout is the hard kill).

Usage buckets roll over at 00:00 UTC. Counting a run at start (and its duration
and error at finish) means rejected runs are free and abandoned runs still cost
one.

### Per-user overrides

```sh
ADMIN=...; BASE=http://localhost:8080; USER_ID=usr_...
curl -s $BASE/admin/users/$USER_ID/quota -H "authorization: Bearer $ADMIN"
curl -s -X PUT $BASE/admin/users/$USER_ID/quota -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"runsPerDay": 2000, "secrets": 50}'
curl -s -X DELETE $BASE/admin/users/$USER_ID/quota -H "authorization: Bearer $ADMIN"
```

`PUT` replaces the whole override (keys omitted fall back to the environment
defaults); `DELETE` removes it. Both are audited.

## Usage

Users see their own numbers through the `usageGet` capability (discoverable via
`search`, e.g. "how many runs do I have left"):

```js
import { kody } from 'kody:runtime'
export default async () => kody.usageGet({ days: 7 })
// → { day, today: { runs, errors, executeMs }, history: [...],
//     counts: { packages, secrets, jobs, runsRetained },
//     quotas: { runsPerDay, ... }, quotaOverride, limits: { executeTimeoutMs, ... } }
```

Operators get the same report for any user with
`GET /admin/users/:id/usage?days=30`.

## Audit log

Every admin action and every user action that changes durable state is appended
to an append-only log in the registry cell (`GET /admin/audit`). Entries carry
`actor` (`admin` or `user:<id>`), `action`, `target`, `details` and a timestamp;
the newest `KODY_AUDIT_RETENTION_COUNT` are kept.

```sh
curl -s "$BASE/admin/audit?limit=50" -H "authorization: Bearer $ADMIN"
curl -s "$BASE/admin/audit?actor=admin&action=secret_host." -H "authorization: Bearer $ADMIN"
```

`action` filters by prefix. Actions recorded today:

| Action                                                                                                                                                                    | Actor | Target               | Details                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------- | ----------------------------------------------------------------------- |
| `user.create`, `token.issue`                                                                                                                                              | admin | user id              | email / label                                                           |
| `secret_host.approve`, `secret_host.revoke`                                                                                                                               | admin | user id              | host                                                                    |
| `quota.set`, `quota.clear`                                                                                                                                                | admin | user id              | the override                                                            |
| `jobs.dispatch`                                                                                                                                                           | admin | —                    | jobs ran / skipped                                                      |
| `secret.rekey`                                                                                                                                                            | admin | —                    | current key id, rows resealed / remaining                               |
| `memory.reindex`                                                                                                                                                          | admin | user id              | embedding model, rows re-embedded                                       |
| `secret.save`, `secret.delete`                                                                                                                                            | user  | secret name          | scope, package name                                                     |
| `package.save`, `package.delete`                                                                                                                                          | user  | package name         | version, source, job names                                              |
| `job.enable`, `job.disable`                                                                                                                                               | user  | job id               | —                                                                       |
| `memory.create`, `memory.update`, `memory.delete.soft`, `memory.delete.hard`                                                                                              | user  | memory id            | category, status, package (never the text)                              |
| `webhook.mint`, `webhook.rotate`, `webhook.delete`, `webhook.apply`, `webhook.reveal`                                                                                     | user  | handle               | package + webhook name, provider host (never the URL secret)            |
| `email.inbox.claim`, `email.inbox.release`, `email.destination.verify`, `email.send`                                                                                      | user  | address / message id | provider, recipient count (never bodies or codes)                       |
| `integration.save`, `integration.connect_start`, `integration.connect`, `integration.connect_failed`, `integration.usage`, `integration.disconnect`, `integration.delete` | user  | integration name     | provider, flow, hosts, failure code (never tokens or client secrets)    |
| `secret_provider.bind`, `secret_provider.unbind`, `secret_provider.lock`, `secret_provider.grant`, `secret_provider.revoke`                                               | user  | provider id          | package name, ref, locked flag (never config values or resolved values) |

**What is never in the log:** secret values, encrypted blobs, API tokens, the
admin token, master keys, run code or run results. Callers pass names and ids
only (`src/lib/audit.ts`), and the smoke test asserts that a freshly generated
secret value and a user token do not appear anywhere in `GET /admin/audit`.
The log is a record of _who changed what_, not a copy of the data.

## Email and webhook limits

| Variable                            | Default    | Notes                                                                |
| ----------------------------------- | ---------- | -------------------------------------------------------------------- |
| `KODY_WEBHOOK_MAX_BODY_BYTES`       | `1048576`  | Inbound webhook body cap (`413`).                                    |
| `KODY_EMAIL_MAX_BYTES`              | `10485760` | Stored size per message incl. attachments (`413` / SMTP `552`).      |
| `KODY_QUOTA_EMAIL_MESSAGES`         | `0`        | Stored messages per user; oldest are not evicted, new are refused.   |
| `KODY_QUOTA_EMAIL_SENDS_PER_DAY`    | `0`        | `emailSend`/`emailReply` per user per UTC day.                       |
| `KODY_QUOTA_EMAIL_RECEIVES_PER_DAY` | `0`        | Accepted inbound messages per user per UTC day (`429` / SMTP `452`). |

Per-webhook rate limits come from the package manifest
(`rateLimitPerMinute`, capped at 600). Email counters show up in `usageGet`
(`emailMessages`, `emailSends`, `emailReceives`). See [email.md](./email.md) and [webhooks.md](./webhooks.md).

## Integrations and secret providers

| Variable                             | Default | Notes                                                                                                                                    |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `KODY_PUBLIC_URL`                    | —       | OAuth redirect URI is `${KODY_PUBLIC_URL}/connect/oauth/callback`; register it in each OAuth app ([integrations.md](./integrations.md)). |
| `KODY_SECRET_PROVIDER_CACHE_SECONDS` | `300`   | In-memory TTL for resolved `{{secret/…}}` values in the user cell; `0` disables caching ([secret-providers.md](./secret-providers.md)).  |
| `KODY_SECRET_PROVIDER_TIMEOUT_MS`    | `20000` | Wall-clock cap for one sealed provider run (minimum 1000).                                                                               |

## npm imports, package sources, community catalog

| Variable                    | Default          | Notes                                                                                                                                                                                               |
| --------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KODY_NPM_IMPORTS`          | `on`             | `off` rejects bare npm specifiers in runs and packages ([npm.md](./npm.md)).                                                                                                                        |
| `KODY_ESM_CDN_URL`          | `https://esm.sh` | esm.sh-compatible CDN origin; point at the `compose.esm.yaml` service to self-host.                                                                                                                 |
| `KODY_NPM_CACHE_MAX_MB`     | `256`            | Durable module cache size (LRU); `0` disables the durable layer.                                                                                                                                    |
| `KODY_NPM_CACHE_TTL_DAYS`   | `30`             | Re-fetch cached modules after this long.                                                                                                                                                            |
| `KODY_PACKAGE_SOURCE_HOSTS` | GitHub hosts     | Comma-separated hosts `packageInstall` may download from; `*.example.com` wildcards allowed, `*` = any public host. Private/loopback hosts only when listed exactly ([packages.md](./packages.md)). |

```sh
curl -s $BASE/admin/npm-cache -H "authorization: Bearer $ADMIN"             # config + cache stats
curl -s -X DELETE $BASE/admin/npm-cache -H "authorization: Bearer $ADMIN"   # flush (audited: npm_cache.clear)
```

Audit actions: `npm_cache.clear`, `package.install`, `package.update`,
`community.publish`, `community.unpublish`, `community.install`. The community
catalog has no operator switch; it is empty until a user publishes, and
listings are public HTML at `/community` ([community.md](./community.md)).

## Sign-in, MCP OAuth, web UI

| Variable           | Default | Notes                                                                                                                                                                                                                    |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KODY_PUBLIC_URL`  | —       | The OAuth **issuer** and the origin every browser form must come from. Cookies are `Secure` only when it is `https:`; discovery metadata, redirect handling and CORS derive from it ([mcp-oauth.md](./mcp-oauth.md)).    |
| `KODY_ADMIN_TOKEN` | —       | Also unlocks `/setup` (first account) and the operator console at `/console` ([web-ui.md](./web-ui.md)).                                                                                                                 |
| `KODY_MASTER_KEY`  | —       | Additionally signs CSRF / consent state and seals the refresh-replay snapshot; rotate with `KODY_MASTER_KEY_PREVIOUS` as for secrets ([secrets.md](./secrets.md)). Rotating it invalidates in-flight consent forms only. |

Fixed protocol constants (change in `src/oauth/protocol.ts` / `src/auth/*` if
you must): authorization codes 10 min, access tokens 1 h, refresh tokens 30 d
with rotation and a 60 s replay grace, unused OAuth clients purged after 30 d,
browser sessions 30 d, console sessions 12 h, invites 7 d, magic links 15 min,
5 failed passwords → 15 min lockout per email.

Admin JSON endpoints added for the UI:

```sh
# one-time invite link (sets a password); {"reset":true} for an existing account
curl -s -X POST $BASE/admin/users/$USER/invite -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{}'
# sign a user out everywhere: browser sessions + every OAuth grant
curl -s -X POST $BASE/admin/users/$USER/signout -H "authorization: Bearer $ADMIN"
```

Audit actions: `signin`, `signin.failed`, `signin.magic_link`,
`signin.invite_accepted`, `password.set`, `password.reset`, `session.revoke`,
`token.issue`, `token.revoke`, `user.invite`, `user.signout_everywhere`,
`mcp_client.register`, `mcp_client.authorize`, `mcp_client.deny`,
`mcp_client.revoke`, `mcp_client.revoke_all`, `console.signin`,
`console.signin_failed`. Details never include submitted passwords, tokens or
codes.

## Smoke coverage

`npm run smoke` runs the `limits` scenario: `GET /admin/limits`, `usageGet`,
a per-user quota clamp that rejects the next run with `quota_exceeded` and the
second secret with the secrets quota, clearing the override, the audit log
(presence, filters, and the no-leak assertions above) and the retention bound.
Start the node with `KODY_EXECUTE_TIMEOUT_MS=5000` and run
`SMOKE_EXPECT_TIMEOUT_MS=5000 npm run smoke` to also prove a long run is cut off
at the configured timeout. The `oauth-server` and `web` scenarios cover the
authorization server and the HTML UI end to end (see the respective docs);
`npm`, `install` and `community` cover the module cache, remote package
sources (including the SSRF refusals) and the catalog.
