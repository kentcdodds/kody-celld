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
	return { provider, baseUrl, token: 'token-value', timeoutMs: 5000 }
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
})

describe('parseSendResponse', () => {
	it('extracts bridge message ids', () => {
		assert.equal(parseSendResponse('bridge', 202, new Headers(), '{"messageId":"b_1"}').status, 'queued')
		assert.equal(parseSendResponse('bridge', 200, new Headers(), '{"messageId":"b_2"}').providerMessageId, 'b_2')
	})
})

describe('normalizeDeliveryEvents', () => {
	it('maps bridge events to a common shape', () => {
		assert.equal(statusFor('email.delivered'), 'delivered')
		assert.equal(statusFor('SpamComplaint'), 'complained')
		assert.equal(normalizeDeliveryEvents('bridge', { messageId: 'b_1', event: 'delivered' })[0]?.status, 'delivered')
	})
})

describe('emailConfigFromEnv', () => {
	it('returns null without a domain and validates provider settings', () => {
		assert.equal(emailConfigFromEnv({}), null)
		assert.throws(() => emailConfigFromEnv({ KODY_EMAIL_DOMAIN: 'not a domain' }), /bare domain/)
		assert.throws(
			() => emailConfigFromEnv({ KODY_EMAIL_DOMAIN: 'kody.example', KODY_EMAIL_OUTBOUND_PROVIDER: 'resend' }),
			/was removed/,
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
			KODY_EMAIL_OUTBOUND_PROVIDER: 'bridge',
			KODY_EMAIL_OUTBOUND_TOKEN: 'out',
			KODY_EMAIL_OUTBOUND_URL: 'http://mail-bridge:8025',
		})
		assert.equal(parsed?.domain, 'kody.example')
		assert.equal(parsed?.outbound?.baseUrl, 'http://mail-bridge:8025')
		assert.equal(parsed?.outbound?.provider, 'bridge')
	})

	it('refuses removed Mailgun settings and vendor outbound providers', () => {
		assert.throws(
			() =>
				emailConfigFromEnv({
					KODY_EMAIL_DOMAIN: 'mail.example.com',
					KODY_EMAIL_MAILGUN_SIGNING_KEY: 'k',
				}),
			/MAILGUN/,
		)
		assert.throws(
			() =>
				emailConfigFromEnv({
					KODY_EMAIL_DOMAIN: 'mail.example.com',
					KODY_EMAIL_OUTBOUND_PROVIDER: 'postmark',
					KODY_EMAIL_OUTBOUND_TOKEN: 't',
				}),
			/was removed/,
		)
	})

	it('leaves inboundToken null when the operator sets a domain without a token', () => {
		const parsed = emailConfigFromEnv({ KODY_EMAIL_DOMAIN: 'mail.example.com' })
		assert.equal(parsed?.domain, 'mail.example.com')
		assert.equal(parsed?.inboundToken, null)
	})
})
