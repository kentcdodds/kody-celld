# kody-celld agent index

Self-hosted [Kody](https://github.com/kentcdodds/kody) core on
[Deno celld](https://celld.dev). Read [README.md](./README.md) first.

`npm run validate` is the single authoritative local gate (typecheck, oxlint,
prettier check, `node --test`). Run `npm ci --prefix mail-bridge` once first.
`npm run smoke` (with `npm run dev` running) is the integration gate; use
`npm run smoke:cron` when touching jobs or the dispatcher.

This file is a map, not the docs. Open the page that owns the task:

- Engineering principles: [docs/principles/](./docs/principles/index.md)
- Contributor documentation map:
  [docs/contributing/index.md](./docs/contributing/index.md)
- Security invariants:
  [docs/contributing/security-invariants.md](./docs/contributing/security-invariants.md)
- celld quirks:
  [docs/contributing/celld-compat.md](./docs/contributing/celld-compat.md)
- Web UI (mirrors hosted; port upstream diffs):
  [docs/web-ui.md](./docs/web-ui.md)
- Architecture: [docs/architecture.md](./docs/architecture.md)

## Where things live

| Path           | Role                                                               |
| -------------- | ------------------------------------------------------------------ |
| `src/`         | Worker, Durable Objects, capabilities, execute, secrets, jobs, web |
| `client/`      | Remix 3 page components and islands                                |
| `universal/`   | Shared Worker + browser code (routes, loader data, styles, icons)  |
| `public/`      | Static assets (`styles.css`, fonts, Vite `build/`)                 |
| `smoke/`       | Integration smoke suite                                            |
| `mail-bridge/` | Optional SMTP sidecar                                              |
| `docs/`        | Human + agent docs                                                 |

Style: TypeScript strict, tabs, no semicolons, single quotes (prettier is the
authority). Unit tests sit beside the module as `*.test.ts`.
