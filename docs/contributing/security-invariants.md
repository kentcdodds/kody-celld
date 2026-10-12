# Security invariants

Non-negotiable rules for kody-celld. Violating any of these is a one-way door:
escalate to Kent.

## Secrets never leave the gateway

Placeholder replacement happens only in `src/secrets/fetch-gateway.ts`. Nothing
else may decrypt secret values, and nothing may log or return them (run history
stores secret _names_). Host approval is admin-only; sandbox code must never
gain a path to approve hosts.

The same applies to credentials: API tokens, OAuth client secrets / codes /
tokens, session ids and sign-in links are stored **hashed** and returned
exactly once at issuance; `fromRuntime` calls may not mint or revoke them.

## Browser mutations are same-origin POSTs with CSRF

Form handlers in `src/web` and `src/oauth/routes.ts` keep `assertSameOrigin` +
`assertCsrf` on every mutation. Keep the consent form's signed state. Render
pages only through `renderPage()` (`src/app/render.tsx`) with a serialisable
`AppLoaderData` payload: never string-concatenate HTML, and never put
token/secret values or session ids into loader data except the one-time reveal
at issuance.

## No real secret values in code, docs, fixtures, or smoke output

Smoke tests generate random values at runtime and assert with SHA-256 digests.
`wrangler.jsonc` vars are only the loopback operator placeholders (admin /
master / public URL). Smoke-only values (email, private-host allowances) live
in `.dev.vars.example` → `.dev.vars` for `npm run dev`; fleet values are
rendered into the git-ignored `wrangler.fleet.jsonc`.

## Two MCP tools only

`search` and `execute`. New behaviour is a new capability in
`src/capabilities/*` (picked up by `search`), not a new tool.

## Package provenance is structural

`packageStorage()` in a saved package is stamped with its package name at
graph-build time; ad hoc code gets no scratch storage. Keep that invariant when
touching `src/execute/module-graph.ts`.

## The app origin never serves first-party routes

Package apps are served only on the host(s) from `KODY_APP_BASE_URL`, and a
request for those hosts is answered by the app branch at the top of the router
in `src/index.ts`; `/mcp`, `/api`, `/admin`, `/oauth`, sign-in, console and the
rest are unreachable there. If the setting is unset or invalid, apps stay off;
they are never served on `KODY_PUBLIC_URL`. Keep that branch first and never
add a same-origin fallback ([decision 0019](./decisions/0019-package-app-origin.md)).

## Kody credentials never reach package-app code

Kody cookies (`kody_session`, `kody_console`, `kody_app_session`,
`kody_app_state`), the `__kody_handoff` parameter and every `x-kody-*` request
header are stripped before a request reaches app code, and apps cannot set
those cookies or `x-kody-*` headers on responses. Both directions live in
`src/apps/forward.ts` (`buildAppRequest`, `sanitizeAppResponse`); change them
only with tests that pin the stripping.

## Errors cross RPC by name

`KodyError` encodes `code:status` into `error.name` so it survives Durable
Object / Worker Entrypoint hops; use `KodyError.fromUnknown` when catching on
the far side.
