import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertInboundProviderAllowed } from './config.ts'
import { normalizeGeneric, normalizeInbound, readInboundPayload, type InboundPayload } from './inbound.ts'

const headers = new Headers()

function jsonPayload(body: unknown): InboundPayload {
	return { kind: 'json', body, headers }
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

	it('rejects JSON for bridge', async () => {
		await assert.rejects(normalizeInbound('bridge', jsonPayload({})), /message\/rfc822/)
	})
})

describe('assertInboundProviderAllowed', () => {
	it('accepts generic and bridge, refuses removed vendors', () => {
		assert.equal(assertInboundProviderAllowed('generic'), 'generic')
		assert.equal(assertInboundProviderAllowed('bridge'), 'bridge')
		assert.throws(() => assertInboundProviderAllowed('postmark'), /was removed/)
		assert.throws(() => assertInboundProviderAllowed('cloudflare'), /was removed/)
		assert.throws(() => assertInboundProviderAllowed('nope'), /Unknown inbound/)
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
