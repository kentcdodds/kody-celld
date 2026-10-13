# Package apps

A package can serve a small browser app: HTML, forms, JSON endpoints. The
package declares `kody.app` in its `package.json`, and Kody serves it on a
**separate app origin**, never on `KODY_PUBLIC_URL`. This is the self-hosted
form of hosted Kody's package apps (issue #42). Today apps are
**server-rendered only**: there is no client bundle build.

## What a package app is

```json
{
  "name": "hello-app",
  "version": "1.0.0",
  "exports": { ".": "./index.js" },
  "kody": { "app": { "entry": "./app/server.js" } }
}
```

`kody.app.entry` is a module in the package whose default export is a fetch
handler. Any of these shapes works; anything else answers 500 and is reported
as an app failure:

- `export default function (request) { … }`
- `export default { fetch(request) { … } }`
- `export function fetch(request) { … }`

The handler returns a `Response` (streamed to the browser untouched, apart from
the header hygiene below). It sees the app-origin URL with the mount stripped:
a browser request for `…/packages/hello-app/notes?x=1` arrives as `/notes?x=1`.
Method, headers and body (form posts included) arrive intact. Redirects the
app returns reach the browser unchanged.

App code runs like package code: `kody:runtime` works (`kody.*` capabilities,
`packageStorage()`, secrets through the gateway with approved hosts), and
imports, npm specifiers and `kody.dependencies` behave as in
[packages.md](./packages.md). The app also gets `packageContext` from
`kody:runtime`:

| Field           | Value                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packageName`   | the package's name                                                                                                 |
| `version`       | the saved version                                                                                                  |
| `runId`         | an ephemeral `app_<id>` for this request                                                                           |
| `hostedUrl`     | the app's absolute mount URL, no trailing `/`                                                                      |
| `appBasePath`   | the mount path (`/u/<userId>/packages/<name>` in path mode, `/packages/<name>` in subdomain mode), no trailing `/` |
| `assetBasePath` | `appBasePath + '/_assets'`                                                                                         |

`clientModuleUrl` is absent (not `null`). Build links with `appBasePath` so the
app works in both URL modes.

Manifest rules (checked on `packageSave`): `entry` must be an uploaded module;
`assets`, if given, is a directory with at least one file (root files named
`__version.json` or `client.<16 hex>.js` are refused); `kody.app.runtime` is
refused. A saved package that is re-saved, or whose `kody.dependencies` are
re-saved, serves the new code on its next request.

## Assets

`kody.app.assets` names a directory of the package (for example `./public`).
Its files are served by the host, not by your handler, at
`<appBasePath>/_assets/<path inside the directory>` (that is `assetBasePath`).
The same owner-only app session applies as for any other app request.

- **Methods.** `GET` and `HEAD`; anything else is 405.
- **Content types.** By extension: `css`, `js`/`mjs`, `json`/`map`,
  `webmanifest`, `svg`, `html`, `txt`, `xml`. Anything else is
  `text/plain; charset=utf-8`. Every response carries
  `X-Content-Type-Options: nosniff`.
- **Caching.** `Cache-Control: private, max-age=300` and a strong `ETag` (the
  SHA-256 of the file). A matching `If-None-Match` (a list, a weak `W/`
  form, or `*`) gets `304`. Browsers cache assets for up to 5 minutes, so a
  re-saved stylesheet can take that long to show without a hard reload.
- **404.** Missing files, `..` or empty segments (also percent-encoded), a bare
  `/_assets/`, and `__version.json` (this host builds no `kody.app.client`
  bundle) all answer 404. An app with no `assets` answers 404 for every
  `/_assets/*` request.
- **Reserved names.** Root files named `__version.json` or `client.<16 hex>.js`
  are refused at save time; nest or rename them.
- **Text only.** Packages hold UTF-8 text, so binary assets (images, fonts)
  cannot be packaged yet. Inline SVG or data URIs work; see
  [known-gaps.md](./known-gaps.md).

## Turning it on

Set `KODY_APP_BASE_URL` on the node. Unset means package apps are off and
nothing is ever served from the public origin.

| Value                        | Mode      | App URL                                                |
| ---------------------------- | --------- | ------------------------------------------------------ |
| `https://apps.example.com`   | path      | `https://apps.example.com/u/<userId>/packages/<name>/` |
| `https://*.apps.example.com` | subdomain | `https://user-<hex>.apps.example.com/packages/<name>/` |

Scoped names use two path segments (`/packages/@scope/name/`). The user slot is
the opaque user id (`user_<hex>`; the subdomain label is `user-<hex>`). The
value must be an origin: `http:` or `https:`, optional port, no path, query or
fragment. When `KODY_PUBLIC_URL` is `https:`, the app origin must be `https:`
too, so the app session cookie is never sent in clear text.

What you need in front of it:

- **Path mode:** one extra DNS name pointing at the node, with a certificate
  for it.
- **Subdomain mode:** wildcard DNS (`*.apps.example.com`) and a wildcard
  certificate. With Caddy that means a DNS-01 challenge.
- Behind a TLS-terminating proxy, preserve the `Host` header. Kody builds
  origins from the configured scheme and the request's host, so the proxy may
  speak plain HTTP to the node.

**Misconfiguration keeps apps off.** If the app host equals the
`KODY_PUBLIC_URL` host (any port: cookies ignore ports), the public host sits
under the wildcard, or the value is not a valid origin, then no host is routed
to apps, `/health` reports `apps: { error: "…" }` (a healthy node reports the
base URL string, or `null` when unset), and `/apps/open` answers 500
`app_origin_misconfigured`. There is no fallback to the public origin.

**Use a different registrable domain for apps.** `KODY_APP_BASE_URL` SHOULD
sit on a different registrable domain from `KODY_PUBLIC_URL` (for example
`kody.example.com` for Kody and `example-apps.net` for apps). If they share
one, untrusted app JavaScript can set a cookie such as
`kody_session=x; Domain=example.com; Path=/account` that the Kody origin then
receives. On https installs Kody's own cookies are `__Host-kody_session` and
`__Host-kody_console` (Secure, Path=/, no Domain), so sibling hosts cannot
plant or shadow those names; a separate domain is still recommended. The node
logs a startup warning when the two origins share a registrable domain.
Server-side `Set-Cookie` filtering cannot stop script running in the browser.
See [decision 0020](./contributing/decisions/0020-host-prefixed-kody-cookies.md).

## Opening an app

Apps are opened from Kody; there is no separate login.

- The account page for a package that declares `kody.app` shows an **Open app**
  link (when apps are enabled).
- Agents call `packageAppUrl({ name })`, which returns `{ url, openUrl }`: `url`
  is the bare app address, `openUrl` the `/apps/open` link to give the person.
  Errors: `apps_disabled` (404), `package_not_found` (404), `not_an_app` (400),
  `app_origin_misconfigured` (500), `app_origin_unmappable` (500, an account id that
  cannot become a subdomain label).
- `GET /apps/open?package=<name>` on the main origin needs a Kody web session
  (otherwise it redirects to sign-in and back).

The flow, which the browser follows by itself:

1. `/apps/open?package=<name>` without a valid `state` redirects to the bare
   app URL, which starts the state round trip. The **Open app** link and
   `packageAppUrl().openUrl` both go this way.
2. The app origin has no session, so it sets a short-lived `kody_app_state`
   cookie (5 minutes) and redirects to `/apps/open?package=<name>&state=<state>`.
3. `/apps/open` mints a **handoff token** bound to the user, the package, the
   Kody web session and that `state`, and redirects to the app URL with
   `?__kody_handoff=<token>`.
4. The app origin checks the signature, expiry, user and package, and that the
   `kody_app_state` cookie equals the token's state, then burns the token and
   sets `kody_app_session`. It redirects to the same URL without the handoff
   parameter (other query parameters survive).

The handoff is valid for 60 seconds and works once; a replay, an expired token
or a token carried to a different browser is refused. The state round trip is
what stops someone else's link from signing your browser in to their app.

`kody_app_session` lasts 12 hours, is `HttpOnly; SameSite=Lax`, host-only, and
`Secure` when the app base URL is https. It is scoped to `/u/<userId>/` in path
mode and `/` in subdomain mode, and covers all of that user's apps. **Every
request** re-checks the parent Kody session, so signing out or revoking it ends
app access immediately. Access is **owner-only**: the session's user must be
the user in the URL. A GET or HEAD without a valid session, or with another
user's session, is not refused: it starts the state round trip above, which
ends at Kody (and sign-in if needed). The 403 "Open this app from Kody" page,
linking to `/apps/open`, is shown only for non-GET/HEAD requests, a failed
handoff (this stops redirect loops), or an account that no longer exists. Rotating `KODY_MASTER_KEY` invalidates every
handoff and app session.

On the app host, `/` redirects to `KODY_PUBLIC_URL`. Anything else outside an
app mount is 404: `/mcp`, `/api`, `/admin`, `/oauth`,
sign-in, console and the rest are never reachable there.

## Security model

- **Separate origin.** Installed code runs on a different origin from your Kody
  account, so a script in an app cannot read Kody pages or call Kody's browser
  routes as you. This is a one-way door: there is no same-origin mode (see
  [decision 0019](./contributing/decisions/0019-package-app-origin.md)).
- **Credentials never reach app code.** The host removes `kody_session` /
  `__Host-kody_session`, `kody_console` / `__Host-kody_console`,
  `kody_app_session` and `kody_app_state` from the `Cookie` header, drops
  `__kody_handoff` from the URL, and deletes every incoming `x-kody-*` header.
  On the way out it drops `x-kody-*` response headers and any `Set-Cookie` for
  those cookies, and adds `X-Content-Type-Options: nosniff`. Other cookies and
  headers pass through; the app owns its own CSP.
- **Cross-origin writes refused.** A non-GET/HEAD request with an `Origin` that
  is not the app's own origin, or a `Sec-Fetch-Site` other than `same-origin`,
  is refused with 403. Sibling apps in subdomain mode are same-site, and CORS
  would only block their reads.
- **Same-site cookie tossing.** When the app host and the Kody host share a
  registrable domain, app JavaScript can plant cookies that the Kody origin
  receives. https installs use `__Host-kody_session` / `__Host-kody_console` so
  those names cannot be planted with a `Domain` attribute; still use a
  different registrable domain for `KODY_APP_BASE_URL`.
- **Path-mode caveat.** In path mode every user's apps share one origin, and the
  cookie path does not stop one user's script from reading another's pages. Use
  subdomain mode on any install with more than one user.
- **What app code can do** is what package code can do: use your secrets on
  approved hosts, call `kody.*` capabilities as you, and read and write that
  package's storage. Installing an app is trusting its code as much as
  installing a package.

## Limits

- **Server-rendered only.** `kody.app.client` is recorded on the manifest but
  not built; `packageSave` returns a warning and the app is served
  server-rendered.
- **Text-only assets.** `/_assets/*` serves text files only (packages are
  UTF-8 only); see [Assets](#assets).
- No realtime or WebSockets, no `packageAppFetch`, no public or shared apps (see
  [known-gaps.md](./known-gaps.md)).
- **Failures-only run records.** A request that succeeds writes nothing. A graph
  build error, a handler that throws or returns 5xx, or a timeout writes a
  `kind: app` run with its logs; find it in run history.
- **Gateway events.** Outbound fetches made while serving an app request are
  not recorded as gateway events on a run; only failures write `app` runs.
- **`packageContext.runId`** can be stale under concurrent requests in one
  isolate. Use it for log correlation only.
- **Re-auth lands on the app root.** After signing in again the browser returns
  to the app root, not the deep link it asked for (follow-up).
- **Timeout** is `KODY_EXECUTE_TIMEOUT_MS` (default 60 s); exceeding it answers 504.

## Example and smoke test

`examples/packages/hello-app` is the smallest app: one page that echoes what the
host passed in (path, cookies, `x-kody-*` headers, `packageContext`), counts
visits in `packageStorage`, and saves a note from a form. Its `package.json` is
the manifest above; the handler lives in `app/server.js`. Save it with
`packageSave`, then call `packageAppUrl({ name: "hello-app" })` and open
`openUrl`.

To run the smoke scenario locally, add this to `.dev.vars` and start the node:

```
KODY_APP_BASE_URL=http://apps.localhost:8787
```

then run `node smoke/run.mjs --only apps`. It signs in, follows the open flow,
checks the echo and storage, a handoff without a state cookie, with a wrong one
and with the matching one, that Kody credentials are stripped in both
directions, that first-party routes such as `/mcp` and `/api` are 404 on the
app host, that the app path is 404 on the Kody host, a POST body and storage,
and that signing out ends access. Handoff replay and foreign-session refusal
are covered by unit tests (`src/apps/tokens.test.ts`, `src/apps/origin.test.ts`),
not by the smoke. Without `KODY_APP_BASE_URL` the scenario skips itself.
