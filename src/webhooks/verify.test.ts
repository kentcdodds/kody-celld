import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WebhookVerification } from '../packages/manifest.ts'
import {
	constantTimeEqual,
	parseSignatureHeader,
	parseTimestamp,
	signatureMatches,
	signedMessage,
	withinTolerance,
} from './verify.ts'

const hexBody: WebhookVerification = {
	type: 'hmac-sha256',
	header: 'x-hub-signature-256',
	secretName: 's',
	encoding: 'hex',
	prefix: 'sha256=',
	signedPayload: 'body',
}
const stripe: WebhookVerification = {
	type: 'hmac-sha256',
	header: 'stripe-signature',
	secretName: 's',
	encoding: 'hex',
	signedPayload: 'timestamp.body',
}

describe('parseSignatureHeader', () => {
	it('strips a declared prefix', () => {
		assert.deepEqual(parseSignatureHeader('sha256=abc', hexBody), ['abc'])
		assert.deepEqual(parseSignatureHeader('abc', hexBody), ['abc'])
	})
	it('reads stripe-style k=v lists and skips the timestamp token', () => {
		assert.deepEqual(parseSignatureHeader('t=1700000000,v1=aaa,v1=bbb', stripe), ['aaa', 'bbb'])
	})
	it('returns nothing for a missing header', () => {
		assert.deepEqual(parseSignatureHeader(null, hexBody), [])
		assert.deepEqual(parseSignatureHeader('  ', hexBody), [])
	})
})

describe('signatureMatches', () => {
	const digest = { hex: 'ABcd', base64: 'q83v' }
	it('compares hex case-insensitively and base64 exactly', () => {
		assert.equal(signatureMatches(['abCD'], digest, 'hex'), true)
		assert.equal(signatureMatches(['q83v'], digest, 'base64'), true)
		assert.equal(signatureMatches(['Q83V'], digest, 'base64'), false)
		assert.equal(signatureMatches(['nope', 'abcd'], digest, 'hex'), true)
		assert.equal(signatureMatches([], digest, 'hex'), false)
	})
	it('constantTimeEqual rejects length and content differences', () => {
		assert.equal(constantTimeEqual('abc', 'abc'), true)
		assert.equal(constantTimeEqual('abc', 'abd'), false)
		assert.equal(constantTimeEqual('abc', 'abcd'), false)
	})
})

describe('parseTimestamp / withinTolerance', () => {
	it('parses unix seconds, millis, iso, and stripe headers', () => {
		assert.equal(parseTimestamp('1700000000', 'unix-seconds')?.getTime(), 1_700_000_000_000)
		assert.equal(parseTimestamp('1700000000123', 'unix-millis')?.getTime(), 1_700_000_000_123)
		assert.equal(parseTimestamp('2023-11-14T22:13:20Z', 'iso')?.getTime(), 1_700_000_000_000)
		assert.equal(parseTimestamp('t=1700000000,v1=x', 'stripe-signature')?.getTime(), 1_700_000_000_000)
	})
	it('returns null for garbage', () => {
		assert.equal(parseTimestamp(null, 'unix-seconds'), null)
		assert.equal(parseTimestamp('abc', 'unix-seconds'), null)
		assert.equal(parseTimestamp('not a date', 'iso'), null)
		assert.equal(parseTimestamp('v1=x', 'stripe-signature'), null)
	})
	it('applies the tolerance window symmetrically', () => {
		const now = new Date(1_700_000_000_000)
		assert.equal(withinTolerance(new Date(1_700_000_000_000 - 299_000), now, 300), true)
		assert.equal(withinTolerance(new Date(1_700_000_000_000 + 301_000), now, 300), false)
	})
})

describe('signedMessage', () => {
	it('signs the raw body or timestamp.body', () => {
		assert.equal(signedMessage(hexBody, '{"a":1}', null, undefined), '{"a":1}')
		assert.equal(signedMessage(stripe, '{"a":1}', 't=1700000000,v1=x', 'stripe-signature'), '1700000000.{"a":1}')
		assert.equal(
			signedMessage({ ...stripe, header: 'x-ts' }, 'body', ' 1700000000 ', 'unix-seconds'),
			'1700000000.body',
		)
		assert.equal(signedMessage(stripe, 'body', null, 'stripe-signature'), null)
	})
})
