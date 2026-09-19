# OAuth integrations

An **integration** is a named OAuth connection to a third-party API (GitHub,
Google, Slack, your own service). You bring the OAuth app (client id, optional
client secret); Kody runs the browser consent flow, stores the tokens
encrypted, refreshes them, and injects the access token into outbound requests
through the same gateway that handles `{{secret:…}}` — sandbox code only ever
sees the placeholder `{{integration-token:<name>}}`.

Everything below is a **capability** found through MCP `search` and called
through `execute`; there are no new MCP tools.

## Flow

```
integrationSave  →  integrationConnect  →  user opens the link  →  provider consent
   (config + client secret,           (one-time ticket URL,       →  /connect/oauth/callback
    encrypted)                         15 min)                        (code + PKCE exchange)
                                                                   →  status: connected
fetch('https://api…', { headers: { authorization: 'Bearer {{integration-token:github}}' } })
                                                                   →  gateway injects, refreshes on expiry / 401
```

### 1. Describe the OAuth app

```ts
await kody.integrationSave({
  name: 'github',
  provider: 'GitHub',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  clientId: '<your OAuth app client id>',
  clientSecret: '<your OAuth app client secret>', // omit for public PKCE clients; null clears
  scopes: ['repo', 'read:user'],
  allowedHosts: ['api.github.com', 'uploads.github.com'], // required
  authorizeParams: { prompt: 'consent' }, // optional static extras (access_type=offline …)
  tokenAuthStyle: 'body', // or 'basic' for providers that want HTTP Basic at the token endpoint
})
```

- `allowedHosts` is **required** and is the only set of hosts the token is
  ever sent to. It is independent of admin secret-host approvals: an
  integration token never needs an admin-approved host, and an approved host
  does not widen an integration's list.
- `flow: 'client_credentials'` (machine-to-machine) needs no `authorizeUrl`
  and no browser step; the first placeholder use fetches a token.
- The client secret is AES-256-GCM encrypted under the per-user key like any
  secret (`docs/secrets.md`); `integrationGet`/`integrationList` report
  `hasClientSecret`, never the value.

### 2. Connect

```ts
const { url, expiresAt } = await kody.integrationConnect({ name: 'github' })
// Show `url` to the human. It is single-use and expires in 15 minutes.
```

`GET /connect/oauth/:userId/:connectId?ticket=…` renders a small page and
starts the authorization request with:

- **PKCE (S256)**: a fresh verifier is generated per attempt and stored
  encrypted until the callback; the challenge goes to the provider.
- **state** = `<userId>.<connectId>.<nonce>`; the nonce is stored hashed, the
  ticket is stored hashed and burned on first use — replaying the link is a
  404, a forged or reused callback is rejected.
- The callback exchanges `code` for tokens server-side (`authorization_code`
  grant + `code_verifier` + client secret in the body or as Basic auth),
  encrypts access and refresh tokens, and marks the integration `connected`.

If the provider returns an error on the callback (user denied consent) the
page says so and — if the integration already had a live token — that
connection is **kept**. A failed _first_ connect leaves the integration in
`auth_failed`.

### 3. Use the token

```ts
// Ad hoc / package code — plain fetch with a placeholder:
const res = await fetch('https://api.github.com/user', {
  headers: { authorization: 'Bearer {{integration-token:github}}' },
})

// Or the helper from kody:runtime (returns a fetch that adds the header):
import { createAuthenticatedFetch, oauthClientCredentials } from 'kody:runtime'
const gh = createAuthenticatedFetch('github') // default: authorization: Bearer {{integration-token:github}}
const res2 = await gh('https://api.github.com/user')
const custom = createAuthenticatedFetch('legacy', { headerName: 'x-api-token', scheme: '' })
```

`oauthClientCredentials` is an alias of `createAuthenticatedFetch` for
`client_credentials` integrations. Neither helper ever holds a token: both
return placeholder headers that the gateway replaces at the network boundary.

The placeholder is recognised in URL, headers and body, exactly like
`{{secret:…}}`.

## Gateway decision for `{{integration-token:<name>}}`

```
integration unknown                           → 404 integration_not_found
usage is package-limited and caller not in it → 403 integration_locked
host not in allowedHosts                      → 403 integration_host_not_allowed
status pending / auth_failed (no live token)  → 401 integration_not_connected (message carries the last error)
expired (60 s skew) but no refresh token      → 401 integration_reconnect_required
token expired and refreshable                 → refresh, then inject
upstream answers 401                          → refresh once, replay the request once
otherwise                                     → inject, forward, record 'injected'
```

- Refreshes are **host-side** in the user cell, deduplicated per integration
  (concurrent requests share one refresh), and honour refresh-token rotation.
  A provider `invalid_grant` / `invalid_client` on refresh clears the tokens
  and moves the integration to `auth_failed`.
- Run history and `gateway[]` record `integration-token:<name>` as the secret
  name plus `reason: integration_refreshed` when a refresh happened; no token
  material is stored anywhere but the encrypted columns.
- The gateway buffers the request body before injecting, so the 401 replay
  re-sends it byte-for-byte; the same request is never sent more than twice.

## Restricting who may use a token

```ts
await kody.integrationSetUsage({ name: 'github', usage: { mode: 'packages', packages: ['@me/gh-sync'] } })
await kody.integrationSetUsage({ name: 'github', usage: 'any' })
```

`packages` mode refuses ad hoc `execute` code (`integration_locked`) and any
package not listed, before any token is decrypted. `usage` can also be set in
`integrationSave`.

## Events

Packages can subscribe to auth changes (`kody.subscriptions` in
`package.json`, see [packages.md](./packages.md)):

| Topic                        | When                                                     | Payload (metadata only)                                 |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `integration.auth.succeeded` | connect completed, or a host-side refresh succeeded      | `integration` (record without tokens), `source`         |
| `integration.auth.failed`    | connect failed, refresh rejected, or 401 not recoverable | `integration`, `source`, `reason` (provider error code) |

## Managing

| Capability                | Effect                                                                |
| ------------------------- | --------------------------------------------------------------------- |
| `integrationList` / `Get` | config + status (`pending`, `connected`, `auth_failed`), never tokens |
| `integrationTokenRefresh` | force a refresh now (returns status/expiry, not the token)            |
| `integrationDisconnect`   | drop tokens, keep the app config → `pending`                          |
| `integrationDelete`       | drop everything including the encrypted client secret                 |

All management capabilities are refused from package code
(`forbidden_from_package`); only the MCP session / ad hoc `execute` may change
integrations, so a package cannot re-point a token at another host.
`POST /admin/secrets/rekey` re-seals integration secrets and tokens together
with ordinary secrets during master-key rotation.

## Public URL

The callback is `${KODY_PUBLIC_URL}/connect/oauth/callback`; register exactly
that redirect URI in your OAuth app. `KODY_PUBLIC_URL` must therefore be the
URL your browser reaches (the Caddy/HTTPS front in a fleet, the LAN address of
your NAS for a single node).

## Audit

`integration.save`, `integration.connect_start`, `integration.connect`,
`integration.connect_failed`, `integration.usage`, `integration.disconnect`,
`integration.delete` are recorded in the admin audit log with the integration
name and provider (never tokens or client secrets).

## Smoke

`smoke/integrations.mjs` (part of `npm run smoke`) runs a mock OAuth provider

- API on loopback with random per-run credentials and proves: PKCE + state +
  one-time ticket, forged/replayed callback rejection, injection via placeholder
  and `createAuthenticatedFetch`, `allowedHosts`, package-limited usage, refresh
  on expiry, 401 → refresh → replay, `integration.auth.*` subscriptions,
  `auth_failed` on `invalid_grant`, reconnect, denied re-consent keeping the live
  token, `client_credentials`, and that no token appears in run history, audit
  or responses. It runs against `@kody-smoke/oauth-client`
  (`examples/packages/oauth-client`).
