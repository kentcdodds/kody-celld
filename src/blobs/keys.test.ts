import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	isTextContentType,
	normalizeBlobKey,
	normalizeBlobPrefix,
	objectKeyFor,
	resolveContentType,
	signBlobUrl,
	verifyBlobUrlSignature,
} from './keys.ts'

describe('blob keys', () => {
	it('accepts S3-safe keys and rejects traversal and odd characters', () => {
		assert.equal(normalizeBlobKey('reports/2026-01/summary.txt'), 'reports/2026-01/summary.txt')
		assert.equal(normalizeBlobKey("  it's (v2)+final.md "), "it's (v2)+final.md")
		for (const bad of ['', '/abs', 'trailing/', 'a//b', 'a/../b', './a', 'a\\b', 'ünïcode', 'a\nb', 'x'.repeat(513)]) {
			assert.throws(() => normalizeBlobKey(bad), /invalid_blob_key/, bad)
		}
		assert.throws(() => normalizeBlobKey(42), /must be a string/)
	})

	it('normalizes prefixes and scopes object keys per user', () => {
		assert.equal(normalizeBlobPrefix(undefined), '')
		assert.equal(normalizeBlobPrefix('reports/'), 'reports/')
		assert.equal(normalizeBlobPrefix('reports///'), 'reports/')
		assert.equal(normalizeBlobPrefix('rep'), 'rep')
		assert.throws(() => normalizeBlobPrefix('../x'), /invalid_blob_key/)
		assert.equal(objectKeyFor('user_1', 'a/b.txt'), 'users/user_1/a/b.txt')
	})

	it('resolves content types from explicit values or extensions', () => {
		assert.equal(resolveContentType('x.png', undefined), 'image/png')
		assert.equal(resolveContentType('x.unknownext', undefined), 'application/octet-stream')
		assert.equal(resolveContentType('x.bin', 'text/plain; charset=utf-8'), 'text/plain; charset=utf-8')
		assert.throws(() => resolveContentType('x', 'not a type'), /not a valid content type/)
		assert.equal(isTextContentType('application/json'), true)
		assert.equal(isTextContentType('application/ld+json'), true)
		assert.equal(isTextContentType('image/png'), false)
	})

	it('signs and verifies time-limited download links without leaking anything but an HMAC', async () => {
		const masterKey = 'unit-test-master-key-not-a-real-secret'
		const expiresAt = Math.floor(Date.now() / 1000) + 60
		const url = await signBlobUrl(masterKey, {
			baseUrl: 'https://kody.example.com/',
			userId: 'user_1',
			key: 'reports/a b.txt',
			expiresAt,
		})
		const parsed = new URL(url)
		assert.equal(parsed.pathname, '/blobs/user_1/reports/a%20b.txt')
		assert.equal(parsed.searchParams.get('exp'), String(expiresAt))
		const signatureHex = parsed.searchParams.get('sig') ?? ''
		assert.match(signatureHex, /^[0-9a-f]{64}$/)
		assert.doesNotMatch(url, /unit-test-master-key/)
		const verify = (
			input: Partial<{ userId: string; key: string; expiresAt: number; signatureHex: string }>,
			now?: number,
		) =>
			verifyBlobUrlSignature(
				masterKey,
				{ userId: 'user_1', key: 'reports/a b.txt', expiresAt, signatureHex, ...input },
				now,
			)
		assert.equal(await verify({}), true)
		assert.equal(await verify({ userId: 'user_2' }), false)
		assert.equal(await verify({ key: 'reports/other.txt' }), false)
		assert.equal(await verify({ expiresAt: expiresAt + 1 }), false)
		assert.equal(await verify({}, (expiresAt + 1) * 1000), false)
		assert.equal(await verify({ signatureHex: 'zz' }), false)
		assert.equal(
			await verifyBlobUrlSignature('other-master-key', {
				userId: 'user_1',
				key: 'reports/a b.txt',
				expiresAt,
				signatureHex,
			}),
			false,
		)
	})
})
