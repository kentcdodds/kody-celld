import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emailConfigFromEnv, type OutboundConfig } from './config.ts'
import { normalizeDeliveryEvents, statusFor } from './events.ts'
import { buildOutboundRequest, parseSendResponse, type OutboundMessage } from './outbound.ts'

const message: OutboundMessage = {
	from: { address: 'kent@kody.example', name: 'Kody' },
	to: [{ address: 'friend@example.com', name: 'Friend' }],
	cc: [],
	replyTo: [],
	subject: 'Hello',
	text: 'plain',
	html: '<p>plain</p>',
	headers: { 'x-kody-tag': 'smoke', 'x-forbidden': 'nope' },
	inReplyTo: 'orig@example.com',
	references: ['orig@example.com'],
	attachments: [
		{
			id: 'att_1',
			filename: 'a.txt',
			contentType: 'text/plain',
			size: 1,
			contentId: null,
			disposition: 'attachment',
			contentBase64: btoa('x'),
		},
	],
}

function config(provider: OutboundConfig['provider'], baseUrl = 'https://mail.example'): OutboundConfig {
	return { provider, baseUrl, token: 'token-value', mailgunDomain: 'kody.example', timeoutMs: 5000 }
}

describe('buildOutboundRequest', () => {
	it('bridge posts JSON with only allowlisted headers', () => {
		const request = buildOutboundRequest(config('bridge'), message)
		assert.equal(request.url, 'https://mail.example/send')
		const body = JSON.parse(request.body as string) as { headers: Record<string, string>; from: unknown }
		assert.deepEqual(body.headers, {
			'x-kody-tag': 'smoke',
			'in-reply-to': '<orig@example.com>',
			references: '<orig@example.com>',
		})
		assert.deepEqual(body.from, message.from)
	})

	it('resend / postmark / sendgrid shapes', () => {
		const resend = JSON.parse(buildOutboundRequest(config('resend'), message).body as string) as Record<string, unknown>
		assert.equal(resend.from, '"Kody" <kent@kody.example>')
		assert.deepEqual(resend.to, ['"Friend" <friend@example.com>'])
		const postmark = buildOutboundRequest(config('postmark'), message)
		assert.equal(postmark.headers['x-postmark-server-token'], 'token-value')
		const pmBody = JSON.parse(postmark.body as string) as { Attachments: Array<{ Name: string }>; To: string }
		assert.equal(pmBody.To, '"Friend" <friend@example.com>')
		assert.equal(pmBody.Attachments[0]?.Name, 'a.txt')
		const sendgrid = JSON.parse(buildOutboundRequest(config('sendgrid'), message).body as string) as {
			personalizations: Array<{ to: Array<{ email: string }> }>
			content: Array<{ type: string }>
		}
		assert.equal(sendgrid.personalizations[0]?.to[0]?.email, 'friend@example.com')
		assert.deepEqual(
			sendgrid.content.map((c) => c.type),
			['text/plain', 'text/html'],
		)
	})

	it('mailgun uses basic auth and multipart', () => {
		const request = buildOutboundRequest(config('mailgun'), message)
		assert.equal(request.url, 'https://mail.example/v3/kody.example/messages')
		assert.equal(request.headers.authorization, `Basic ${btoa('api:token-value')}`)
		assert.ok(request.body instanceof FormData)
		assert.equal((request.body as FormData).get('from'), '"Kody" <kent@kody.example>')
		assert.equal((request.body as FormData).get('h:X-Forbidden'), null)
	})
})

describe('parseSendResponse', () => {
	it('extracts provider ids', () => {
		assert.equal(parseSendResponse('resend', 200, new Headers(), '{"id":"re_1"}').providerMessageId, 're_1')
		assert.equal(parseSendResponse('postmark', 200, new Headers(), '{"MessageID":"pm_1"}').providerMessageId, 'pm_1')
		assert.equal(parseSendResponse('mailgun', 200, new Headers(), '{"id":"<mg_1@x>"}').providerMessageId, 'mg_1@x')
		assert.equal(
			parseSendResponse('sendgrid', 202, new Headers({ 'x-message-id': 'sg_1' }), '').providerMessageId,
			'sg_1',
		)
		assert.equal(parseSendResponse('bridge', 202, new Headers(), '{"messageId":"b_1"}').status, 'queued')
	})
})

describe('normalizeDeliveryEvents', () => {
	it('maps each provider to a common shape', () => {
		assert.equal(statusFor('email.delivered'), 'delivered')
		assert.equal(statusFor('SpamComplaint'), 'complained')
		assert.deepEqual(
			normalizeDeliveryEvents('resend', {
				type: 'email.bounced',
				created_at: '2026-01-01T00:00:00Z',
				data: { email_id: 're_1', bounce: { message: 'mailbox full' } },
			})[0],
			{
				providerMessageId: 're_1',
				event: 'bounced',
				status: 'bounced',
				detail: 'mailbox full',
				at: '2026-01-01T00:00:00.000Z',
			},
		)
		assert.equal(
			normalizeDeliveryEvents('postmark', { RecordType: 'Delivery', MessageID: 'pm_1' })[0]?.status,
			'delivered',
		)
		assert.equal(
			normalizeDeliveryEvents('mailgun', {
				'event-data': {
					event: 'failed',
					message: { headers: { 'message-id': 'mg_1@x' } },
					'delivery-status': { description: 'no' },
				},
			})[0]?.detail,
			'no',
		)
		const sg = normalizeDeliveryEvents('sendgrid', [
			{ sg_message_id: 'sg_1.filter001', event: 'delivered', timestamp: 1700000000 },
			{ sg_message_id: 'sg_2.filter001', event: 'bounce', reason: 'bad' },
		])
		assert.deepEqual(
			sg.map((e) => [e.providerMessageId, e.status]),
			[
				['sg_1', 'delivered'],
				['sg_2', 'bounced'],
			],
		)
		assert.equal(normalizeDeliveryEvents('bridge', { messageId: 'b_1', event: 'delivered' })[0]?.status, 'delivered')
	})
})

describe('emailConfigFromEnv', () => {
	it('returns null without a domain and validates provider settings', () => {
		assert.equal(emailConfigFromEnv({}), null)
		assert.throws(() => emailConfigFromEnv({ KODY_EMAIL_DOMAIN: 'not a domain' }), /bare domain/)
		assert.throws(
			() => emailConfigFromEnv({ KODY_EMAIL_DOMAIN: 'kody.example', KODY_EMAIL_OUTBOUND_PROVIDER: 'resend' }),
			/OUTBOUND_TOKEN/,
		)
		assert.throws(
			() =>
				emailConfigFromEnv({
					KODY_EMAIL_DOMAIN: 'kody.example',
					KODY_EMAIL_OUTBOUND_PROVIDER: 'bridge',
					KODY_EMAIL_OUTBOUND_TOKEN: 't',
				}),
			/OUTBOUND_URL/,
		)
		const parsed = emailConfigFromEnv({
			KODY_EMAIL_DOMAIN: 'Kody.Example',
			KODY_EMAIL_INBOUND_TOKEN: 'in',
			KODY_EMAIL_OUTBOUND_PROVIDER: 'mailgun',
			KODY_EMAIL_OUTBOUND_TOKEN: 'out',
		})
		assert.equal(parsed?.domain, 'kody.example')
		assert.equal(parsed?.outbound?.baseUrl, 'https://api.mailgun.net')
		assert.equal(parsed?.outbound?.mailgunDomain, 'kody.example')
	})
})
