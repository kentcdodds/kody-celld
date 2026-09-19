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
