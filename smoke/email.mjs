// M5 email smoke: inbox claim + plus addressing, the authenticated inbound
// routes (generic JSON and a raw RFC 5322 message the way the mail bridge posts
// it), MIME/attachment storage, sender rules + quarantine/release, package
// subscription fan-out, outbound send/reply through a loopback "mail bridge",
// destination verification, delivery events, and that no token or body leaks
// into capability output.
//
// Needs KODY_EMAIL_DOMAIN + KODY_EMAIL_INBOUND_TOKEN + the bridge outbound
// provider on the server (wrangler.jsonc has loopback-only dev values). The
// scenario runs its own fake bridge on SMOKE_BRIDGE_PORT (9796) and skips
// itself when email is not configured on the target deployment.
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, baseUrl, log, readPackageDir } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageName = '@kody-smoke/inbox-hooks'
const inboundToken = process.env.KODY_EMAIL_INBOUND_TOKEN ?? 'dev-email-inbound-token-only-for-celld-dev'
const bridgeToken = process.env.KODY_EMAIL_OUTBOUND_TOKEN ?? 'dev-email-bridge-token-only-for-celld-dev'

async function post(pathname, { headers = {}, body, token = inboundToken }) {
	const response = await fetch(`${baseUrl}${pathname}`, {
		method: 'POST',
		headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
		body,
	})
	const text = await response.text()
	let json
	try {
		json = JSON.parse(text)
	} catch {
		json = { raw: text }
	}
	return { status: response.status, json }
}

const postJson = (pathname, body, options = {}) =>
	post(pathname, {
		...options,
		headers: { 'content-type': 'application/json', ...options.headers },
		body: JSON.stringify(body),
	})

async function waitFor(check, label, timeoutMs = 15_000) {
	const started = Date.now()
	for (;;) {
		const value = await check()
		if (value) return value
		assert(Date.now() - started < timeoutMs, `timed out waiting for ${label}`)
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export async function smokeEmail({ mcp, user }) {
	const status = await mcp.call('emailStatus', {})
	if (!status.configured) {
		log('skip', 'KODY_EMAIL_DOMAIN is not set on this deployment; email scenario skipped')
		return
	}
	assert(!JSON.stringify(status).includes(inboundToken), 'STATUS LEAKED THE INBOUND TOKEN', status)
	const domain = status.domain
	log('status', { domain, inbound: status.inbound, outbound: status.outbound, outboundBaseUrl: status.outboundBaseUrl })

	const found = await mcp.search({ entity: 'capability', domain: 'email', limit: 50 })
	const ids = new Set(found.results.map((hit) => hit.id))
	for (const expected of ['emailInboxClaim', 'emailMessageList', 'emailSend', 'emailReply', 'emailSenderRuleSet']) {
		assert(ids.has(expected), `search should surface ${expected}`, [...ids])
	}

	const files = await readPackageDir(path.join(here, '..', 'examples', 'packages', 'inbox-hooks'))
	const saved = await mcp.call('packageSave', { files, source: 'examples/packages/inbox-hooks' })
	assert(
		saved.manifest.subscriptions.some((s) => s.topic === 'email.message.received'),
		'package must subscribe to email.message.received',
		saved.manifest,
	)

	// 1. inbox claim (direct only, reserved names refused, plus addressing lands in the same inbox)
	const local = `smoke-${randomBytes(3).toString('hex')}`
	const fromRuntime = await mcp.execute(
		`import { kody } from 'kody:runtime'\nexport default async function main() { return await kody.emailInboxClaim({ local: ${JSON.stringify(local)} }) }`,
	)
	assert(
		!fromRuntime.ok && /forbidden_from_runtime/.test(JSON.stringify(fromRuntime.error)),
		'claim from runtime refused',
		fromRuntime,
	)
	const claimed = await mcp.callDirect('emailInboxClaim', { local })
	assert(claimed.address === `${local}@${domain}`, 'claim address', claimed)
	const reserved = await mcp.callDirectRaw('emailInboxClaim', { local: 'postmaster' })
	assert(
		reserved.isError && /reserved/.test(JSON.stringify(reserved.payload)),
		'postmaster must be reserved',
		reserved.payload,
	)
	const inboxes = await mcp.call('emailInboxList', {})
	assert(
		inboxes.inboxes.some((i) => i.local === local),
		'inbox list',
		inboxes,
	)
	log('inbox', { address: claimed.address, reserved: reserved.payload?.error?.code ?? 'refused' })

	// 2. generic JSON inbound: auth, unknown inbox, plus tag, attachments
	const attachment = randomBytes(600)
	const generic = {
		from: { address: 'alice@sender.example', name: 'Alice' },
		to: [`${local}+receipts@${domain}`],
		subject: `Smoke receipt ${randomBytes(3).toString('hex')}`,
		text: 'Attached is the receipt you asked for.',
		html: '<p>Attached is the <b>receipt</b> you asked for.</p>',
		messageId: `<generic-${randomBytes(6).toString('hex')}@sender.example>`,
		headers: { 'x-mailer': 'smoke', 'received-spf': 'pass' },
		attachments: [
			{ filename: '../receipt.pdf', contentType: 'application/pdf', contentBase64: attachment.toString('base64') },
		],
	}
	const unauthorized = await postJson('/email/inbound/generic', generic, { token: null })
	assert(unauthorized.status === 401, 'inbound without token must be 401', unauthorized.json)
	const wrongToken = await postJson('/email/inbound/generic', generic, { token: 'nope' })
	assert(wrongToken.status === 401, 'inbound with a wrong token must be 401', wrongToken.json)
	const unknownInbox = await postJson('/email/inbound/generic', { ...generic, to: [`nobody-${local}@${domain}`] })
	assert(
		unknownInbox.status === 404 && unknownInbox.json.rejected[0].reason === 'no_inbox',
		'unknown inbox is 404',
		unknownInbox.json,
	)
	const accepted = await postJson('/email/inbound/generic', generic)
	assert(accepted.status === 200 && accepted.json.accepted.length === 1, 'generic inbound accepted', accepted.json)
	const [first] = accepted.json.accepted
	assert(first.userId === user.id && first.classification === 'inbox', 'generic inbound routed to the claimant', first)
	const duplicate = await postJson('/email/inbound/generic', generic)
	assert(
		duplicate.status === 200 && duplicate.json.error === 'duplicate',
		'duplicate provider message id is a no-op',
		duplicate.json,
	)
	const message = await mcp.call('emailMessageGet', { id: first.messageId })
	assert(message.subject === generic.subject && message.text === generic.text, 'stored body', message)
	assert(
		message.headers['x-kody-plus-tag'] === 'receipts' && message.headers['x-mailer'] === 'smoke',
		'plus tag + safe headers kept',
		message.headers,
	)
	assert(message.inboxAddress === `${local}+receipts@${domain}`, 'inbox address keeps the tag', message.inboxAddress)
	assert(
		message.attachments.length === 1 && message.attachments[0].filename === '.._receipt.pdf',
		'attachment filename sanitized',
		message.attachments,
	)
	assert(!('contentBase64' in message.attachments[0]), 'emailMessageGet must not inline attachment bytes')
	const fetched = await mcp.call('emailAttachmentGet', {
		messageId: first.messageId,
		attachmentId: message.attachments[0].id,
	})
	assert(sha256(Buffer.from(fetched.contentBase64, 'base64')) === sha256(attachment), 'attachment bytes round-trip')
	log('generic', {
		unauthorized: unauthorized.status,
		unknownInbox: unknownInbox.status,
		accepted: accepted.status,
		duplicate: duplicate.json.error,
		attachmentBytes: attachment.length,
	})

	// 3. raw RFC 5322 the way the mail bridge posts it (envelope headers win over To:)
	const rawId = `<raw-${randomBytes(6).toString('hex')}@sender.example>`
	const raw = [
		'From: Bob <bob@sender.example>',
		'To: undisclosed-recipients:;',
		`Subject: =?UTF-8?Q?Raw_smoke_=E2=9C=93?=`,
		`Message-ID: ${rawId}`,
		'Date: Mon, 01 Jan 2024 00:00:00 +0000',
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Plain text from the bridge.',
		'',
	].join('\r\n')
	const bridged = await post('/email/inbound/bridge', {
		headers: {
			'content-type': 'message/rfc822',
			'x-kody-envelope-from': 'bob@sender.example',
			'x-kody-envelope-to': `${local}@${domain}, other@elsewhere.example`,
		},
		body: raw,
	})
	assert(bridged.status === 200 && bridged.json.accepted.length === 1, 'bridge raw inbound accepted', bridged.json)
	assert(bridged.json.rejected[0]?.reason === 'foreign_domain', 'foreign envelope recipient reported', bridged.json)
	const rawStored = await mcp.call('emailMessageGet', { id: bridged.json.accepted[0].messageId })
	assert(
		rawStored.subject === 'Raw smoke ✓' && rawStored.messageId === rawId.slice(1, -1),
		'raw MIME decoded',
		rawStored,
	)
	const search = await mcp.call('emailMessageSearch', { query: 'bridge' })
	assert(
		search.messages.some((m) => m.id === rawStored.id),
		'search finds the raw message',
		search,
	)
	log('bridge inbound', { accepted: bridged.status, subject: rawStored.subject, searchHits: search.messages.length })

	// 4. subscription fan-out: the package filed both received messages
	const filed = await waitFor(async () => {
		const s = await mcp.callDirect('packageRun', { name: packageName })
		const rows = (s.result?.recent ?? s.recent).filter((row) => row.kind === 'email')
		const wanted = new Set([first.messageId, rawStored.id])
		return rows.filter((row) => wanted.has(row.summary.id)).length === 2 ? rows : null
	}, 'email.message.received subscription runs')
	assert(
		filed.every((row) => row.summary.topic === 'email.message.received'),
		'subscription topic',
		filed,
	)
	log('subscriptions', { filed: filed.length })

	// 5. sender rules: quarantine a domain, release with allowSender flips to inbox
	const rule = await mcp.call('emailSenderRuleSet', { kind: 'domain', value: 'spam.example', effect: 'quarantine' })
	const spam = await postJson('/email/inbound/generic', {
		from: 'deals@spam.example',
		to: [`${local}@${domain}`],
		subject: 'Great deals',
		text: 'Buy now',
		messageId: `<spam-${randomBytes(6).toString('hex')}@spam.example>`,
	})
	assert(
		spam.status === 200 && spam.json.accepted[0].classification === 'quarantine',
		'quarantine by sender rule',
		spam.json,
	)
	const quarantined = await mcp.call('emailMessageList', { classification: 'quarantine' })
	assert(
		quarantined.messages.some((m) => m.id === spam.json.accepted[0].messageId),
		'quarantine list',
		quarantined,
	)
	const released = await mcp.call('emailMessageRelease', { id: spam.json.accepted[0].messageId, allowSender: true })
	assert(released.classification === 'inbox', 'release', released)
	const rules = await mcp.call('emailSenderRuleList', {})
	assert(
		rules.rules.some((r) => r.value === 'deals@spam.example' && r.effect === 'allow'),
		'allowSender adds an allow rule',
		rules,
	)
	await mcp.call('emailSenderRuleDelete', { id: rule.id })
	log('sender rules', { quarantined: spam.json.accepted[0].classification, released: released.classification })

	// 6. outbound through the loopback bridge: send to self, unverified refused, verify a destination, reply
	const bridge = await startFakeBridge()
	try {
		if (
			status.outbound !== 'bridge' ||
			!/127\.0\.0\.1|localhost|host\.docker\.internal/.test(status.outboundBaseUrl ?? '')
		) {
			log(
				'skip',
				`outbound is ${status.outbound} (${status.outboundBaseUrl}); send/reply/events need the loopback bridge`,
			)
			return
		}
		const sent = await mcp.call('emailSend', { to: user.email, subject: 'Smoke send', text: 'hello from smoke' })
		assert(
			sent.direction === 'outbound' && sent.deliveryStatus === 'queued' && sent.providerMessageId,
			'send result',
			sent,
		)
		assert(sent.from.address === `${local}@${domain}`, 'sends from the claimed inbox', sent.from)
		const delivered = bridge.sent.find((m) => m.subject === 'Smoke send')
		assert(delivered && delivered.to[0].address === user.email, 'bridge received the message', bridge.sent)
		assert(bridge.authFailures === 0, 'bridge must have been called with the outbound token')

		const refused = await mcp.callDirectRaw('emailSend', { to: 'friend@example.com', subject: 'x', text: 'y' })
		assert(
			refused.isError && /email_destination_unverified/.test(JSON.stringify(refused.payload)),
			'unverified destination refused',
			refused.payload,
		)
		const begun = await mcp.callDirect('emailDestinationAdd', { address: 'friend@example.com' })
		assert(begun.sent === true && begun.destination.verified === false, 'destination add sends a code', begun)
		assert(!('code' in begun) && !JSON.stringify(begun).match(/\b\d{6}\b/), 'DESTINATION ADD LEAKED THE CODE', begun)
		const codeMail = bridge.sent.find((m) => m.to[0].address === 'friend@example.com')
		const code = codeMail?.text.match(/\b(\d{6})\b/)?.[1]
		assert(code, 'verification code must reach the destination', codeMail)
		const badCode = await mcp.callDirectRaw('emailDestinationVerify', { address: 'friend@example.com', code: '000000' })
		assert(badCode.isError, 'wrong code refused', badCode.payload)
		const verified = await mcp.callDirect('emailDestinationVerify', { address: 'friend@example.com', code })
		assert(verified.verified === true, 'verify', verified)
		await mcp.call('emailDestinationSetDefault', { address: 'friend@example.com' })
		const toDefault = await mcp.call('emailSend', { subject: 'Default destination', text: 'sent without to' })
		assert(toDefault.to[0].address === 'friend@example.com', 'default destination used', toDefault.to)

		const reply = await mcp.call('emailReply', { id: rawStored.id, text: 'Thanks Bob.' })
		assert(
			reply.subject === 'Re: Raw smoke ✓' && reply.to[0].address === 'bob@sender.example',
			'reply addressing',
			reply,
		)
		assert(
			reply.inReplyTo === rawStored.messageId && reply.references.includes(rawStored.messageId),
			'threading',
			reply,
		)
		const replyMail = bridge.sent.find((m) => m.subject === 'Re: Raw smoke ✓')
		assert(
			replyMail?.headers['in-reply-to'] === `<${rawStored.messageId}>`,
			'bridge got In-Reply-To',
			replyMail?.headers,
		)
		log('outbound', {
			sent: sent.deliveryStatus,
			refused: refused.payload?.error?.code ?? 'refused',
			verified: verified.verified,
			reply: reply.subject,
		})

		// 7. delivery events from the bridge update status + history
		const noAuth = await postJson(
			'/email/events/bridge',
			{ messageId: sent.providerMessageId, event: 'delivered' },
			{ token: null },
		)
		assert(noAuth.status === 401, 'events without token must be 401', noAuth.json)
		const event = await postJson('/email/events/bridge', {
			messageId: sent.providerMessageId,
			event: 'delivered',
			detail: '250 ok',
		})
		assert(event.status === 200 && event.json.matched === 1, 'delivery event applied', event.json)
		const unknown = await postJson('/email/events/bridge', {
			messageId: `unknown-${randomBytes(4).toString('hex')}`,
			event: 'bounced',
		})
		assert(
			unknown.status === 200 && unknown.json.matched === 0 && unknown.json.unmatched.length === 1,
			'unknown provider id ignored',
			unknown.json,
		)
		const afterEvent = await mcp.call('emailMessageGet', { id: sent.id })
		assert(afterEvent.deliveryStatus === 'delivered', 'delivery status updated', afterEvent.deliveryStatus)
		const history = await mcp.call('emailDeliveryEventList', { id: sent.id })
		assert(
			history.events.some((e) => e.event === 'delivered' && e.detail === '250 ok'),
			'delivery history',
			history,
		)
		const outbox = await mcp.call('emailMessageList', { direction: 'outbound' })
		assert(outbox.messages.length >= 3, 'outbound list', outbox.messages.length)
		log('events', { unauthenticated: noAuth.status, matched: event.json.matched, status: afterEvent.deliveryStatus })

		const everything = JSON.stringify([
			status,
			claimed,
			message,
			rawStored,
			sent,
			reply,
			history,
			outbox,
			quarantined,
			rules,
		])
		assert(!everything.includes(inboundToken) && !everything.includes(bridgeToken), 'A RESPONSE LEAKED A TOKEN')
		await mcp.callDirect('emailDestinationRemove', { address: 'friend@example.com' })
	} finally {
		await bridge.close()
	}

	// 8. delete + release
	const deleted = await mcp.call('emailMessageDelete', { id: first.messageId })
	assert(deleted.deleted === true, 'delete', deleted)
	const gone = await mcp.callDirectRaw('emailMessageGet', { id: first.messageId })
	assert(gone.isError, 'deleted message is gone')
	const attachmentGone = await mcp.callDirectRaw('emailAttachmentGet', {
		messageId: first.messageId,
		attachmentId: message.attachments[0].id,
	})
	assert(attachmentGone.isError, 'attachments deleted with the message')
	const releasedInbox = await mcp.callDirect('emailInboxRelease', { local })
	assert(releasedInbox.deleted === true, 'inbox release', releasedInbox)
	const afterRelease = await postJson('/email/inbound/generic', {
		...generic,
		messageId: `<late-${randomBytes(4).toString('hex')}@x>`,
	})
	assert(afterRelease.status === 404, 'released inbox rejects new mail', afterRelease.json)
	log('cleanup', { deleted: deleted.deleted, inboxReleased: releasedInbox.deleted, afterRelease: afterRelease.status })
}

// Minimal stand-in for mail-bridge/server.mjs's HTTP side: bearer-checked /send
// that records the message and answers 202 { messageId }.
async function startFakeBridge() {
	const host = process.env.SMOKE_ECHO_HOST ?? '127.0.0.1'
	const bind = process.env.SMOKE_ECHO_BIND ?? (host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')
	const port = Number(process.env.SMOKE_BRIDGE_PORT ?? 9796)
	const state = { sent: [], authFailures: 0 }
	const server = createServer(async (req, res) => {
		let body = ''
		for await (const chunk of req) body += chunk
		if (req.headers.authorization !== `Bearer ${bridgeToken}`) {
			state.authFailures++
			res.writeHead(401, { 'content-type': 'application/json' })
			return res.end(JSON.stringify({ error: 'unauthorized' }))
		}
		if (req.method !== 'POST' || req.url !== '/send') {
			res.writeHead(404)
			return res.end()
		}
		const message = JSON.parse(body)
		state.sent.push(message)
		res.writeHead(202, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ messageId: `<bridge-${randomBytes(6).toString('hex')}@smoke>` }))
	})
	await new Promise((resolve) => server.listen(port, bind, resolve))
	return {
		sent: state.sent,
		get authFailures() {
			return state.authFailures
		},
		close: () => new Promise((resolve) => server.close(resolve)),
	}
}
