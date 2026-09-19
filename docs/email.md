# Email

Production Kody receives mail through Cloudflare Email Routing and sends through
a mail API. Neither exists on a self-hosted box, so kody-celld treats email as
**adapters at the HTTP boundary** plus a **self-hosted SMTP sidecar** for
people who want no third party at all. Off by default: with `KODY_EMAIL_DOMAIN`
unset every `email*` capability answers `email_not_configured`.

| Piece                   | Self-hosted                                                                              | Adapter(s)                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Inbound (receive)       | `mail-bridge` SMTP sidecar (`compose.mail.yaml`) → `POST /email/inbound/bridge`          | generic JSON / `message/rfc822`, Postmark, Mailgun, SendGrid Inbound Parse, Cloudflare Email Worker forwarder |
| Outbound (send)         | `mail-bridge` `POST /send` → your SMTP relay (or direct MX delivery)                     | Resend, Postmark, Mailgun, SendGrid                                                                           |
| Delivery status         | bridge posts `sent`/`failed` to `POST /email/events/bridge`                              | provider webhooks → `POST /email/events/<provider>`                                                           |
| Storage, rules, threads | per-user cell tables (`email_messages`, `email_attachments`, sender rules, destinations) | —                                                                                                             |

## What users get

Every user owns inbox addresses on the deployment domain and can read, file,
search, send and reply from `execute`; packages subscribe to inbound mail.

| Capability                                                                                    | Purpose                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `emailStatus`                                                                                 | Domain, enabled inbound adapters, outbound provider (`hasToken`, never the token).                                                               |
| `emailInboxClaim` / `emailInboxList` / `emailInboxRelease`                                    | Claim `<local>@<domain>` (lowercase slug, 2–63 chars; `postmaster`, `abuse`, `admin`, … are reserved). `<local>+tag@…` works automatically.      |
| `emailMessageList` / `emailMessageSearch` / `emailMessageGet` / `emailMessageDelete`          | Inbox and quarantine, substring search over subject/sender/text, full record (safe headers, text, HTML, attachment metadata, `x-kody-plus-tag`). |
| `emailAttachmentGet`                                                                          | Attachment bytes (base64) on demand; subscription payloads carry metadata only.                                                                  |
| `emailSenderRuleSet` / `emailSenderRuleList` / `emailSenderRuleDelete`, `emailMessageRelease` | Route a sender or `@domain` to `inbox` or `quarantine`; release a quarantined message.                                                           |
| `emailDestinationAdd` / `emailDestinationVerify` / `emailDestinationSetDefault` / … `Remove`  | Where you may send to: your account email (pre-verified), your own inboxes, and addresses confirmed with a 6-digit code (30 min).                |
| `emailSend` / `emailReply`                                                                    | Send from one of your inboxes (text/HTML, attachments, allow-listed extra headers); reply threads `In-Reply-To`/`References` automatically.      |
| `emailDeliveryEventList`                                                                      | Provider delivery events (`queued`, `sent`, `delivered`, `bounced`, …) for a sent message.                                                       |

Inbox claiming, destination management and releasing are **direct-only**
(`forbidden_from_runtime` from package code). Sends are bounded by
`KODY_QUOTA_EMAIL_SENDS_PER_DAY`, stored mail by `KODY_QUOTA_EMAIL_MESSAGES`
and `KODY_QUOTA_EMAIL_RECEIVES_PER_DAY` (see [operations.md](./operations.md)).

### Package subscriptions

```json
{
  "kody": {
    "subscriptions": {
      "email.message.received": { "handler": "./lib/on-email.js" },
      "email.message.quarantined": { "handler": "./lib/on-spam.js" },
      "email.message.delivery.updated": { "handler": "./lib/on-delivery.js" }
    }
  }
}
```

```js
// lib/on-email.js — params: { topic, packageName, message }
export default async function onEmail({ message }) {
  // message: id, inboxAddress, from, to, subject, text, html, snippet, headers, attachments (metadata)
  const first = message.attachments[0]
  if (first) await kody.emailAttachmentGet({ messageId: message.id, attachmentId: first.id })
  return { filed: message.id }
}
```

Handlers run through the normal `executeRun` with `kind: 'subscription'` and
the package's provenance, so `packageStorage()` and `{{secret:…}}` work and
failures show up in run history (`trigger: subscription:<topic>`).

## Inbound adapters

All inbound routes are `POST /email/inbound/<provider>` and authenticate with
the deployment-wide `KODY_EMAIL_INBOUND_TOKEN`, presented however the provider
allows: `Authorization: Bearer`, HTTP Basic (password = token), `?token=` in
the URL, or `x-kody-email-token`. The route answers `200` with
`{ accepted: [...], rejected: [...] }`, `404` when no recipient is a claimed
inbox (`no_inbox`), `200 duplicate` for a repeated `Message-ID`, `413` over
`KODY_EMAIL_MAX_BYTES`, `429` over quota.

| Provider     | Configure                                                                                                                                                   | Notes                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bridge`     | `compose.mail.yaml`; nothing else                                                                                                                           | `message/rfc822` bytes + `x-kody-envelope-from` / `x-kody-envelope-to`; the sidecar sets everything.                |
| `generic`    | Any forwarder you write: JSON `{ from, to, subject, text, html, headers, attachments: [{ filename, contentType, contentBase64 }] }` or raw `message/rfc822` | Addresses may be strings or `{ address, name }`.                                                                    |
| `postmark`   | Inbound webhook URL `https://<host>/email/inbound/postmark`, HTTP Basic auth (any user, password = token)                                                   | Uses Postmark's JSON (`FromFull`, `ToFull`, `Attachments`).                                                         |
| `mailgun`    | Route → `https://<host>/email/inbound/mailgun?token=…`; set `KODY_EMAIL_MAILGUN_SIGNING_KEY` to also verify Mailgun's signature                             | Multipart form (`sender`, `recipient`, `body-plain`, `attachment-N`).                                               |
| `sendgrid`   | Inbound Parse → `https://<host>/email/inbound/sendgrid?token=…`                                                                                             | Multipart form (`envelope`, `email` raw when "POST the raw, full MIME message" is on, otherwise the parsed fields). |
| `cloudflare` | Deploy [`examples/cloudflare-email-forwarder`](../examples/cloudflare-email-forwarder) as an Email Worker on your zone                                      | Keeps Cloudflare Email Routing as the MX and forwards the raw message to your self-hosted node.                     |

Every adapter produces the same normalized message: parsed address lists, a
safe header allow-list (`from`, `to`, `subject`, `message-id`, `references`,
`list-*`, `authentication-results`, the top-most `received`, …), text and HTML
bodies (capped; `snippet` falls back to stripped HTML when there is no text
part), and attachments with sanitized filenames. Routing resolves each recipient on
the domain to its owner via the registry, strips the `+tag` (stored as
`x-kody-plus-tag`), applies sender rules, stores the message, and dispatches
`email.message.received` or `email.message.quarantined`.

## Outbound adapters

`KODY_EMAIL_OUTBOUND_PROVIDER` selects one adapter per deployment; the token
is operator-owned and only ever added to the provider request.

| Provider   | `KODY_EMAIL_OUTBOUND_URL`             | `KODY_EMAIL_OUTBOUND_TOKEN`                    | Delivery events                                             |
| ---------- | ------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| `bridge`   | `http://mail-bridge:8025` (required)  | `MAIL_BRIDGE_TOKEN`                            | posted by the bridge itself                                 |
| `resend`   | default `https://api.resend.com`      | API key                                        | `POST /email/events/resend` (`email.sent`, `.delivered`, …) |
| `postmark` | default `https://api.postmarkapp.com` | server token                                   | `POST /email/events/postmark` (`Delivery`, `Bounce`, …)     |
| `mailgun`  | default `https://api.mailgun.net`     | API key (`KODY_EMAIL_MAILGUN_DOMAIN` optional) | `POST /email/events/mailgun`                                |
| `sendgrid` | default `https://api.sendgrid.com`    | API key                                        | `POST /email/events/sendgrid` (Event Webhook)               |

Event routes use the same `KODY_EMAIL_INBOUND_TOKEN` (`?token=` works for
providers that cannot send headers). Events are matched to sent messages by
provider message id, update `deliveryStatus`, land in `emailDeliveryEventList`
and dispatch `email.message.delivery.updated`; unmatched ids are reported back
as `unmatched` and otherwise ignored.

Recipients are restricted to verified destinations; `emailReply` is allowed to
answer the original sender without that check. The `From` is always one of the
user's inboxes (`KODY_EMAIL_FROM_NAME` as display name), so a self-hosted Kody
never sends on behalf of arbitrary addresses.

## The mail bridge (no third party)

`mail-bridge/` is a ~300-line Node sidecar (`smtp-server` + `nodemailer`):

- **SMTP in (port 25)**: accepts `RCPT TO` only for `KODY_EMAIL_DOMAIN`
  (`550` otherwise), prepends a `Received:` header, and forwards the raw
  message to `POST /email/inbound/bridge` with the SMTP envelope. Kody's answer
  becomes the SMTP reply — `250` accepted, `550` unknown inbox, `552` too
  large, `452` over quota, `451` temporary failure — so senders retry or bounce
  correctly. Optional STARTTLS via `MAIL_BRIDGE_TLS_CERT`/`_KEY`.
- **HTTP out (port 8025, internal)**: `POST /send` with
  `Authorization: Bearer MAIL_BRIDGE_TOKEN`; validates that `from` is on the
  domain, generates a `Message-ID`, answers `202 { messageId, status: 'queued' }`,
  delivers through `MAIL_BRIDGE_SMTP_URL` (`smtp://` / `smtps://` with
  credentials — your ISP, Fastmail, SES SMTP, Postfix…) or **directly to the
  recipient's MX** when unset, then posts `sent`/`failed` to Kody.
- Logs are structured JSON with ids, sizes and status codes — never bodies or
  tokens.

```sh
# .env
COMPOSE_FILE=compose.yaml:compose.mail.yaml
KODY_EMAIL_DOMAIN=kody.example.com
KODY_EMAIL_INBOUND_TOKEN=<openssl rand -hex 32>
MAIL_BRIDGE_TOKEN=<openssl rand -hex 32>
MAIL_BRIDGE_SMTP_URL=smtps://user:pass@smtp.example.com:465   # empty = direct MX delivery
docker compose up -d
```

DNS: an `MX` record for `kody.example.com` pointing at the host running the
bridge (`A`/`AAAA` for that name), and TCP 25 open on your router. For outbound
reputation add `SPF` (`v=spf1 mx -all` or your relay's include) and, if you
relay through a provider, its DKIM records; direct MX delivery from a home IP
is frequently rejected by large receivers, which is why a relay is the default
recommendation. On a fleet, run the bridge on any host that can reach a node
(`KODY_URL`) and set `KODY_EMAIL_OUTBOUND_URL` on the nodes to it.

## Configuration

| Variable                                                                                           | Default      | Notes                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `KODY_EMAIL_DOMAIN`                                                                                | —            | Enables email. Every inbox is `<local>@<domain>`.                                                                                  |
| `KODY_EMAIL_INBOUND_TOKEN`                                                                         | —            | Shared token for `/email/inbound/*` and `/email/events/*`.                                                                         |
| `KODY_EMAIL_MAILGUN_SIGNING_KEY`                                                                   | —            | Also verify Mailgun's `timestamp`/`token`/`signature` on inbound.                                                                  |
| `KODY_EMAIL_OUTBOUND_PROVIDER`                                                                     | `none`       | `none`, `bridge`, `resend`, `postmark`, `mailgun`, `sendgrid`.                                                                     |
| `KODY_EMAIL_OUTBOUND_URL`                                                                          | per provider | Bridge base URL (required for `bridge`); API base override otherwise.                                                              |
| `KODY_EMAIL_OUTBOUND_TOKEN`                                                                        | —            | Provider API key or the bridge token. Operator-only.                                                                               |
| `KODY_EMAIL_MAILGUN_DOMAIN`                                                                        | domain       | Mailgun sending domain.                                                                                                            |
| `KODY_EMAIL_FROM_NAME`                                                                             | `Kody`       | Display name on outbound mail.                                                                                                     |
| `KODY_EMAIL_TIMEOUT_MS`                                                                            | `15000`      | Provider request timeout (1 s – 120 s).                                                                                            |
| `KODY_EMAIL_MAX_BYTES`                                                                             | `10485760`   | Stored size per message including attachments.                                                                                     |
| `KODY_QUOTA_EMAIL_MESSAGES`, `KODY_QUOTA_EMAIL_SENDS_PER_DAY`, `KODY_QUOTA_EMAIL_RECEIVES_PER_DAY` | `0`          | Per-user quotas; `0` = unlimited.                                                                                                  |
| `MAIL_BRIDGE_*`                                                                                    |              | `TOKEN`, `SMTP_URL`, `HOSTNAME`, `SMTP_PORT` (25), `HTTP_PORT` (8025), `BIND`, `MAX_BYTES`, `TLS_CERT`/`TLS_KEY`, `REPORT_EVENTS`. |

`wrangler.jsonc` ships loopback-only development placeholders
(`kody.local.test`, `bridge` at `http://127.0.0.1:9796`) so `npm run dev` has
email enabled for the smoke tests; they are not credentials.

## Smoke coverage

- `npm run smoke` → `email`: capability discovery, package subscription,
  direct-only guards, inbox claim + reserved local, generic JSON and raw
  `message/rfc822` ingestion (auth, unknown inbox, plus-addressing, duplicate
  `Message-ID`, MIME attachment round trip), search, subscription run
  provenance, sender-rule quarantine and release, outbound request shape
  against a fake bridge, destination verification (the code never appears in
  results), reply threading, delivery events (auth, `matched`/`unmatched`),
  deletion and inbox release, and the no-leak assertions (tokens and bodies
  never appear in results, run history or the audit log).
- `SMOKE_MAIL_BRIDGE=1 npm run smoke -- --only mail-bridge` (after
  `npm ci --prefix mail-bridge`) → the real sidecar: a Nodemailer SMTP client
  delivers a multipart message to the bridge, which forwards it into Kody
  (foreign domain `550` at `RCPT TO`, unknown inbox `550` at `DATA`), then
  `emailSend` goes bridge → local SMTP relay, and the bridge's `sent` event
  updates the stored message — with an assertion that bridge logs contain no
  message content.
- `mail-bridge/*.test.mjs` (part of `npm run validate`) covers config parsing,
  recipient policy, `Received:` headers, SMTP reply mapping, `/send` validation
  and a live SMTP → fake-Kody round trip.
