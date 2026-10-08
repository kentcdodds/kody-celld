# Jobs

Jobs are **package-owned**: a package declares them in `package.json#kody.jobs`
and `packageSave` creates, updates or removes the corresponding job rows.
There is no free-standing "schedule this snippet" job in v1 (same as Kody).

## Declaring

```json
"kody": {
  "jobs": {
    "tick":     { "entry": "./tick.js",   "schedule": { "type": "interval", "every": "5m" } },
    "nightly":  { "entry": "./report.js", "schedule": { "type": "cron", "expression": "0 3 * * *" }, "timezone": "America/Denver" },
    "backfill": { "entry": "./backfill.js", "schedule": { "type": "once", "runAt": "2026-10-01T09:00:00Z" } },
    "paused":   { "entry": "./x.js", "schedule": { "type": "interval", "every": "1h" }, "enabled": false }
  }
}
```

- `interval.every`: `90s`, `5m`, `2h`, `1d`, `2 hours` … minimum **1 minute**
  (the dispatcher tick).
- `cron.expression`: 5-field cron with `*`, lists, ranges and steps; evaluated
  in `timezone` (IANA) or UTC.
- `once.runAt`: ISO timestamp; a past-due `once` job runs at the next tick,
  then is exhausted (`nextRunAt: null`).

The entry module's default export receives
`{ jobName, packageName, scheduledFor, trigger: 'cron' | 'manual', jobId }`
and runs with the package's provenance (so `packageStorage()` works).

## Dispatch

`wrangler.jsonc` registers `"crons": ["* * * * *"]`. Each minute celld invokes
`scheduled()` → `dispatchDueJobs` (`src/jobs/dispatcher.ts`):

1. For each user, `UserCell.jobsClaimDue(now)` selects
   `enabled AND next_run_at <= now`, and **advances `next_run_at` before
   returning** the claimed rows. A crash mid-run therefore skips, never
   duplicates, a slot.
2. Each claimed job runs through the normal `executeRun` path with
   `kind: 'job'`, so it shares timeouts, run history, gateway policy and
   isolate reuse with `execute`.
3. A `job_run` row records `status`, `runId`, `scheduledFor`, `startedAt`,
   `finishedAt`, `error`.

On a multi-node fleet celld hands the cron trigger to one owner, so a tick
dispatches once. (Verified on single-node `celld dev` with `npm run smoke:cron`;
multi-node cron is on the unverified list in [run-fleet.md](./run-fleet.md).)

## Capabilities

```ts
import { kody } from 'kody:runtime'
await kody.jobList()
await kody.jobGet({ id, runs: 10 })
await kody.jobUpdate({ id, enabled: false })
await kody.jobRuns({ jobId: id, limit: 20 })
```

`jobRunNow({ id })` is host-only (`POST /api/call/jobRunNow`) and records a
run with `trigger: 'manual'`. `POST /admin/jobs` forces a dispatch cycle for
every user — handy right after a deploy or to test without waiting a minute.
`GET /admin/users/:id/jobs` lists a user's jobs for operators.

## Failure semantics

- A job whose run errors is recorded as `status: 'error'` and keeps its
  schedule; it is not disabled automatically.
- `execute_timeout` (60 s) applies.
- Deleting the package deletes its jobs; re-saving with a changed schedule
  recomputes `nextRunAt` from now.

## Run triage

Failed runs can be soft-triaged, as in kody (`docs/use/activity.md`):

- `runSummary({ since? })` — "is anything broken?": total, open `errors`
  (not ignored/resolved), `ignored`, `resolved`, `running`, and `byKind`.
- `runUpdate({ runId, triage, note? })` — mark an **error** run `ignored` or
  `resolved`, or `open` to clear triage. Status, error, logs and result never
  change. Omit `note` to keep it, pass `""` to clear it (max 2000 characters).
- `runUpdateBulk({ runIds | filter, triage, note?, limit?, dryRun? })` — up to
  100 error runs by id or by an exact filter (`kind`, `packageName`, `jobId`,
  `errorName`, `errorMessage`, plus `errorTriage`, default `open`). Preview with
  `dryRun`, repeat while `hasMore`. A filtered reopen must name
  `errorTriage: "ignored"` or `"resolved"`.
- `runList({ errorTriage })` — `open | ignored | resolved | all`. Unlike
  kody, the default is `all`, so existing callers see every run. `open` is
  unhandled **error** runs only; kody's list `open` still shows successes and
  running (it only hides ignored/resolved).

When a job run succeeds, **earlier** open errors of the same job (strictly
older `created_at`, with `id` as a tie-break) are marked `resolved`
(`triagedBy: "system:auto-resolve"`); runs you ignored are left as they are.
(Kody excludes only `id !=` the success; celld also bounds by start time so a
later overlapping failure stays open.) Job runs recorded before this feature
carry no job id, so their errors stay open until you triage them: list open
errors (`runList({ errorTriage: "open" })`), pick the ones with a null
`jobId`, and pass those ids to `runUpdateBulk({ runIds, … })` — do not use a
`packageName`-only filter, which would also match current open errors. The
Activity page (`/account/runs`) shows the same counts, opens on Open errors
when there are any, and has Ignore / Resolve / Reopen buttons.
