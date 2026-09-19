# Web UI: sign-in, account, operator console

kody-celld ships a server-rendered web UI so that people who self-host it do
not have to drive everything with `curl` and an admin token. It is built on the
same stack and design system as [kentcdodds/kody](https://github.com/kentcdodds/kody)
— Remix 3 (`remix/ui` components, `remix/routes` typed routes,
`remix/ui/server` streaming SSR) with a Vite-built browser bundle — so that
upstream UI changes can be ported with a path strip (see
[Porting UI changes from kody](#porting-ui-changes-from-kody)). Every page is
still a plain HTML form posted back to the same route and works with
JavaScript disabled; the browser bundle only hydrates small islands (copy
buttons, double-confirm buttons, the header menu, toasts). The MCP surface is
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

## How it is built

The layout mirrors `packages/worker/` in kody so files line up one-to-one:

| kody-celld                            | kody (`packages/worker/`)   | What lives there                                                                                                       |
| ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `client/`                             | `client/`                   | `remix/ui` components: `app-root.tsx` (shell + route dispatch), `routes/*.tsx` (one per page), header, footer, islands |
| `universal/`                          | `universal/`                | code shared by Worker and browser: `routes.ts` (typed routes), `loader-data.ts` (page payloads), `styles/`, icons      |
| `src/app/`                            | `src/app/`                  | Worker-side SSR: `render.tsx` (`renderPage`), `ssr-document.tsx`, `security-headers.ts`, `ssr-stubs/`                  |
| `public/`                             | `public/`                   | static assets served by celld: `styles.css`, `fonts/`, `page-init.js`, `build/` (Vite output, git-ignored)             |
| `src/web/*.ts`, `src/oauth/routes.ts` | `src/app/routes/*` handlers | request handling: auth gates, form parsing, mutations; they build an `AppLoaderData` and call `renderPage()`           |

Import aliases are the same as upstream: `#client/*`, `#universal/*`,
`#app/*` (`tsconfig.json`, `vite.config.ts`). Design tokens
(`universal/styles/tokens.ts`), style primitives
(`universal/styles/style-primitives.ts`), `public/styles.css`, the self-hosted
fonts and the icon glyphs are copied from kody verbatim; keep them that way
and put kody-celld-specific styling in the page components.

Rendering flow for a page:

1. The handler (e.g. `src/web/account.ts`) authenticates, reads the form with
   `readForm()`, mutates, and builds a **serialisable** payload — one variant
   of the `AppLoaderData` union in `universal/loader-data.ts`. Only data the
   page may show goes in there (never token values after issuance, never
   secret values, never session ids).
2. `renderPage()` (`src/app/render.tsx`) streams `<AppRoot>` inside
   `SsrDocument` with `renderToStream` from `remix/ui/server`, prepends the
   doctype, applies the security headers, and lets the handler override
   status / headers.
3. `client/app-root.tsx` renders the shell (skip link, `SiteHeader`, flash,
   `<main>`, `SiteFooter`, `Toaster`) and dispatches on `data.page` to the
   route component in `client/routes/`.
4. In the browser, `client/entry.tsx` hydrates only the islands the page
   embedded (`clientEntry()` → `/build/client-entry.js#ExportName`); no data
   fetching happens client-side and every form still round-trips. `run()`
   would otherwise replay same-origin links and forms as `fetch()` frame
   navigations; the entry stops the Navigation API event first so they stay
   native document navigations (OAuth consent and connect flows redirect
   cross-origin, which a fetch under `connect-src 'self'` cannot follow).
   Do not name a form field `method` or `enctype`: the runtime reads those
   `HTMLFormElement` properties on submit and a field of that name shadows
   them with the element.

The Worker typecheck (`tsconfig.worker-typecheck.json`) maps
`#client/app-root.tsx` to `src/app/ssr-stubs/app-root.ts` so DOM-only code
never enters the Workers type-world; `tsconfig.client.json` checks `client/`
with the DOM lib. celld's esbuild reads `tsconfig.json` (no stub) and bundles
the real components for SSR.

Build: `npm run build:client` (Vite → `public/build/`). `npm run dev`,
`npm run fleet:deploy` and the Dockerfile run it for you; celld serves
`public/` through `assets.directory` in `wrangler.jsonc`.

## Porting UI changes from kody

1. Find the upstream change under `packages/worker/{client,universal,public,src/app}`.
   The same relative path exists here (drop the `packages/worker/` prefix).
2. Tokens, primitives, `styles.css`, fonts, icons, `SiteHeader`/`SiteFooter`,
   `RecordTable`, `CopyTextButton`, `DoubleCheck`, `Toaster`, `UserAvatar`:
   apply the diff as-is.
3. Route components: apply the visual diff, then reconcile props against the
   matching `AppLoaderData` variant. kody's routes read from its D1/DO data
   model; ours come from the celld cells, so field names may differ — change
   the loader data (and the handler that fills it) rather than fetching in the
   component.
4. Anything that needs new browser behaviour becomes a small island exported
   from `client/entry.tsx`; do not move form handling into the client.
5. Run `npm run validate`, `npm run dev` + `node smoke/run.mjs --only web`
   (and `oauth-server`, `community` when touching those pages).

Not ported on purpose: kody's client-side router / no-flash navigation, the
landing page and marketing sections, Cloudflare Turnstile, OG image rendering.

## Security notes

- Responses set `Content-Security-Policy: default-src 'none'; …`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Cache-Control:
no-store` (`src/app/security-headers.ts`). `remix/ui` escapes all
  interpolated text; there is no raw-HTML escape hatch in the page components.
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
