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

| Variable                     | Default  | Range           | Effect                                                                                          |
| ---------------------------- | -------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `KODY_EXECUTE_TIMEOUT_MS`    | `60000`  | 1 s … 15 min    | Wall-clock cap per run (`execute`, `packageRun`, jobs). Exceeding it → `execute_timeout` (504). |
| `KODY_RUN_RETENTION_COUNT`   | `500`    | 10 … 100 000    | Newest runs kept per user; older finished rows are pruned as runs start and finish.             |
| `KODY_RUN_RETENTION_DAYS`    | `0`      | 0 … 3650        | Also drop runs older than N days (`0` = count-only).                                            |
| `KODY_RUN_LOG_LIMIT`         | `200`    | 0 … 10 000      | Console entries persisted per run (the run response is capped the same way).                    |
| `KODY_RESPONSE_LIMIT_BYTES`  | `100000` | 1 KB … 10 MB    | Default `responseLimit` for `execute` results; callers may pass a smaller one.                  |
| `KODY_AUDIT_RETENTION_COUNT` | `10000`  | 100 … 1 000 000 | Admin audit entries kept in the registry cell.                                                  |

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

Enforcement happens in the user's Durable Object, before the work starts:

- a run over `runsPerDay` / `executeMsPerDay` is rejected with
  `quota_exceeded` (HTTP 429) and is **not** recorded or counted;
- `packageSave`, `secretSave` (new name) and manifest jobs over their count are
  rejected the same way, leaving existing data untouched;
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

| Action                                                                       | Actor | Target       | Details                                    |
| ---------------------------------------------------------------------------- | ----- | ------------ | ------------------------------------------ |
| `user.create`, `token.issue`                                                 | admin | user id      | email / label                              |
| `secret_host.approve`, `secret_host.revoke`                                  | admin | user id      | host                                       |
| `quota.set`, `quota.clear`                                                   | admin | user id      | the override                               |
| `jobs.dispatch`                                                              | admin | —            | jobs ran / skipped                         |
| `secret.rekey`                                                               | admin | —            | current key id, rows resealed / remaining  |
| `memory.reindex`                                                             | admin | user id      | embedding model, rows re-embedded          |
| `secret.save`, `secret.delete`                                               | user  | secret name  | scope, package name                        |
| `package.save`, `package.delete`                                             | user  | package name | version, source, job names                 |
| `job.enable`, `job.disable`                                                  | user  | job id       | —                                          |
| `memory.create`, `memory.update`, `memory.delete.soft`, `memory.delete.hard` | user  | memory id    | category, status, package (never the text) |

**What is never in the log:** secret values, encrypted blobs, API tokens, the
admin token, master keys, run code or run results. Callers pass names and ids
only (`src/lib/audit.ts`), and the smoke test asserts that a freshly generated
secret value and a user token do not appear anywhere in `GET /admin/audit`.
The log is a record of _who changed what_, not a copy of the data.

## Smoke coverage

`npm run smoke` runs the `limits` scenario: `GET /admin/limits`, `usageGet`,
a per-user quota clamp that rejects the next run with `quota_exceeded` and the
second secret with the secrets quota, clearing the override, the audit log
(presence, filters, and the no-leak assertions above) and the retention bound.
Start the node with `KODY_EXECUTE_TIMEOUT_MS=5000` and run
`SMOKE_EXPECT_TIMEOUT_MS=5000 npm run smoke` to also prove a long run is cut off
at the configured timeout.
