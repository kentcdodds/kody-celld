# MCP OAuth (authorization server)

kody-celld is its own OAuth 2.1 authorization server, so MCP clients that
support the [MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization)
(Claude Code, Claude Desktop, Cursor, VS Code, ChatGPT connectors, …) connect
with **no token pasting**: they discover the server, register themselves,
send the user to a sign-in + consent page, and receive tokens that they refresh
on their own. Static API tokens (`kody_…`) keep working unchanged for clients
that only take a URL + header.

There is no third-party identity provider in the loop and nothing to
configure: the server is on as soon as `KODY_PUBLIC_URL` is set. Reference:
production Kody's `worker/oauth/*` (same protocol surface, different storage).

## What a client sees

```
GET  /mcp                                       -> 401
     WWW-Authenticate: Bearer realm="kody-celld", resource_metadata="<url>/.well-known/oauth-protected-resource/mcp"
GET  /.well-known/oauth-protected-resource[/mcp] (RFC 9728)  -> { resource: "<url>/mcp", authorization_servers: ["<url>"] }
GET  /.well-known/oauth-authorization-server[/mcp] (RFC 8414) -> endpoints, scopes, PKCE methods, auth methods
POST /oauth/register (RFC 7591 dynamic client registration)
GET  /oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&resource
POST /oauth/token   (grant_type=authorization_code | refresh_token)
POST /oauth/revoke  (RFC 7009)
GET  /oauth/userinfo
```

- **PKCE is mandatory** (`S256` only). `plain` and missing challenges are
  refused before any redirect happens.
- **`response_type=code` only.** No implicit or hybrid flows.
- **Scopes** are `openid profile email`; unknown scopes are dropped, not
  rejected. One grant means the full assistant for that user — the MCP surface
  is `search` + `execute`, there is no per-capability scope menu (same as
  production Kody).
- **Resource indicator** (RFC 8707): `resource` must be the issuer or
  `<issuer>/mcp`; anything else is `invalid_target`.
- **Redirect URIs** are matched exactly against the registered list. `https:`
  and private-use schemes (`cursor://…`) are accepted; `http:` only for
  loopback hosts (`127.0.0.1`, `[::1]`, `localhost`), where the **port may
  differ** (RFC 8252 §7.3). Fragments, credentials and `javascript:`-style
  schemes are refused at registration.
- **Clients** are `token_endpoint_auth_method: none` (public, the MCP default)
  or `client_secret_basic` / `client_secret_post` (confidential; the secret is
  returned once at registration and stored hashed). Unused registrations are
  garbage-collected after 30 days.
- **Authorization codes** live 10 minutes and are consumed exactly once; the
  exchange must present the same `client_id`, `redirect_uri` (byte-equal to the
  one in the authorize request), `resource`, and a matching PKCE verifier.
- **Access tokens** (`mcpat_…`) live 1 hour. **Refresh tokens** (`mcprt_…`)
  live 30 days and **rotate on every use**. A client that lost the response
  may replay the token it just used for 60 seconds and gets the same pair
  back; anything older is treated as theft and the whole token family (the
  grant's live tokens) is revoked.
- **Revocation**: `POST /oauth/revoke` with an access token kills that token;
  with a refresh token it kills the family. Users can revoke a client at any
  time from `/account/clients` (or `kody.mcpClientRevoke()`), and the operator
  can sign a user out of everything with `POST /admin/users/:id/signout`.
- **Bearer tokens** are accepted wherever `kody_…` API tokens are: `/mcp` and
  `/api/*`. A revoked/expired token returns `401` with
  `error="invalid_token"` in the challenge so clients re-authenticate.
- `OPTIONS /mcp` and the OAuth endpoints answer CORS preflights, so
  browser-based MCP hosts work too.

## The consent page

`GET /oauth/authorize` validates the request _before_ rendering anything. If
the client or redirect URI is unknown the user sees an error page and is
**not** redirected (open-redirect guard); every later error is delivered to the
registered redirect URI with `state` echoed.

If the browser has no Kody session, the user is sent to `/signin?next=…` and
brought back afterwards. The consent page shows the client name (and URI when
it was registered), the account it will act as, and _Allow_ / _Deny_. The
hidden form state is signed with a session-bound HMAC, so a page that was
tampered with (different client, redirect, scope, PKCE challenge, …) is
rejected with `400` instead of authorizing something the user never saw. The
form also carries the usual CSRF token and requires a same-origin `POST`.

## Storage and what is never stored

Everything lives in the `RegistryCell` (the single-instance Durable Object that
already owns users and API tokens), tables `oauth_clients`, `oauth_codes`,
`oauth_grants`, `oauth_tokens`:

- Client secrets, authorization codes, access tokens and refresh tokens are
  stored as **SHA-256 hashes**; the raw value exists only in the response that
  issued it.
- The 60-second refresh replay snapshot is **encrypted with the master key**
  (`KODY_MASTER_KEY`, rotation-aware) — an operator with the SQLite file still
  cannot mint a bearer token from it.
- `oauth_grants` (what the account UI and `kody.mcpClientList()` show) carry
  only client id/name, scope, and timestamps.
- Audit entries record `mcp_client.register`, `mcp_client.authorize`,
  `mcp_client.deny`, `mcp_client.revoke` with client ids and names — never
  token material.

## Using it

**Claude Code**

```sh
claude mcp add --transport http kody https://kody.your-domain.example/mcp
# first use opens the browser: sign in, click Allow
```

**Cursor / VS Code / Claude Desktop** — add an HTTP MCP server with the URL
`https://kody.your-domain.example/mcp` and nothing else.

**By hand** (what the smoke test does):

```sh
BASE=https://kody.your-domain.example
curl -s $BASE/.well-known/oauth-authorization-server | jq .
curl -s -X POST $BASE/oauth/register -H 'content-type: application/json' \
  -d '{"client_name":"my host","redirect_uris":["http://127.0.0.1:8123/cb"]}'
# open $BASE/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=$BASE/mcp
curl -s -X POST $BASE/oauth/token -d grant_type=authorization_code -d code=… -d client_id=… \
  -d redirect_uri=http://127.0.0.1:8123/cb -d code_verifier=… -d resource=$BASE/mcp
```

## Operating notes

- `KODY_PUBLIC_URL` **is** the issuer. Discovery metadata, redirect handling
  and cookie `Secure` flags all derive from it; change it and every registered
  client must re-discover (they do so automatically on the next 401).
- Behind a reverse proxy, forward `Host` unchanged (or set the public URL to
  what the proxy presents). Loopback dev works over plain `http`; anything else
  should be `https` — cookies are `Secure` only for an `https` public URL.
- The dev placeholders in `wrangler.jsonc` (`dev-admin-token`, …) refuse
  non-loopback requests entirely, so an accidentally exposed dev server does
  not become an authorization server for the internet.
- Smoke: `node smoke/run.mjs oauth-server` (part of `npm run smoke`) walks
  discovery, DCR for public/confidential/native clients, every rejection path,
  consent deny/allow with tamper and CSRF checks, code exchange, MCP
  `initialize`/`search`/`execute` with the access token, `/api` bearer auth,
  refresh rotation + replay grace + stale-replay family revocation, RFC 7009
  revocation, account-side revocation, and that sandbox code cannot mint
  credentials.
