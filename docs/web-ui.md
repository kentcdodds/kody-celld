# Web UI: sign-in, account, operator console

kody-celld ships a small server-rendered web UI so that people who self-host
it do not have to drive everything with `curl` and an admin token. It is
deliberately minimal (no JavaScript, no build step, no framework): every page
is a plain HTML form posted back to the same route. The MCP surface is
unchanged — the UI is a convenience layer over the same cells and
capabilities.

| Route                 | Who              | What                                                                            |
| --------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `/`                   | anyone (browser) | redirects to `/account` (signed in) or `/signin`; API clients still get JSON    |
| `/setup`              | first run only   | create the first account with the admin token + a password                      |
| `/signin`             | anyone           | password, one-time API token, or magic link (when outbound email is configured) |
| `/signin/link/:token` | anyone with link | invite / password reset (set a password) or magic sign-in (one click)           |
| `/signout`            | signed-in user   | `POST` — ends this browser session                                              |
| `/account/*`          | signed-in user   | the account pages below                                                         |
| `/oauth/authorize`    | signed-in user   | MCP client consent ([mcp-oauth.md](./mcp-oauth.md))                             |
| `/console/*`          | operator         | admin console, signed in with `KODY_ADMIN_TOKEN`                                |

## First run

With no users in the registry, `/signin` redirects to `/setup`. Enter the
admin token from your deployment (`KODY_ADMIN_TOKEN` in `.env`, or
`docker compose exec kody cat /data/kody.env`), your email, and a password
(12+ characters). That creates the first user and signs you in; `/setup` then
disappears for good. The old bootstrap (`POST /admin/users` + API token) keeps
working and is what the smoke tests use.

## Getting more people in

Accounts are created by the operator — there is no open registration:

- **Console → Users → Add a user** creates the account and shows a one-time
  **invite link** (valid 7 days). Hand it over out of band; the person opens
  it, sets a password, and is signed in. The same form can issue a **password
  reset** link for an existing account or a plain **API token**.
- **API**: `POST /admin/users/:id/invite` `{}` (or `{"reset":true}`) returns
  `{ url, expiresAt, kind }`.
- Links are single-use and are only consumed **after** the new password passes
  validation, so a typo does not burn the invite. Expired or reused links show
  a 410 page.

## Sign-in

- **Password**: PBKDF2-SHA256, 600k iterations, per-user salt; records below
  the current work factor are upgraded transparently on the next successful
  sign-in. Five wrong passwords lock the email for 15 minutes (`429`), even
  for the right password.
- **API token**: paste a `kody_…` token once to get a browser session; the
  token is not stored by the browser.
- **Magic link**: shown only when an outbound email adapter is configured
  ([email.md](./email.md)). The form answers identically whether or not the
  address has an account. Links are valid 15 minutes and single-use.
- **Sessions**: a random id, stored **hashed** in the registry, in an
  `HttpOnly; SameSite=Lax` cookie (`Secure` when `KODY_PUBLIC_URL` is https),
  30 days. Every state-changing form carries a session-bound CSRF token and
  must be a same-origin `POST` (cross-site `Origin` / `Sec-Fetch-Site` are
  refused). Sessions are listed and revocable at `/account/sessions`.
- `?next=` after sign-in only accepts same-origin paths (`/account/…`,
  `/oauth/authorize?…`); anything else falls back to `/account`.

## Account pages (`/account`)

| Page             | You can                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview         | see today's usage vs quotas, change your password                                                                                                  |
| MCP clients      | see every OAuth client you authorized (name, scope, last use), revoke one or all                                                                   |
| API tokens       | list (label, created, last used — never the value), create (value shown **once**), revoke                                                          |
| Secrets          | list names + approved hosts, add/replace a value (paste form; the value is never rendered again), delete                                           |
| Packages         | list saved packages with their exports/jobs/webhooks/source, install from GitHub or a URL, publish / republish / unpublish to `/community`, delete |
| Jobs             | list schedules, last run, enable/disable                                                                                                           |
| Runs             | recent run history (status, duration, error names — never secret values)                                                                           |
| Integrations     | connected OAuth integrations and their status, disconnect                                                                                          |
| Inbox            | email inboxes and recent messages                                                                                                                  |
| Browser sessions | list and revoke (this one or all others)                                                                                                           |

Host approvals are intentionally **not** on the account pages — they stay an
operator decision (see [secrets.md](./secrets.md)); the Secrets page shows the
approved list and tells the user to ask.

## Operator console (`/console`)

Sign in with `KODY_ADMIN_TOKEN` (12-hour cookie, separate from user sessions,
`Path=/console`). Pages:

- **Users** — list with usage; add a user (returns an invite link); issue a
  reset link or an API token for a user; force a jobs dispatch.
- **User detail** (`/console/users/:id`) — approve / revoke secret hosts, view
  quotas (overrides stay on `PUT /admin/users/:id/quota`), sign the user out
  everywhere (browser sessions **and** OAuth grants).
- **Audit** (`/console/audit`) — the admin audit log, filterable by `actor`
  and `action` (`?actor=…&action=…&limit=…`).
- **Config** (`/console/config`) — version, public URL, and the effective AI /
  blob / browser / email adapter configuration (the same summaries
  `GET /admin/ai`, `/admin/blobs`, `/admin/browser`, `/admin/email` return;
  secret-bearing values are never included).

Everything the console does is also available on the JSON `/admin/*` API
([operations.md](./operations.md)), and every action is recorded in the audit
log with `via: 'console'`.

## Security notes

- Responses set `Content-Security-Policy: default-src 'none'; …`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Cache-Control:
no-store`. Rendering goes through an auto-escaping `html` tagged template;
  raw markup is opt-in (`raw()`) and only used for constant strings.
- Secrets, token values, master keys and admin tokens never appear on a page
  except the one-time token reveal after creation.
- Failed sign-ins (password, token, console) are audited with the method but
  without the submitted value.
- The UI is `Accept: text/html` negotiated: the same URLs return JSON to API
  clients, and `wantsHtml()` refuses to treat `Sec-Fetch-Mode: cors` requests
  as browser navigations.

## Smoke

`node smoke/run.mjs web` (part of `npm run smoke`) covers the redirect
matrix, invite issuance and acceptance (short password first, reuse after),
CSRF / cross-site refusal, token create → use → revoke, secrets add/list/delete
without echoing the value, every read-only page, password and token sign-in,
sessions and revoke-others, lockout after five failures, password change
checks, sign-out, the console sign-in/users/hosts/audit/config/invite flow, and
that a user cannot approve a host from their own pages.
