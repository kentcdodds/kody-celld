# Cloudflare Email Routing → self-hosted Kody

Use this when your domain's mail already runs through Cloudflare Email Routing
(free, handles MX/SPF/DKIM for you) and you want messages delivered to a
kody-celld node instead of running the SMTP `mail-bridge` yourself.

1. `wrangler deploy` from this directory after setting `KODY_URL` in
   `wrangler.jsonc` and `wrangler secret put KODY_EMAIL_INBOUND_TOKEN`
   (the same value as the node's `KODY_EMAIL_INBOUND_TOKEN`).
2. In the Cloudflare dashboard → Email → Email Routing → Routing rules, send
   the catch-all (or specific addresses) to the `kody-email-forwarder` Worker.
3. Set `KODY_EMAIL_DOMAIN` on the node to the same domain; users then claim
   `<local>@<domain>` with `emailInboxClaim`.

The Worker posts the raw message to `POST /email/inbound/cloudflare` with the
SMTP envelope in `x-kody-envelope-from` / `x-kody-envelope-to`. A `404` from
Kody (no claimed inbox) is turned into an SMTP reject; other failures throw so
Cloudflare retries. Outbound mail is unaffected — pick any adapter in
[docs/email.md](../../docs/email.md).
