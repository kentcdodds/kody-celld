import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	normalizeGeneric,
	normalizeInbound,
	normalizeMailgun,
	normalizePostmark,
	normalizeSendgrid,
	parseHeaderBlock,
	readInboundPayload,
	verifyMailgunSignature,
	type FormFile,
	type InboundPayload,
} from './inbound.ts'

const headers = new Headers()

function jsonPayload(body: unknown): InboundPayload {
	return { kind: 'json', body, headers }
}

function formPayload(fields: Record<string, string>, files: Array<FormFile> = []) {
	return { kind: 'form' as const, fields: new Map(Object.entries(fields)), files, headers }
}

const rawMessage = [
	'From: Ada <ada@example.com>',
	'To: kent@kody.example',
	'Subject: raw hello',
	'Message-ID: <raw-1@example.com>',
	'Content-Type: text/plain',
	'',
	'body text',
].join('\r\n')

describe('normalizeGeneric', () => {
	it('accepts structured JSON', async () => {
		const inbound = await normalizeGeneric(
			jsonPayload({
				from: 'Ada <ada@example.com>',
				to: ['kent@kody.example', 'Bob <bob@kody.example>'],
				subject: 'hi',
				text: 'hello',
				messageId: '<gen-1@example.com>',
				headers: { 'List-Id': 'news', Authorization: 'nope' },
				attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: btoa('x') }],
			}),
		)
		assert.equal(inbound.provider, 'generic')
		assert.deepEqual(inbound.recipients, ['kent@kody.example', 'bob@kody.example'])
		assert.equal(inbound.providerMessageId, 'gen-1@example.com')
		assert.equal(inbound.message.headers['list-id'], 'news')
		assert.equal(inbound.message.headers.authorization, undefined)
		assert.equal(inbound.message.attachments[0]?.size, 1)
	})

	it('accepts { raw, envelope }', async () => {
		const inbound = await normalizeGeneric(
			jsonPayload({ raw: rawMessage, envelope: { from: 'bounce@example.com', to: ['kent+tag@kody.example'] } }),
		)
		assert.equal(inbound.envelopeFrom, 'bounce@example.com')
		assert.deepEqual(inbound.recipients, ['kent+tag@kody.example'])
		assert.equal(inbound.message.subject, 'raw hello')
	})

	it('rejects a payload without from', async () => {
		await assert.rejects(normalizeGeneric(jsonPayload({ to: 'a@b.co', subject: 'x' })), /"from" is required/)
	})
})

describe('normalizePostmark', () => {
	it('maps FromFull/ToFull/Attachments and OriginalRecipient', async () => {
		const inbound = await normalizePostmark(
			jsonPayload({
				FromFull: { Email: 'Ada@Example.com', Name: 'Ada' },
				ToFull: [{ Email: 'kent@kody.example', Name: '' }],
				Subject: 'pm',
				TextBody: 'text',
				HtmlBody: '<p>html</p>',
				MessageID: 'pm-123',
				OriginalRecipient: 'kent+pm@kody.example',
				Headers: [
					{ Name: 'Message-ID', Value: '<pm-mid@example.com>' },
					{ Name: 'X-Spam-Status', Value: 'No' },
				],
				Attachments: [{ Name: 'r.pdf', ContentType: 'application/pdf', Content: btoa('%PDF'), ContentID: '' }],
			}),
		)
		assert.equal(inbound.provider, 'postmark')
		assert.deepEqual(inbound.message.from, { address: 'ada@example.com', name: 'Ada' })
		assert.deepEqual(inbound.recipients, ['kent+pm@kody.example'])
		assert.equal(inbound.providerMessageId, 'pm-123')
		assert.equal(inbound.message.messageId, 'pm-123')
		assert.equal(inbound.message.headers['x-spam-status'], 'No')
		assert.equal(inbound.message.attachments[0]?.filename, 'r.pdf')
		assert.equal(inbound.message.attachments[0]?.disposition, 'attachment')
	})
})

describe('normalizeMailgun', () => {
	it('maps parsed fields', async () => {
		const inbound = await normalizeMailgun(
			formPayload({
				recipient: 'kent@kody.example',
				sender: 'ada@example.com',
				from: 'Ada <ada@example.com>',
				subject: 'mg',
				'body-plain': 'plain',
				'Message-Id': '<mg-1@example.com>',
				'message-headers': JSON.stringify([['List-Unsubscribe', '<mailto:u@example.com>']]),
			}),
		)
		assert.equal(inbound.provider, 'mailgun')
		assert.deepEqual(inbound.recipients, ['kent@kody.example'])
		assert.equal(inbound.envelopeFrom, 'ada@example.com')
		assert.equal(inbound.message.messageId, 'mg-1@example.com')
		assert.equal(inbound.message.headers['list-unsubscribe'], '<mailto:u@example.com>')
	})

	it('prefers body-mime when present', async () => {
		const inbound = await normalizeMailgun(formPayload({ recipient: 'kent@kody.example', 'body-mime': rawMessage }))
		assert.equal(inbound.message.text?.trim(), 'body text')
	})

	it('verifies timestamp+token signatures', async () => {
		const key = 'test-signing-key'
		const timestamp = String(Math.floor(Date.now() / 1000))
		const token = 'abc123'
		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(key),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		)
		const digest = new Uint8Array(
			await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(`${timestamp}${token}`)),
		)
		const signature = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
		const fields = new Map([
			['timestamp', timestamp],
			['token', token],
			['signature', signature],
		])
		assert.equal(await verifyMailgunSignature(fields, key), true)
		assert.equal(await verifyMailgunSignature(fields, 'wrong'), false)
		assert.equal(await verifyMailgunSignature(fields, key, Date.now() + 10 * 60 * 1000), false)
	})
})

describe('normalizeSendgrid', () => {
	it('maps parsed fields with envelope and header block', async () => {
		const inbound = await normalizeSendgrid(
			formPayload(
				{
					envelope: JSON.stringify({ from: 'ada@example.com', to: ['kent@kody.example'] }),
					from: 'Ada <ada@example.com>',
					subject: 'sg',
					text: 'plain',
					headers: 'Message-ID: <sg-1@example.com>\r\nIn-Reply-To: <sg-0@example.com>\r\nX-Other: 1\r\n',
					'attachment-info': JSON.stringify({ attachment1: { 'content-id': '<img1>' } }),
				},
				[{ field: 'attachment1', filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
			),
		)
		assert.equal(inbound.provider, 'sendgrid')
		assert.deepEqual(inbound.recipients, ['kent@kody.example'])
		assert.equal(inbound.message.messageId, 'sg-1@example.com')
		assert.equal(inbound.message.inReplyTo, 'sg-0@example.com')
		assert.equal(inbound.message.attachments[0]?.contentId, 'img1')
		assert.equal(inbound.message.attachments[0]?.disposition, 'inline')
		assert.equal(inbound.message.attachments[0]?.size, 3)
	})

	it('parses the raw email field', async () => {
		const inbound = await normalizeSendgrid(formPayload({ email: rawMessage }))
		assert.equal(inbound.message.subject, 'raw hello')
		assert.deepEqual(inbound.recipients, ['kent@kody.example'])
	})
})

describe('raw providers', () => {
	it('uses x-kody-envelope headers', async () => {
		const payload: InboundPayload = {
			kind: 'raw',
			bytes: new TextEncoder().encode(rawMessage),
			headers: new Headers({
				'x-kody-envelope-from': 'bounce@example.com',
				'x-kody-envelope-to': 'a@kody.example, b@kody.example',
			}),
		}
		const inbound = await normalizeInbound('bridge', payload)
		assert.equal(inbound.provider, 'bridge')
		assert.equal(inbound.envelopeFrom, 'bounce@example.com')
		assert.deepEqual(inbound.recipients, ['a@kody.example', 'b@kody.example'])
	})

	it('rejects JSON for cloudflare', async () => {
		await assert.rejects(normalizeInbound('cloudflare', jsonPayload({})), /message\/rfc822/)
	})
})

describe('parseHeaderBlock', () => {
	it('unfolds continuation lines', () => {
		assert.deepEqual(parseHeaderBlock('Subject: a\r\n b\r\nX: y'), [
			['Subject', 'a b'],
			['X', 'y'],
		])
	})
})

describe('readInboundPayload', () => {
	it('decodes json, form, and raw by content-type and enforces size', async () => {
		const json = await readInboundPayload(
			new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }),
			1000,
		)
		assert.equal(json.kind, 'json')
		const form = new FormData()
		form.set('subject', 'x')
		const parsed = await readInboundPayload(new Request('http://x/', { method: 'POST', body: form }), 1000)
		assert.equal(parsed.kind, 'form')
		const raw = await readInboundPayload(
			new Request('http://x/', { method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: 'abc' }),
			1000,
		)
		assert.equal(raw.kind, 'raw')
		await assert.rejects(
			readInboundPayload(
				new Request('http://x/', { method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: 'abcdef' }),
				3,
			),
			/exceeds/,
		)
	})
})
