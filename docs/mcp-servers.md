# External MCP servers (`kody.mcp`)

Kody can be an MCP **client**: you add a remote MCP server (Home Assistant, a
LAN tool box, any hosted MCP endpoint) once, and `execute` code and packages
call its tools as `kody.mcp['name'].tool(input)`. The call runs host-side in
your user cell, so the sandbox never sees the server's bearer token.

Only the Streamable HTTP transport is supported. A server authenticates with
an optional static bearer token or with OAuth (see [OAuth servers](#oauth-servers)).
Servers are per user and are listed on `/account/mcp-servers`.

## Add a server

```js
import { kody } from 'kody:runtime'
export default async () =>
  kody.mcpServerAdd({
    name: 'home',
    url: 'https://ha.example.com/api/mcp',
    bearerToken: 'eyJhbGciOi…',
  })
// -> { name: 'home', status: 'ready', toolCount: 12, … }
```

- `name` is 1–64 lowercase letters, digits and `-`, starting and ending with a
  letter or digit.
- `bearerToken` is optional. A bare token is sent as `Bearer <token>`; a value
  that already has a scheme (`Token abc`) is sent as is. It is sealed with your
  keyring, and it is never returned by `mcpServerList`, run history or the
  account page, nor written to logs.
- Kody connects and lists the server's tools straight away. When discovery
  fails, the server is **still saved** with `status: 'error'` and a
  `lastError`; fix the server (or the allowlist) and call
  `mcpServerRefresh({ name })`.
- An existing name is refused with `mcp_server_exists`; pass `replace: true`
  to overwrite it. A replace keeps the server's stored lock and enabled state
  unless you pass `usage` / `enabled`, and keeps the bearer token only when
  the URL origin is unchanged (or you pass `bearerToken`). A `usage` looser
  than the stored lock (back to `any`, or dropping a granted package) is
  refused with `mcp_server_locked`.

`mcpServerList()` lists your servers (never the token). `mcpServerRefresh`
re-lists the tools, `mcpServerSetEnabled({ name, enabled })` turns a server
off and on, and `mcpServerRemove({ name })` deletes it. The management
capabilities are refused from package code (`forbidden_from_package`);
`mcpServerList` works everywhere.

## OAuth servers

A server that answers `401` without a bearer token and advertises an OAuth
authorization server (RFC 9728 protected resource metadata) is added as an
OAuth server. A bearer token and OAuth are exclusive: a server added with
`bearerToken` never starts OAuth.

### Flow

1. `mcpServerAdd({ name, url })` saves the server with
   `status: 'authenticating'` and returns an `authUrl`
   (`{origin}/account/mcp-servers/<name>/authorize`) plus a `nextStep` that
   says what to do. `authUrl` is set only while `status` is `authenticating`
   (matching hosted). Calls fail with `mcp_server_unauthorized` (with the
   authorize link and the reason) until the user authorizes; so do calls to an
   OAuth server in `status: 'error'` that has no grant yet.
2. The user opens `authUrl` while signed in. The consent page names the server,
   where Continue opens (the authorization endpoint host) and how Kody will
   identify itself; **Continue** sends the browser to the provider.
3. The provider redirects back to the callback
   (`{origin}/account/mcp-servers/oauth/callback`). Kody exchanges the code
   (PKCE S256), seals the tokens with your keyring, lists the tools, and lands
   on `/account/mcp-servers` with a success or error notice. A pending
   authorization expires after 15 minutes and works once: a replayed
   callback changes nothing, and an unknown `state` is refused
   (`mcp_oauth_state_invalid`).
4. The server is `ready`; `mcpServerList` shows `authUrl: null`,
   `hasRefreshToken` and `oauthClientMode` (`'preregistered'`, `'metadata'`,
   `'dynamic'` or `null`; the same values are under `oauth`). Tokens, client
   secrets and PKCE verifiers never appear in capability results, errors, run
   history, logs or HTML.

If the server is removed or replaced (another origin, or a bearer token) while
the provider round trip is running, the callback saves nothing and reports an
error; start again from the new server's `authUrl`.

`{origin}` is always the origin of `KODY_PUBLIC_URL`, never the request host.

### How Kody identifies itself

Kody picks the first client mode that applies, per server:

1. **Pre-registered client:** a client id (and optional secret) you entered on
   `/account/mcp-servers` (see below).
2. **Client metadata document:** when `KODY_PUBLIC_URL` is `https:` and the
   authorization server advertises `client_id_metadata_document_supported`,
   the client id is `{origin}/oauth/client-metadata.json`, which Kody serves
   publicly. On an `http:` origin the document is not served (`404`).
3. **Dynamic client registration** (RFC 7591), when the authorization server
   has a `registration_endpoint`. The registered client is stored and reused.
4. Otherwise the server stays in `status: 'error'` with a message saying it
   needs a pre-registered client; starting an authorization fails with
   `mcp_oauth_client_required`.

### What to allow at the provider

`mcpServerAdd`, `mcpServerList` and `mcpServerReconnect` return the values a
provider may ask you to allow:

| Field                    | Value                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `oauthClientOrigin`      | `{origin}`                                                  |
| `oauthCallbackUrl`       | `{origin}/account/mcp-servers/oauth/callback`               |
| `oauthClientMetadataUrl` | `{origin}/oauth/client-metadata.json`, or `null` on `http:` |

### LAN authorization servers

Every OAuth request (discovery, registration, token exchange, refresh) goes
through the same host policy as MCP calls. If the authorization server is on a
private or `http:` host, list **its** host in `KODY_MCP_ALLOW_PRIVATE_HOSTS`
too, not only the MCP server's host. Requests that carry codes, verifiers or
secrets follow only same-origin `307`/`308` redirects.

Home Assistant identifies clients by URL: its `client_id` is Kody's metadata
document URL. That needs an `https:` `KODY_PUBLIC_URL` that Home Assistant
can reach, so it can fetch `{origin}/oauth/client-metadata.json`.

### Pre-registered client (GitHub)

For providers without registration or metadata documents, such as GitHub:

1. Create an OAuth app at the provider with the callback URL set to
   `oauthCallbackUrl`.
2. On `/account/mcp-servers`, open **OAuth client** on the server's row, enter
   the client id and (optional) secret, and save. The secret is sealed with
   your keyring and never shown again.
3. Open the server's `authUrl` (or **Authorize** on the row) to authorize.

The client can only be set or removed on the account page, not from code.

### Refresh

Kody refreshes the access token automatically when it is about to expire, and
once (followed by one retry) when a call gets a `401`. Refreshes are
serialized per server, so concurrent calls never race a rotating refresh
token. When the provider rejects the refresh token, the server goes back to
`authenticating` with an `authUrl`; the user reauthorizes. `mcpServerReconnect({
name })` forces a refresh when the grant has a refresh token (a grant without
one, such as a GitHub OAuth app's, is kept as is), re-lists the tools, and
returns the current `status` and `authUrl`. Like the other management
capabilities, it is refused from package code.

### Troubleshooting

- **The provider rejects the redirect URI or the origin** (`invalid_request`,
  "redirect_uri mismatch", "origin not allowed"): allow the three values from
  [What to allow at the provider](#what-to-allow-at-the-provider) there, then
  authorize again.
- **"needs a pre-registered OAuth client"** (`status: 'error'`, or
  `mcp_oauth_client_required` when starting): the authorization server offers
  neither registration nor client metadata documents. Create an OAuth app at
  the provider and enter it under **OAuth client** (see
  [Pre-registered client](#pre-registered-client-github)).
- **A LAN authorization server is refused** (`mcp_host_not_allowed` on the
  consent page, or a `lastError` naming the authorization server's host): add the
  authorization server's host to `KODY_MCP_ALLOW_PRIVATE_HOSTS`, not only the
  MCP server's host (see [LAN authorization servers](#lan-authorization-servers)).
- **The refresh token was rejected** (`status: 'authenticating'`, "The refresh
  token was rejected; authorize again"): open `authUrl` and authorize again.
  After a transient refresh failure (`status: 'error'`, tokens kept),
  `mcpServerReconnect({ name })` retries the refresh and re-lists the tools.

## Call tools

```js
import { kody } from 'kody:runtime'
export default async () => {
  const r = await kody.mcp['home'].HassTurnOn({ name: 'kitchen light' })
  if (r.isError) return `the server said no: ${r.content[0]?.text}`
  return r.structuredContent ?? r.content
}
```

A call returns `{ content, structuredContent?, isError }`. A tool error from the
remote server (`isError: true`) is **returned**, not thrown, so your code can
read the server's message. Kody only throws for its own refusals and transport
failures (see [Errors](#errors)).

Non-text blocks (images, audio, resources) pass through unchanged. To forward
them to your MCP client as rich content, return them in an `__mcpContent`
envelope:

```js
const shot = await kody.mcp['home'].camera_snapshot({ entity: 'camera.door' })
return { __mcpContent: shot.content }
```

Remote tools named `then` or `toJSON` cannot be called through `kody.mcp`
(the sandbox proxy reserves those names); every other tool name works.

Every call is recorded in the run's history as a gateway event with method
`MCP`, the server URL (origin and path only), and `mcp: { server, tool, ms }`.

## Find tools

```js
search({ domain: 'mcp:home' })
```

lists the server (`mcp-server:home`) and each of its tools (`mcp:home:<tool>`)
with their input schemas. A plain `search({ query: 'turn on light' })` also
matches tool names and descriptions. Disabled servers, and servers locked to
packages, are not listed in the MCP session's search.

## Lock to packages

```js
await kody.mcpServerLock({ name: 'home', packageName: '@me/lights' })
```

A locked server can only be called from runs whose entry package is on its
grant list (`packageRun`, jobs, webhooks of that package). Ad hoc `execute` is
refused with `mcp_server_locked`, **including** ad hoc code that imports a
granted package's export: the identity is the run's entry package, the same rule
as for [integrations](./integrations.md).

`mcpServerLock` only widens the grant list. Removing a grant or going back to
"any code may call it" is done on `/account/mcp-servers`, so an agent cannot
unlock a server it was locked out of: `mcpServerAdd({ replace: true })` keeps
the stored lock and refuses a looser `usage`. Ad hoc code can still
`mcpServerRemove` the server and add it again unlocked, but that discards the
server's stored bearer token, so the new entry only works with a token the
agent already has.

## Private and LAN servers

Public `https:` URLs work out of the box. Loopback, private (RFC 1918, CGNAT,
link-local, ULA), `.local`/`.internal`/single-label hosts, and plain `http:`
URLs are refused with `mcp_host_not_allowed` unless the operator lists the host
in `KODY_MCP_ALLOW_PRIVATE_HOSTS`:

```sh
KODY_MCP_ALLOW_PRIVATE_HOSTS=homeassistant.lan,*.home.arpa,172.30.0.0/16,10.0.0.5
```

- Entries are exact hosts, `*.suffix` wildcards, IPv4/IPv6 literals, or CIDR
  ranges (`/0`–`/32` for IPv4, `/0`–`/128` for IPv6). IPv4-mapped IPv6
  literals (`[::ffff:172.30.1.5]`) match the IPv4 range; write mapped ranges
  in IPv4 form (`10.0.0.0/8`, not `::ffff:10.0.0.0/104`, which is refused).
  Names may contain `_` (compose service names such as `my_service`).
- Private IP literals are recognised in any spelling, including IPv6 forms
  that embed a private IPv4 address (`[::ffff:0:a00:1]`, NAT64
  `[64:ff9b::a00:1]`, 6to4) and non-canonical forms (`[0:0:0:0:0:0:0:1]`).
- Plain `http:` is allowed **only** for listed hosts.
- **Resolved addresses are checked.** Before every hop (the first request and
  each redirect), Kody looks up the host's A and AAAA records through
  DNS-over-HTTPS (`KODY_DNS_RESOLVER_URL`, default
  `https://cloudflare-dns.com/dns-query`) and refuses the hop if any answer is a
  private address that no IP/CIDR entry allows, or if the lookup fails or
  returns nothing. IP-literal URLs and names that match a name or `*.suffix`
  entry skip the lookup. A public resolver cannot see your LAN, so for a LAN
  name either list the name itself (or a `*.suffix`), or point
  `KODY_DNS_RESOLVER_URL` at a resolver you run so `.home` names resolve and
  the CIDR entries apply to them. That resolver must speak the DoH **JSON
  API** (`GET ?name=<host>&type=A` with `accept: application/dns-json`, as
  Cloudflare and Google do); RFC 8484 wireformat-only DoH endpoints are not
  supported, so check your resolver's docs before pointing Kody at it.
- **Limit: fast DNS rebinding.** The check is separate from the connection, and
  `fetch` resolves the name again when it connects, so a name that changes its
  answer between the check and the connect is not excluded. Closing this needs
  the connected IP to be checked; that is tracked in
  [kody-celld#45](https://github.com/kentcdodds/kody-celld/issues/45), after
  which this pre-check is removed.
- URLs with credentials (`https://user:pass@…`) are refused; use
  `bearerToken`.
- Redirects are followed by hand, at most 5, and every hop is checked against
  the same policy. The `Authorization` header is dropped as soon as the origin
  changes.

The browser's `KODY_BROWSER_ALLOW_PRIVATE_HOSTS` uses the same entry syntax
([browser.md](./browser.md)). Restart the node after changing either variable.

## Limits

| Limit                   | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| Tools per server        | 200 (the rest are dropped)                            |
| One tool's input schema | 64 KB, else replaced with a stub                      |
| Whole tool list         | 1,000,000 bytes serialized                            |
| Server instructions     | 8 KB (truncated)                                      |
| Call timeout            | `KODY_MCP_CALL_TIMEOUT_MS`, default 30 s (1 s–10 min) |
| Result size             | `KODY_MCP_CONTENT_LIMIT_BYTES`                        |
| Servers per user        | `KODY_QUOTA_MCP_SERVERS` (`0` = unlimited)            |

The run's own `KODY_EXECUTE_TIMEOUT_MS` still applies on top of the per-call
timeout. See [operations.md](./operations.md) for every variable.

## Errors

| Code                        | HTTP | When                                                                                                                                                                                                          |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp_server_not_found`      | 404  | No server with that name.                                                                                                                                                                                     |
| `mcp_server_exists`         | 409  | `mcpServerAdd` on a taken name without `replace: true`.                                                                                                                                                       |
| `mcp_server_disabled`       | 409  | The server is turned off.                                                                                                                                                                                     |
| `mcp_server_locked`         | 403  | The server is locked and the run's entry package is not granted, or `mcpServerAdd({ replace: true })` asked for a looser `usage`.                                                                             |
| `mcp_tool_not_found`        | 404  | The server has no tool with that name (try `mcpServerRefresh`).                                                                                                                                               |
| `mcp_host_not_allowed`      | 403  | A private host or plain `http:` URL not in `KODY_MCP_ALLOW_PRIVATE_HOSTS`, a host that resolves to a private address not allowed there, or a host that could not be resolved through `KODY_DNS_RESOLVER_URL`. |
| `mcp_call_failed`           | 502  | Transport or protocol failure, timeout, or an HTTP error from the server.                                                                                                                                     |
| `mcp_result_too_large`      | 413  | The result is over `KODY_MCP_CONTENT_LIMIT_BYTES`.                                                                                                                                                            |
| `mcp_server_unauthorized`   | 401  | An OAuth server has no grant yet, or the provider rejected it; open the server's `authUrl`.                                                                                                                   |
| `mcp_oauth_state_invalid`   | 400  | The OAuth callback's `state` is unknown, expired, another user's, or the server's origin changed.                                                                                                             |
| `mcp_oauth_client_required` | 409  | No client mode applies: no pre-registered client, no client metadata document support, no `registration_endpoint`.                                                                                            |
| `mcp_oauth_failed`          | 502  | The authorization server misbehaved: no authorization server advertised, a bad authorize URL, or a failed code exchange.                                                                                      |
| `quota_exceeded`            | 429  | `mcpServerAdd` of a new name would exceed `KODY_QUOTA_MCP_SERVERS`.                                                                                                                                           |
| `config_error`              | 500  | `KODY_MCP_ALLOW_PRIVATE_HOSTS`, `KODY_MCP_CALL_TIMEOUT_MS` or `KODY_DNS_RESOLVER_URL` is invalid.                                                                                                             |

Inside `execute` the code is the prefix of the thrown error's message
(`mcp_server_locked: …`).

## Not yet

- MCP resources and prompts; only tools are supported.
- The legacy HTTP+SSE transport; servers must speak Streamable HTTP.

`smoke/mcp-servers.mjs` covers add, search, ad hoc and package calls, lock,
disable, refresh, the host refusal, the account page and remove, against a real
SDK server (`smoke/mcp-mock-server.mjs`). `smoke/mcp-oauth.mjs` covers an OAuth
server end to end against `smoke/mcp-oauth-mock.mjs` (dynamic client
registration): add, consent page, provider, callback (and a replayed and an
unknown callback), calls, refresh on an expired access token, a revoked grant,
`mcpServerReconnect`, and remove, checking that no token leaks.
