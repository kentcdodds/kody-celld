// Cloudflare Email Worker that forwards every message Cloudflare Email Routing
// hands it to a self-hosted kody-celld node. Keep Cloudflare as your MX, point
// a catch-all (or specific addresses) at this Worker, and Kody receives the raw
// RFC 5322 message with the SMTP envelope exactly like the mail-bridge does.
//
// Bindings (wrangler.jsonc vars / secrets):
//   KODY_URL                  https://kody.example.com
//   KODY_EMAIL_INBOUND_TOKEN  the node's KODY_EMAIL_INBOUND_TOKEN  (wrangler secret put)
//
// Cloudflare's message.raw is a stream; we buffer it (Email Routing caps
// messages at 25 MiB) so the node can enforce KODY_EMAIL_MAX_BYTES itself.
export default {
	async email(message, env) {
		const raw = new Uint8Array(await new Response(message.raw).arrayBuffer())
		const response = await fetch(`${env.KODY_URL.replace(/\/$/, '')}/email/inbound/cloudflare`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.KODY_EMAIL_INBOUND_TOKEN}`,
				'content-type': 'message/rfc822',
				'x-kody-envelope-from': message.from,
				'x-kody-envelope-to': message.to,
			},
			body: raw,
		})
		if (response.ok) return
		// 404 = no claimed inbox for this recipient: bounce so the sender learns.
		// Anything else is a temporary failure; Cloudflare retries when we throw.
		if (response.status === 404) {
			message.setReject('No such mailbox')
			return
		}
		throw new Error(`kody responded ${response.status}`)
	},
}
