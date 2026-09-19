# Secrets

Design goal, inherited from production Kody: **sandbox code never sees a
secret value**. It sees placeholders; the host swaps them in at the network
boundary, and only for destinations an admin approved.

## Storing

```ts
await kody.secretSave({ name: 'github', value: 'ghp_...' }) // user scope (default)
await kody.secretSave({ name: 'api-key', value: '...', scope: 'package' }) // only the saving package may use it
await kody.secretList() // names, scopes, timestamps — never values
await kody.secretDelete({ name: 'github' })
```

Values are AES-256-GCM encrypted with a fresh 12-byte IV under a per-user key:
`HKDF(master = KODY_MASTER_KEY, salt = "kody-celld:<userId>", info = "kody-celld-secret-values")`.
Ciphertext lives in the user's `UserCell`; the master key lives only in the
Worker var. `secretSave` responses and run results are checked by the smoke
suite to never contain the plaintext.

## Placeholders

| Form                                               | Replaced with                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `{{secret:name}}`                                  | the value                                                                      |
| `{{secret:name\|scope=package}}`                   | the value, only if the package-scoped secret belongs to the running package    |
| `{{secret-basic:username=u,password=p}}`           | `Basic base64(u_value:p_value)`; a leading `Basic ` in the header is collapsed |
| `{{secret/provider:…}}`, `{{integration-token:…}}` | parsed, **denied** as unsupported in v1                                        |

Placeholders are recognised in the URL (path, query, also URL-encoded
`%7B%7B…%7D%7D`), any header, and the request body (string/JSON bodies).

## The gateway decision

Every outbound `fetch` from an isolate is routed through `FetchGateway`
(`globalOutbound`). For requests containing placeholders:

```
admin surface?          → 403 admin_surface_blocked
unsupported kind?       → 403 placeholder_kind_unsupported
not https (and host not in KODY_ALLOW_INSECURE_SECRET_HOSTS)? → 403 insecure_scheme
host not approved?      → 403 secret_host_not_approved  { approvalUrl }
secret missing?         → 404 secret_not_found          { missing }
otherwise               → replace, forward, record 'injected'
```

Denials are synthetic `Response`s returned to the sandbox with a JSON body;
the request never leaves the node. Requests **without** placeholders are
forwarded untouched (`outcome: 'forwarded'`) — the gateway is not an egress
firewall. Every decision is recorded on the run (`gateway[]`) with host,
outcome, status, reason and the secret **names** involved.

## Approving hosts (admin only)

```sh
curl -X POST $BASE/admin/users/$USER_ID/secret-hosts \
  -H "authorization: Bearer $KODY_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"host":"api.github.com"}'
curl $BASE/admin/users/$USER_ID/secret-hosts -H "authorization: Bearer $KODY_ADMIN_TOKEN"
curl -X DELETE $BASE/admin/users/$USER_ID/secret-hosts/api.github.com -H "authorization: Bearer $KODY_ADMIN_TOKEN"
```

Hosts are normalised (lowercase, no port), IPv6 literals are bracketed, and
`*.example.com` approves exactly one label depth. Users can read their list
(`kody.secretHostList()`) but not change it; the denial message includes the
`approvalUrl` so an agent can ask a human precisely.

## Development

`KODY_ALLOW_INSECURE_SECRET_HOSTS=127.0.0.1,localhost` (set in `wrangler.jsonc`
for `celld dev`) lets the smoke suite inject into a plain-HTTP loopback echo
server. Do not render it into a fleet config unless you are port-forwarding a
test harness.

## Not in v1

- Master key rotation / multiple key versions.
- Provider-scoped secrets and OAuth integration tokens.
- Per-secret host allowlists (approval is per host, per user).
- Egress allowlisting for placeholder-free requests.
