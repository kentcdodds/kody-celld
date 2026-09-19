# Inbound webhooks

Packages can receive HTTP calls from the outside world (GitHub, Stripe, a
smart-home hub, `curl` from a cron box) without any Cloudflare-specific
plumbing: the Worker itself hosts the ingress route, each user's cell owns the
credentials and the delivery ledger, and every delivery runs a package export
with the usual provenance (`packageStorage()`, `{{secret:…}}`, run history).

| Piece                      | Self-hosted                                                                          | Adapter(s)                                             |
| -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Ingress + verification     | `POST /webhooks/:userId/:handle/:secret` on every node; HMAC checked inside the cell | —                                                      |
| Registering with providers | `webhookUrlApply` (GitHub repository hooks; generic HTTP target)                     | any provider API reachable through the secrets gateway |
| Delivery history           | `webhook_deliveries` in the user cell, `webhookDeliveryList`                         | —                                                      |

## Declaring webhooks in a package

```json
{
  "name": "@me/inbox-hooks",
  "exports": { ".": "./status.js", "./github": "./github.js", "./plain": "./plain.js" },
  "kody": {
    "webhooks": [
      {
        "name": "github",
        "export": "./github",
        "responseMode": "ack",
        "inputMode": "request",
        "rateLimitPerMinute": 120,
        "verification": {
          "type": "hmac-sha256",
          "header": "x-hub-signature-256",
          "prefix": "sha256=",
          "encoding": "hex",
          "secretName": "githubWebhookSecret",
          "signedPayload": "body"
        },
        "replay": { "deliveryIdHeader": "x-github-delivery" }
      },
      {
        "name": "plain",
        "export": "./plain",
        "responseMode": "sync",
        "inputMode": "params"
      }
    ]
  }
}
```

| Field                | Values                                                                       | Meaning                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`               | lowercase slug ≤ 64                                                          | Unique per package; part of the handle.                                                                                                                                                                |
| `export`             | key of `package.json#exports`                                                | The module whose default export runs per delivery.                                                                                                                                                     |
| `responseMode`       | `ack` (default), `sync`                                                      | `ack` answers `202` immediately and runs in the background; `sync` waits (bounded by `KODY_EXECUTE_TIMEOUT_MS`) and returns the export's value as JSON.                                                |
| `inputMode`          | `request` (default), `params`                                                | `request`: the export gets `{ webhook, request: { method, url, headers, body, json } }`. `params`: the parsed JSON body **is** the params object (plus `webhook`), for simple integrations.            |
| `rateLimitPerMinute` | 1 – 600 (default 60)                                                         | Sliding window per webhook; excess deliveries get `429` + `Retry-After`.                                                                                                                               |
| `verification`       | HMAC-SHA256 block                                                            | `header`, `encoding` (`hex`/`base64`), optional `prefix` (`sha256=`), `signedPayload` (`body` or `timestamp.body` for Stripe-style `t.body`), and `secretName` — the **name** of a stored user secret. |
| `replay`             | `timestampHeader`, `timestampFormat`, `toleranceSeconds`, `deliveryIdHeader` | Rejects stale timestamps (`unix-seconds`, `unix-millis`, `iso`, `stripe-signature`) and duplicate delivery ids (`409`).                                                                                |

Inline secrets in the manifest are rejected (`invalid_manifest`): the shared
secret is saved once with `secretSet({ name: 'githubWebhookSecret', value })`
and stays encrypted in the cell. Verification runs inside the Durable Object
(`UserCell.webhookSignatureCheck`), so neither the Worker route nor package
code ever sees the secret or the computed digest.

The handler for `inputMode: "request"`:

```js
// github.js
export default async function github({ webhook, request }) {
  // webhook = { name, handle, deliveryId, receivedAt }
  const event = request.headers['x-github-event']
  return { event, ref: request.json?.ref ?? null }
}
```

## Minting and handing out URLs

```
webhookUrlMint({ packageName: '@me/inbox-hooks', webhookName: 'github' })
  → { handle: 'whk_…', enabled: true, … }          // never the URL
```

The URL `https://<KODY_PUBLIC_URL>/webhooks/<userId>/<handle>/<secret>` is the
credential. It is shown exactly once per request through the authenticated API
route `GET /api/webhooks/<handle>/url` (audited as `webhook.reveal`) — never
through `execute`, `search`, run history or delivery records. Two ways to use
it without ever reading it yourself:

- `webhookUrlApply({ handle, target: { type: 'github', repo: 'owner/name', events: ['push'] } })`
  creates or updates the repository hook through `api.github.com` using the
  `{{secret:githubToken}}` placeholder (override with `tokenSecret`).
- `webhookUrlApply({ handle, target: { type: 'http', url, method, headers, body } })`
  sends any request in which the literal string `{{webhookUrl}}` is replaced
  by the URL; headers and body may carry `{{secret:…}}` placeholders and the
  host must be admin-approved like every other outbound call.

`webhookUrlRotate` mints a new secret and keeps the previous URL alive until
the first accepted delivery on the new one (or `previousExpiresAt`, whichever
comes first) so a provider can be re-pointed without dropping deliveries;
`webhookEnable` / `webhookDisable` / `webhookDelete` do what they say, and
`webhookDeliveryList({ handle, status })` shows metadata only (status,
HTTP result, run id, byte size, signature/replay verdicts).

Everything above is **direct-only**: available from `execute` and the API, but
not from package code (`forbidden_from_runtime`), so a package cannot mint,
reveal or reroute its own credentials.

## Ingress behaviour

| Condition                                               | Response                                                 |
| ------------------------------------------------------- | -------------------------------------------------------- |
| Unknown user/handle or wrong secret                     | `404` (constant-time compare; nothing else leaks)        |
| Disabled webhook                                        | `404`                                                    |
| Body over `KODY_WEBHOOK_MAX_BODY_BYTES` (1 MiB default) | `413`                                                    |
| Missing/invalid signature or timestamp                  | `401`                                                    |
| Duplicate delivery id / `Idempotency-Key`               | `409` (recorded as `duplicate`)                          |
| Over `rateLimitPerMinute`                               | `429` + `Retry-After: 60`                                |
| Invalid JSON with `inputMode: params`                   | `400`                                                    |
| `ack`                                                   | `202 { deliveryId, runId }`                              |
| `sync`                                                  | `200` with the export's return value (`500` if it threw) |

Raw body bytes are preserved for signature checks; the export receives the
decoded text plus `json` when the content type is JSON. Deliveries appear in
run history as `kind: 'webhook'` with `trigger: webhook:<name>`.

## Smoke coverage

`npm run smoke` runs the `webhooks` scenario against
`examples/packages/inbox-hooks`: mint for GitHub/Stripe/plain hooks, a
correctly signed GitHub delivery (`ack` → `202`, run recorded, storage
updated), a tampered signature (`401`), a replayed delivery id (`409`), a
Stripe-style `t=…,v1=…` signature inside and outside the replay window, sync
mode returning the export's value, `params` mode, the rate limit (`429`),
rotation with the grace period, disable (`404`), `webhookUrlApply` against a
local fake provider, and the no-leak assertions (the URL secret appears in
neither capability results nor delivery lists nor the audit log).
