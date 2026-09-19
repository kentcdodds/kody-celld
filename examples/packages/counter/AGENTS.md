# Agent notes: @kody-smoke/counter

- Call `kody:@kody-smoke/counter` (default export) for a read-only status.
- Call `kody:@kody-smoke/counter/increment` with `{ by }` to bump the counter.
- The `tick` job runs every minute; check `kody.jobRuns({ jobId })` for history.
- Storage lives in the package's own SQLite cell; nothing here touches other packages.
