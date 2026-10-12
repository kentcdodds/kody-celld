# 0019: Package apps run on a separate origin

- **Status:** accepted
- **Date:** 2026-10-12

## Context

Issue [#42](https://github.com/kentcdodds/kody-celld/issues/42) asks for hosted
Kody's package apps on kody-celld: a package declares `kody.app` and serves a
browser app. Package code is installed by users, often from elsewhere, and runs
with the owner's secrets and capabilities. Served on the Kody origin, a script
in an app could read account pages, call the browser routes with the owner's
cookie and approve its own access.

Kent's decision on #42 (2026-10-10) fixed the shape: a separate app origin, a
configured app base URL, hosted Kody's handoff-token design for cross-site
auth, and server-rendered first with client bundles later.

Alternatives considered:

- **Same origin under a path (`/apps/...` on `KODY_PUBLIC_URL`).** Simplest, and
  no new DNS. Rejected: it hands every app the account's cookies and DOM.
- **Public apps with their own login.** Out of scope; apps are private to the
  owner for now.

## Decision

- Apps are served only on the host(s) named by `KODY_APP_BASE_URL`: a plain
  origin (path mode, `/u/<userId>/packages/<name>/`) or a `*.` wildcard
  (subdomain mode, `user-<hex>.<host>/packages/<name>/`). If it is unset or
  invalid, apps are off. Nothing falls back to `KODY_PUBLIC_URL`.
- The only way in is `/apps/open` on the main origin, which mints a 60 second,
  single-use handoff token bound to the user, the package, the Kody web session
  and a browser `state` cookie set by the app origin (so a link cannot sign
  another person's browser in). The app origin trades it for a 12 hour
  `kody_app_session`, re-checked against the Kody session on every request.
- Access is owner-only.
- Kody cookies and `x-kody-*` headers never reach app code, and apps cannot set
  Kody cookies.
- Apps are server-rendered. `kody.app.client` is stored with a save warning;
  assets are text-only and are served in a follow-up PR.

## Consequences

- The origin split is a one-way door for the security model of installed code:
  no same-origin mode will be added, even as an option.
- Operators run two URL modes. Path mode needs one DNS name and cert but users
  share an origin (use subdomain mode for multi-user installs); subdomain mode
  needs wildcard DNS and a wildcard cert.
- Apps cannot be shared or made public yet, and have no client bundles, binary
  assets, realtime or `packageAppFetch`. See [known-gaps.md](../../known-gaps.md).
- Apps and Kody should sit on different registrable domains; on a shared parent
  domain, app JS can plant cookies the Kody origin receives (see
  [package-apps.md](../../package-apps.md)).
- Rotating `KODY_MASTER_KEY` signs everyone out of their apps.
- Only failures write run records, so a busy app does not fill run history.
