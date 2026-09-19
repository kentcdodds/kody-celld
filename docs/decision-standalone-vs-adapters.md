# Decision: standalone project with shared contracts, not adapters in kentcdodds/kody

**Status:** accepted for the experiment. Revisit if kody-celld graduates.

## Options considered

1. **One codebase with adapters** — add a celld target to kentcdodds/kody,
   behind runtime adapters for the Cloudflare-only bindings.
2. **Fork** kentcdodds/kody and strip what celld cannot run.
3. **Standalone core** that re-implements the contracts (MCP tool shapes,
   placeholder grammar, package manifest, `kody:runtime`, job schedules) on
   celld, with production Kody as the reference. ← chosen

## Why not adapters (option 1)

Production Kody is a multi-worker Cloudflare fleet: the app worker, an MCP
worker, Vectorize-backed memories, Workers AI / AI Gateway, Email Routing,
Queues, Browser Rendering, OAuth connectors, a Remix UI, and a large capability
catalog that assumes those bindings exist. The `execute` surface alone touches
Vectorize (memory search), AI (embeddings), and email. Making each of those
optional behind adapters means:

- an adapter interface for ~10 bindings, most of which have no celld
  equivalent yet (Vectorize, AI, Email Routing, Browser Rendering);
- guarding every capability and UI route with "is this binding present";
- a second bundler/compat matrix (celld's Worker Loader resolves specifiers
  differently and rejects `text`/`json` module types — see AGENTS.md);
- coordinating changes with production deploys, which this experiment must not
  put at risk.

That is a multi-week refactor of a moving codebase to reach the same v1 line
that a focused standalone core reaches directly, and its blast radius is
production kody.codes.

## Why not a fork (option 2)

A fork inherits the full dependency graph (Remix, agents SDK, Vectorize types,
…) and drifts immediately with no shared code to pull from. It would be the
worst of both: large surface, no sharing.

## What we share instead

Contracts, not code:

| Contract                                                                                                        | Where kody-celld follows production |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| MCP: exactly `search` + `execute`, structured results, `kody.<cap>(args)`                                       | `src/mcp/*`, `src/capabilities/*`   |
| `execute` module shape: `export default async function main(params)`                                            | `src/execute/wrapper-module.ts`     |
| `import { kody, packageStorage } from 'kody:runtime'`                                                           | `src/execute/runtime-module.ts`     |
| `kody:@scope/pkg/export` imports                                                                                | `src/execute/module-graph.ts`       |
| Package manifest: `package.json` + README + AGENTS, `kody.jobs`, `kody.hidden`                                  | `src/packages/manifest.ts`          |
| Secret placeholders `{{secret:…}}`, `{{secret-basic:…}}`, `{{secret/provider:…}}`, `{{integration-token:…}}`, ` | scope=package`, URL-safe delimiters | `src/secrets/placeholders.ts`     |
| Host-gated injection at the network boundary, HTTPS-only, names-only history                                    | `src/secrets/fetch-gateway.ts`      |
| Job schedules `cron                                                                                             | interval                            | once`, timezone, minimum 1 minute | `src/jobs/schedule.ts` |

Because the contracts match, a package or `execute` snippet written for
kody.codes that only uses these surfaces runs unchanged here (the smoke suite's
`@kody-smoke/*` packages are written that way). The reverse is also true, which
is the path to sharing later: extract the contract modules from production into
a `@kody/core` package once both sides have stopped moving, then have both the
Cloudflare app and kody-celld depend on it.

## Costs accepted

- Duplication of contract code (~1.5k lines) that must be kept in sync by
  hand. AGENTS.md asks PRs that borrow behaviour to cite the production file.
- No production UI, memories, AI, email, or OAuth connectors. Listed in
  [known-gaps.md](./known-gaps.md).
- Capability catalog is a subset (packages, secrets, jobs, runs, storage,
  system). Clients that call other production capabilities get
  `unknown_capability`.
