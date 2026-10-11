# Decision: faithful self-host of hosted Kody on celld

**Status:** accepted (Kent, Oct 10, 2026). kody-celld is a faithful
self-host of [kentcdodds/kody](https://github.com/kentcdodds/kody), not a
separate product.

## Reality (replace older claims)

This tree is on the order of **~55k lines** of TypeScript across `src/`,
`client/`, and `universal/`. It is not a thin contract reimplementation. It
includes:

- MCP `search` + `execute`, packages, secrets, jobs, runs, quotas, audit
- Sign-in and account/console web UI (Remix 3, mirrored from hosted)
- AI chat/embeddings adapters, memories (FTS5 + vectors), semantic search
- Email (inbound/outbound + `mail-bridge`), webhooks, blobs
- OAuth integrations, MCP OAuth 2.1 authorization server, external MCP clients

See [architecture.md](./architecture.md) for the runtime shape and
[known-gaps.md](./known-gaps.md) for the provision matrix.

## Options considered (historical)

1. **One codebase with adapters** inside kentcdodds/kody for a celld target.
2. **Fork** hosted Kody and strip Cloudflare-only pieces.
3. **Standalone tree** that re-implements contracts on celld, with hosted Kody
   as the reference. Chosen for the early experiment so production deploys
   were not put at risk.

That experiment graduated into the product stance below: stay standalone for
the celld runtime, but behave as a **faithful self-host** and share code
through a sync lock now and a `@kody/core` package later.

## Kent's decisions (Oct 10, 2026)

1. **Faithful self-host.** Every capability and contract either exists in
   hosted Kody first or lands there at the same time. celld-only code is
   limited to runtime and infrastructure adapters. See
   [Match hosted first](./principles/match-hosted-first.md).
2. **Package apps (#42) on a separate app origin.** Never same-origin on the
   operator URL. Match hosted's configured app base URL and handoff-token
   design. Decision recorded on
   [#42](https://github.com/kentcdodds/kody-celld/issues/42).
3. **Code sharing.** For now: a pinned, CI-checked sync lock
   ([shared-from-kody.md](./contributing/shared-from-kody.md),
   `shared-from-kody.json`) for principle pages, verbatim UI files, and
   contract modules tracked as adapted. A shared `@kody/core` package comes
   later; interim contract copies are tracked in
   [#69](https://github.com/kentcdodds/kody-celld/issues/69).
4. **Generic vendor adapters only.** Keep SMTP (mail-bridge),
   OpenAI-compatible AI, S3-compatible blobs, and a CDP browser. Vendor-named
   adapters (Postmark, Mailgun, SendGrid, Resend, Anthropic, browserless as a
   platform type, and similar) move to packages or are deleted. Implementation
   may land in a parallel PR (for example #67); this doc records the decision.
5. **One private-host allowlist.** Collapse the four private-host allowlist
   settings into a single `KODY_PRIVATE_HOSTS` (or equivalent). Same note:
   implementation may land separately; the product rule is one list.

## What we share with hosted Kody

| Layer                                                                     | How                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Contracts (MCP tools, placeholders, manifests, schedules, `kody:runtime`) | Match hosted behaviour; cite the hosted file in the PR                                                |
| Principle pages                                                           | Verbatim pins in `shared-from-kody.json`                                                              |
| Design tokens, style primitives, icons, shared UI helpers, fonts          | Verbatim pins when they match; adapted entries when celld must differ                                 |
| Contract module source                                                    | Interim local copies (adapted); replace via [#69](https://github.com/kentcdodds/kody-celld/issues/69) |
| Runtime                                                                   | celld Worker Loader, Durable Objects, S3 durability: celld-only                                       |

Because contracts match, packages and `execute` snippets written for
kody.codes that only use these surfaces run here (the smoke suite's
`@kody-smoke/*` packages are written that way).

## Intentional divergences

Document every lasting divergence here (and in the PR that introduces it).
Short list as of Oct 10, 2026:

| Divergence                                                                         | Reason                                                                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| celld Worker Loader module graph (`relativeSpecifier`, JS/wasm only)               | celld is not workerd; see [celld-compat.md](./contributing/celld-compat.md)                                    |
| Local schedule / placeholders / manifest implementations                           | Hosted lives under `@kody-internal/shared` / larger worker paths; shared `@kody/core` tracked in #69           |
| Adapted UI shells (`app-root`, `entry`, header/footer, `loader-data`, `routes`, …) | Self-hosted page set and island hydration; listed in [shared-from-kody.md](./contributing/shared-from-kody.md) |
| `public/styles.css` subset                                                         | No hosted marketing/org surfaces                                                                               |
| TypeScript/TSX package transpile via sucrase (and related)                         | Hosted uses `@cloudflare/worker-bundler`; spike whether celld can switch before #42 needs a browser bundler    |
| Provision matrix (SMTP bridge, S3, CDP, OpenAI-compatible)                         | Self-host operators bring their own services; stay generic per decision 4                                      |

If a change cannot match hosted, write the reason in the PR and add a row
above.

## Costs accepted

- Duplication until `@kody/core` lands (#69), gated by the sync lock so
  verbatim files cannot drift silently.
- Some hosted surfaces remain deferred or hosted-only (billing, experiments,
  workflows). See [known-gaps.md](./known-gaps.md) and [web-ui.md](./web-ui.md).
- Capability catalog may lag hosted; unknown capabilities return
  `unknown_capability`.

## Related

- [Engineering principles](./principles/index.md)
- [Architecture](./architecture.md)
- [Shared-from-kody sync lock](./contributing/shared-from-kody.md)
- [Security invariants](./contributing/security-invariants.md)
