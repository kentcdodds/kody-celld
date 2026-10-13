# 0020: `__Host-` prefixes for Kody first-party cookies

- **Status:** accepted
- **Date:** 2026-10-13

## Context

Issue [#81](https://github.com/kentcdodds/kody-celld/issues/81) (reported by
[@Averus89](https://github.com/Averus89)): when `KODY_APP_BASE_URL` and
`KODY_PUBLIC_URL` share a registrable domain, untrusted package-app JavaScript
can plant `Domain=<parent>` cookies that the Kody origin receives and that
shadow the host-only `kody_session` / `kody_console` (account lock-out; on
multi-user installs, login CSRF). Server-side `Set-Cookie` filtering cannot
stop client JS.

Hosted Kody keeps `kody_session` unprefixed because its package-app origin is
always a separate registrable domain. It already uses `__Host-kody_pkg_session`
on the app origin itself
([ADR 0017](https://github.com/kentcdodds/kody/blob/main/docs/contributing/decisions/0017-per-user-package-app-subdomains.md)).

Alternatives considered:

- **Document-only.** Already done; does not stop a planted cookie.
- **Soft rename (read old name for one release).** Softens the sign-out, but
  reopens the shadowing window for that release.
- **Require separate registrable domains in config.** Correct advice, but breaks
  many self-host layouts that share a parent DNS zone; refuse only same host
  today.

## Decision

- On https installs (`cookiesAreSecure(KODY_PUBLIC_URL)`), rename to
  `__Host-kody_session` and `__Host-kody_console` (Secure, Path=/, no Domain).
  The console cookie path moves from `/console` to `/` because `__Host-`
  requires it.
- Plain-http local/LAN keeps the unprefixed names (browsers refuse `__Host-`
  without Secure).
- Hard rename: the server never reads the other name. Upgrading an https
  install signs everyone out once.
- Log a clear once-per-isolate warning when the two origins share a
  registrable domain (Public Suffix List via `tldts`), recommending a separate
  domain even with `__Host-` in place.
- App-origin cookies (`kody_app_session`, `kody_app_state`) stay unprefixed:
  path-scoped in path mode, host-only and server-verified.

## Consequences

- Celld https installs differ from hosted's first-party cookie names; that is
  intentional for self-host layouts that share a parent domain.
- Operators on https must re-sign in after upgrade; document the one-time
  sign-out.
- A separate registrable domain for apps remains recommended advice.
