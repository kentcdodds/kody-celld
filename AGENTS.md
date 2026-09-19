# kody-celld agent guide

Self-hosted Kody core on celld. Read [README.md](./README.md) first; this file
is the contributor contract.

## Gates

`npm run validate` (typecheck, oxlint, prettier check, `node --test` unit tests
— run `npm ci --prefix mail-bridge` once first; the sidecar's tests import its
own dependencies) must pass before a PR. `npm run smoke` (with `npm run dev` running) is the
integration gate; run `npm run smoke:cron` when touching jobs or the dispatcher.
GitHub Actions (`.github/workflows/ci.yml`) runs `validate` and the full
`smoke:cron` against the single-node Docker image on every PR; run both locally
too and paste the smoke summary line in the PR.

## Non-negotiables

- **Secrets never leave the gateway.** Placeholder replacement happens only in
  `src/secrets/fetch-gateway.ts`. Nothing else may decrypt secret values, and
  nothing may log or return them (run history stores secret _names_). Host
  approval is admin-only; sandbox code must never gain a path to approve hosts.
  The same applies to credentials: API tokens, OAuth client secrets / codes /
  tokens, session ids and sign-in links are stored **hashed** and returned
  exactly once at issuance; `fromRuntime` calls may not mint or revoke them.
- **Browser mutations are same-origin `POST`s with a CSRF token** (`src/web`,
  `src/oauth/routes.ts`). Keep `assertSameOrigin` + `assertCsrf` on every form
  handler, keep the consent form's signed state, and render pages only through
  `renderPage()` (`src/app/render.tsx`) with a serialisable `AppLoaderData`
  payload — never string-concatenate HTML, and never put token/secret values
  or session ids into loader data except the one-time reveal at issuance.
- **No real secret values in code, docs, fixtures, or smoke output.** Smoke
  tests generate random values at runtime and assert with SHA-256 digests.
  `wrangler.jsonc` vars are loopback-only placeholders; fleet values are
  rendered into the git-ignored `wrangler.fleet.jsonc`.
- **Two MCP tools only.** `search` and `execute`. New behaviour is a new
  capability in `src/capabilities/*` (picked up by `search`), not a new tool.
- **Package provenance is structural.** `packageStorage()` in a saved package is
  stamped with its package name at graph-build time; ad hoc code gets no
  scratch storage. Keep that invariant when touching `src/execute/module-graph.ts`.
- **Errors cross RPC by name.** `KodyError` encodes `code:status` into
  `error.name` so it survives Durable Object / Worker Entrypoint hops; use
  `KodyError.fromUnknown` when catching on the far side.

## celld compatibility rules

celld is not workerd. Things this codebase already works around — do not undo
them without re-testing on celld:

- The Worker Loader resolves import specifiers by **exact registered name**
  (`name` and `./name`); it does not walk `../`. Every module is registered
  under its full path and every import is rewritten to `./<full path>`
  (`relativeSpecifier` in `module-graph.ts`).
- Worker Loader modules must be **JS strings or wasm** — no `text`/`json`
  module types. JSON becomes `export default {...}`; docs are left out.
- RPC preserves only `name`/`message` on errors (hence the `KodyError` rule).
- `celld deploy` requires `main` to live inside the config's directory, which
  is why the rendered fleet config sits beside `wrangler.jsonc`.

## Web UI mirrors kody

`client/`, `universal/`, `public/` and `src/app/` are laid out like
`packages/worker/` in kentcdodds/kody and use the same stack (Remix 3
`remix/ui` + `remix/routes` + `remix/ui/server`, Vite client bundle served as
celld static assets). Design tokens, style primitives, `styles.css`, fonts,
icons and the shared components are verbatim copies — port upstream diffs
instead of restyling; page components adapt to our `AppLoaderData` shapes.
Pages must keep working with JavaScript off (forms round-trip; the browser
bundle only hydrates islands registered in `client/entry.tsx`). The recipe is
in [docs/web-ui.md](./docs/web-ui.md#porting-ui-changes-from-kody). Run
`npm run build:client` before `celld dev`/`deploy` (`npm run dev` and the
Dockerfile do).

## Style

TypeScript strict, tabs, no semicolons, single quotes (prettier is the
authority). Prefer small focused edits; keep comments for _why_, not _what_.
Unit tests sit beside the module as `*.test.ts` and run on Node's built-in
runner with type stripping — keep them free of Workers-only globals.

## Reference, not dependency

[kentcdodds/kody](https://github.com/kentcdodds/kody) is the contract reference
(MCP shapes, placeholder grammar, package manifest, job schedules). This repo
does not import from it and does not need to track it commit-for-commit; when
you borrow a behaviour, note the production file in the PR so drift is
reviewable. See [docs/decision-standalone-vs-adapters.md](./docs/decision-standalone-vs-adapters.md).
