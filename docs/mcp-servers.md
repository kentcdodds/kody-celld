# External MCP servers (`kody.mcp`)

Kody can be an MCP **client**: you add a remote MCP server (Home Assistant, a
LAN tool box, any hosted MCP endpoint) once, and `execute` code and packages
call its tools as `kody.mcp['name'].tool(input)`. The call runs host-side in
your user cell, so the sandbox never sees the server's bearer token.

Only the Streamable HTTP transport is supported, with an optional static bearer
token. Servers are per user and are listed on `/account/mcp-servers`.

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
  unless you pass `usage` / `enabled`, and a `usage` looser than the stored lock
  (back to `any`, or dropping a granted package) is refused with
  `mcp_server_locked`.

`mcpServerList()` lists your servers (never the token). `mcpServerRefresh`
re-lists the tools, `mcpServerSetEnabled({ name, enabled })` turns a server
off and on, and `mcpServerRemove({ name })` deletes it. The management
capabilities are refused from package code (`forbidden_from_package`);
`mcpServerList` works everywhere.

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

| Code                   | HTTP | When                                                                                                                                                                                                          |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp_server_not_found` | 404  | No server with that name.                                                                                                                                                                                     |
| `mcp_server_exists`    | 409  | `mcpServerAdd` on a taken name without `replace: true`.                                                                                                                                                       |
| `mcp_server_disabled`  | 409  | The server is turned off.                                                                                                                                                                                     |
| `mcp_server_locked`    | 403  | The server is locked and the run's entry package is not granted, or `mcpServerAdd({ replace: true })` asked for a looser `usage`.                                                                             |
| `mcp_tool_not_found`   | 404  | The server has no tool with that name (try `mcpServerRefresh`).                                                                                                                                               |
| `mcp_host_not_allowed` | 403  | A private host or plain `http:` URL not in `KODY_MCP_ALLOW_PRIVATE_HOSTS`, a host that resolves to a private address not allowed there, or a host that could not be resolved through `KODY_DNS_RESOLVER_URL`. |
| `mcp_call_failed`      | 502  | Transport or protocol failure, timeout, or an HTTP error from the server.                                                                                                                                     |
| `mcp_result_too_large` | 413  | The result is over `KODY_MCP_CONTENT_LIMIT_BYTES`.                                                                                                                                                            |
| `quota_exceeded`       | 429  | `mcpServerAdd` of a new name would exceed `KODY_QUOTA_MCP_SERVERS`.                                                                                                                                           |
| `config_error`         | 500  | `KODY_MCP_ALLOW_PRIVATE_HOSTS`, `KODY_MCP_CALL_TIMEOUT_MS` or `KODY_DNS_RESOLVER_URL` is invalid.                                                                                                             |

Inside `execute` the code is the prefix of the thrown error's message
(`mcp_server_locked: …`).

## Not yet

- OAuth-protected MCP servers (planned as a follow-up).
- MCP resources and prompts; only tools are supported.
- The legacy HTTP+SSE transport; servers must speak Streamable HTTP.

`smoke/mcp-servers.mjs` covers add, search, ad hoc and package calls, lock,
disable, refresh, the host refusal, the account page and remove, against a real
SDK server (`smoke/mcp-mock-server.mjs`).
