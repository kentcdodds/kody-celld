# Provider-backed secrets (`{{secret/<provider>:<ref>}}`)

Ordinary secrets are pasted into Kody once (`secretSave`). Provider-backed
secrets stay in an external vault — 1Password Connect, HashiCorp Vault,
Bitwarden, your own service — and are fetched on demand by a **provider
package** you install and bind. The fetched value is injected into the
outbound request by the gateway and nowhere else: it is never stored in the
cell, never in run history or logs, never returned to code.

```ts
await fetch('https://api.stripe.com/v1/charges', {
  headers: { authorization: 'Bearer {{secret/1password:vaults/Ops/items/Stripe/fields/credential}}' },
})
```

## Pieces

| Piece                | What it is                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider package** | A saved package with `"kody": { "secretProvider": { "id": "1password" } }` and a `"./secretProvider"` export. Examples: `examples/packages/onepassword-connect`, `examples/packages/smoke-vault`. |
| **Door secret**      | The vault credential (Connect token, Vault token…), stored with `secretSave` as a user secret. The provider reaches the vault with `{{secret:<door>}}` like any package.                          |
| **Binding**          | `secretProviderBind({ providerId, packageName, doorSecretName, config, locked })` — connects the id in the placeholder to the package and its non-secret config.                                  |
| **Grant**            | On a `locked` binding, `secretProviderGrant({ providerId, packageName, ref })` allows one package to resolve one item.                                                                            |

## Writing a provider package

```js
// provider.js — the "./secretProvider" export
import { secretHeaders } from 'kody:runtime'

export default async function secretProvider({ providerId, ref, config, doorSecretName }) {
  const res = await fetch(`${config.baseUrl}/v1/items/${encodeURIComponent(ref)}`, {
    headers: secretHeaders.bearer(doorSecretName), // -> authorization: Bearer {{secret:<door>}}
  })
  if (!res.ok) throw new Error(`vault responded ${res.status}`)
  const item = await res.json()
  return { value: item.value, hosts: item.hosts ?? [], canonicalRef: item.id }
}
```

The provider receives `{ providerId, ref, config, doorSecretName }` and
returns:

| Field          | Meaning                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`        | the secret (string). Required.                                                                                                                      |
| `hosts`        | hosts this value may be sent to (e.g. the item's website URLs). Optional; `[]` means "only admin-approved secret hosts".                            |
| `canonicalRef` | stable identity of the item (ids rather than titles). Grants and the cache are keyed on it, so `items/Stripe` and `items/abc123` are the same item. |

Rules the runtime enforces on the package:

- The `./secretProvider` export runs **only in a sealed run** started by the
  gateway while resolving a placeholder. `packageRun` of that export is
  refused (`secret_provider_entry_sealed`, 403), and any `import` of the
  module — `kody:<pkg>/secretProvider` from ad hoc code or another package, or
  a relative import from inside the same package — is redirected at
  graph-build time to a stub that throws with the same code. The package's
  other exports keep working.
- A sealed run keeps its row in run history (status, duration, `gateway[]`
  decisions) but stores **no result and no console output**.
- The provider gets the door secret only as a placeholder name; the door value
  is injected by the gateway when the provider calls the vault, so the vault
  host must be an admin-approved secret host (see [secrets.md](./secrets.md)).
- A bound provider package may not itself use `{{secret/…}}`
  (`secret_provider_recursion`).
- `config` is validated on bind: ≤ 16 string entries, ≤ 2000 chars each, and
  keys that look like credentials (`token`, `secret`, `password`, `apiKey`…)
  are rejected — credentials go through `doorSecretName`.

## Binding and grants

```ts
import { kody } from 'kody:runtime'
await kody.secretSave({ name: 'op-connect-token', value: '<connect token>' })
await kody.secretProviderBind({
  providerId: '1password',
  packageName: '@kody-examples/onepassword-connect',
  doorSecretName: 'op-connect-token',
  config: { baseUrl: 'https://connect.example.com' },
})
await kody.secretProviderList() // bindings + grants; never values

// Lock it so only granted packages may resolve refs (ad hoc code never can):
await kody.secretProviderLock({ providerId: '1password', locked: true })
await kody.secretProviderGrant({
  providerId: '1password',
  packageName: '@me/billing',
  ref: 'vaults/…/items/…/fields/credential',
})
await kody.secretProviderRevoke({ providerId: '1password', packageName: '@me/billing', ref: '…' })
await kody.secretProviderUnbind({ providerId: '1password' })
```

- Unlocked binding: any code of the user (ad hoc or package) may reference any
  ref — the vault is the source of truth for what exists.
- Locked binding: a package needs a grant for the item's **canonical** ref. A
  package that already holds some grant for the provider may name an item by
  alias (title/label); the provider resolves it, and the gateway re-checks the
  grant against the returned `canonicalRef` before injecting anything.
- Deleting the provider package, rebinding, locking, revoking a grant or
  unbinding all invalidate cached values for that provider.
- All `secretProvider*` capabilities are refused from package code
  (`forbidden_from_package`).

## Gateway decision for `{{secret/<provider>:<ref>}}`

```
not https (and host not in KODY_ALLOW_INSECURE_SECRET_HOSTS) → 403 insecure_scheme
caller is itself a bound provider package                    → 403 secret_provider_recursion
provider id not bound                                        → 404 secret_provider_not_bound
locked and caller has no grant                               → 403 secret_provider_not_granted
bound package gone / no longer declares kody.secretProvider  → 404 secret_provider_package_missing
provider threw / timed out (KODY_SECRET_PROVIDER_TIMEOUT_MS) → 502 secret_provider_failed   { runId }
provider returned a non-{ value, hosts?, canonicalRef? }     → 502 secret_provider_invalid_result
host ∉ item hosts and not an admin-approved secret host      → 403 secret_provider_host_not_allowed { itemHosts }
otherwise                                                    → inject, forward, record 'injected'
```

Denials are synthetic responses like every other gateway decision; the
`gateway[]` entry on the run names the placeholder, never the value.

## Cache

Resolved values are cached **in memory of the user cell only** for
`KODY_SECRET_PROVIDER_CACHE_SECONDS` (default `300`, `0` disables) — never
written to SQLite or the bucket. The cache is keyed by both the alias used and
the `canonicalRef`, and dropped on any binding/grant change or cell restart.
`KODY_SECRET_PROVIDER_TIMEOUT_MS` (default `20000`) caps a single provider
run.

## Audit

`secret_provider.bind`, `secret_provider.unbind`, `secret_provider.lock`,
`secret_provider.grant`, `secret_provider.revoke` are written to the admin
audit log with provider id, package name and ref — never config values,
door secrets or resolved values.

## Smoke

`smoke/secret-providers.mjs` (part of `npm run smoke`) runs a mock vault and
API on loopback with a random per-run item value and door token and proves:
binding validation (missing door secret, credential-looking config), injection
via `@kody-smoke/smoke-vault` with the door secret itself gated by the
gateway, the in-memory cache, sealed run rows with no result/logs, refusal of
`packageRun` and `kody:` imports of the provider entry, item host allowlists,
lock/grant/revoke with cache invalidation, provider errors, unbind
fail-closed, and that the value's SHA-256 never appears in run history, audit
or any response.
