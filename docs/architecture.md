# Architecture

kody-celld is one Worker plus three Durable Object classes and two Worker
Entrypoints, all in a single `celld` deployment. Everything a user does enters
through MCP (`/mcp`) or the equivalent direct API (`/api/call/:capability`);
operators use `/admin/*` with the admin token.

```
                ┌──────────────────────────── celld node(s) ────────────────────────────┐
 MCP client ──► │ src/index.ts (Worker)                                                 │
  Bearer token  │   /mcp  ─► mcp/server.ts ─► search | execute                          │
                │   /api  ─► capabilities (host-side call)                              │
 admin ───────► │   /admin ─► users, tokens, secret hosts, jobs, runs                   │
                │   cron * * * * * ─► jobs/dispatcher.ts                                 │
                │                                                                       │
                │   RegistryCell (DO, 1)     users + hashed API tokens                  │
                │   UserCell (DO, per user)  packages, secrets (encrypted), hosts,      │
                │                            jobs, runs, gateway events                 │
                │   PackageStorageCell (DO, per user×package)  KV + free-form SQLite    │
                │                                                                       │
                │   execute ─► module graph ─► LOADER.get(hash) ──► isolate             │
                │        env.KODY = RuntimeHost({props})      ◄─ kody.<capability>()    │
                │        globalOutbound = FetchGateway({props}) ◄─ fetch()  ─► internet │
                └───────────────────────────────────────────────────────────────────────┘
                                          ▲ S3-compatible bucket (celld durability)
```

## Request lifecycle: `execute`

1. `POST /mcp` → JSON-RPC `tools/call` `execute` with `{ source, params?, idempotencyKey? }`.
2. `authenticateUser` resolves the bearer token in `RegistryCell` and gets the
   caller's `UserCell` stub.
3. `executeRun` (`src/execute/engine.ts`) records a `run` row (idempotency
   replay happens here), then `buildModuleGraph` produces a flat module map:
   - the caller's source becomes `main.js` wrapped by `wrapper-module.ts`
     (console capture, `AsyncLocalStorage` run context, result serialisation);
   - `kody:runtime` is the host-owned source string in `runtime-module.ts`;
   - `kody:@scope/pkg/export` pulls saved package files from `UserCell`,
     stamps `packageStorage()` with the declaring package name, rewrites every
     relative import to `./<full path>`, converts JSON to ES modules and drops
     docs;
   - bare npm specifiers (experimental) are fetched from esm.sh and inlined.
4. `env.LOADER.get(hash(user, modules))` creates or reuses an isolate whose
   only bindings are `KODY` (a `RuntimeHost` Worker Entrypoint with
   `props = { userId, email, packageName }`) and `globalOutbound`
   (`FetchGateway`, same props). The isolate has **no** access to the host
   `Env`, other users, or the network except through those two.
5. The wrapper runs `default(params)`, captures logs, and posts
   `{ result | error, logs }` back. `engine.ts` finalises the run row and
   returns `{ runId, ok, result, logs, warnings, gateway, packages }`.

`kody.<capability>(args)` inside the isolate is a Proxy that RPCs
`RuntimeHost.capability(name, args, { runId, packageName })`. `RuntimeHost`
rebuilds a `CapabilityContext` with `fromRuntime: true`, so host-only
capabilities (e.g. `packageRun`, host approval) refuse sandbox callers.

## Secrets at the boundary

Outbound `fetch()` in an isolate goes to `FetchGateway.fetch` on the host:

1. Scan URL, headers and body for placeholders (`src/secrets/placeholders.ts`).
2. No placeholders → forward as-is, record `outcome: 'forwarded'`.
3. Placeholders → check the destination host against the user's approved list
   (`host-policy.ts`, exact or `*.example.com`), require HTTPS unless the host
   is a configured loopback dev host, decrypt referenced secrets, replace,
   forward, record `outcome: 'injected'` with secret **names** only.
4. Any failure → `outcome: 'denied'` and a synthetic 403/404 JSON response;
   nothing leaves the box.

Values are encrypted in `UserCell` with AES-GCM under an HKDF key derived from
`KODY_MASTER_KEY` and the user id (`src/lib/crypto.ts`). Rotating the master
key requires re-encryption (not implemented — see known gaps).

## Jobs

`package.json#kody.jobs` is validated on `packageSave` (`src/packages/manifest.ts`,
`src/jobs/schedule.ts`) and reconciled into `UserCell.jobs`. celld's cron
trigger calls `scheduled()` every minute → `dispatchDueJobs` iterates users,
asks each `UserCell` to atomically claim due jobs (advancing `next_run_at`
before running so a crash cannot double-fire), then executes the entry via
`executeRun` with `kind: 'job'` and records a `job_run`.

## Durable Objects

| Class                | Key                      | Holds                                                                                                   |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `RegistryCell`       | `"registry"` (singleton) | users, SHA-256 token hashes → user id                                                                   |
| `UserCell`           | user id                  | packages (files + manifest), secrets (ciphertext), approved hosts, jobs, job runs, runs, gateway events |
| `PackageStorageCell` | `${userId}:${package}`   | `__kody_kv` table + whatever tables package `sql()` creates                                             |

All state is SQLite inside the DO; celld replicates it to the bucket. There is
no KV/D1/R2 usage yet, which keeps the fleet footprint to "DOs + bucket".

## Trust boundaries

- **Admin token** (`KODY_ADMIN_TOKEN`): creates users/tokens, approves secret
  hosts, forces job dispatch. Never accepted from the isolate (sandbox `fetch`
  to `/admin` is denied by the gateway).
- **User token** (`kody_...`): full access to that user's cell, nothing else.
- **Isolate**: talks only to `RuntimeHost` and `FetchGateway`, both scoped by
  `props.userId`. Reused isolates are keyed by user, so code never shares an
  isolate across users.
- Non-loopback requests are refused outright while the dev placeholder
  `KODY_ADMIN_TOKEN`/`KODY_MASTER_KEY` are in effect (`insecureConfigError`).
