import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blobConfigFromEnv, describeBlobConfig } from './config.ts'
import { decodeContent, encodeBase64, normalizeMetadata } from './service.ts'

describe('blob config', () => {
	it('defaults to the R2 binding and validates s3 settings', () => {
		const r2 = blobConfigFromEnv({})
		assert.equal(r2.provider, 'r2')
		assert.equal(r2.s3, null)
		assert.equal(r2.maxBytes, 25 * 1024 * 1024)
		assert.throws(() => blobConfigFromEnv({ KODY_BLOB_PROVIDER: 'gcs' }), /expected r2 or s3/)
		assert.throws(() => blobConfigFromEnv({ KODY_BLOB_PROVIDER: 's3' }), /KODY_BLOB_S3_ENDPOINT is required/)
		assert.throws(() => blobConfigFromEnv({ KODY_BLOB_MAX_BYTES: '1' }), /between 1024 and/)
		assert.throws(() => blobConfigFromEnv({ KODY_BLOB_URL_TTL_SECONDS: 'x' }), /expected an integer/)
	})

	it('describes the s3 provider without credentials', () => {
		const config = blobConfigFromEnv({
			KODY_BLOB_PROVIDER: 's3',
			KODY_BLOB_S3_ENDPOINT: 'http://minio:9000/',
			KODY_BLOB_S3_BUCKET: 'kody-blobs',
			KODY_BLOB_S3_ACCESS_KEY_ID: 'unit-test-access-key',
			KODY_BLOB_S3_SECRET_ACCESS_KEY: 'unit-test-secret-not-real',
			KODY_BLOB_S3_PREFIX: '/tenant-a/',
		})
		assert.equal(config.s3?.endpoint, 'http://minio:9000')
		assert.equal(config.s3?.prefix, 'tenant-a/')
		assert.equal(config.s3?.forcePathStyle, true)
		const described = JSON.stringify(describeBlobConfig(config))
		assert.doesNotMatch(described, /unit-test-secret-not-real|unit-test-access-key/)
		assert.match(described, /"hasCredentials":true/)
	})
})

describe('blob metadata and content', () => {
	it('validates metadata shape and size', () => {
		assert.deepEqual(normalizeMetadata(undefined), {})
		assert.deepEqual(normalizeMetadata({ source: 'smoke', 'x-run': '1' }), { source: 'smoke', 'x-run': '1' })
		assert.throws(() => normalizeMetadata([]), /must be an object/)
		assert.throws(() => normalizeMetadata({ 'bad key': 'v' }), /must match/)
		assert.throws(() => normalizeMetadata({ n: 1 }), /must be a string/)
		assert.throws(() => normalizeMetadata({ v: 'x'.repeat(1025) }), /at most 1024/)
		assert.throws(
			() => normalizeMetadata(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']))),
			/at most 20 entries/,
		)
	})

	it('round-trips utf8 and base64 content', () => {
		assert.deepEqual([...decodeContent('hé', undefined)], [0x68, 0xc3, 0xa9])
		assert.deepEqual([...decodeContent('aGk=', 'base64')], [0x68, 0x69])
		assert.deepEqual([...decodeContent('aG k=\n', 'base64')], [0x68, 0x69])
		assert.throws(() => decodeContent('***', 'base64'), /not valid base64/)
		assert.throws(() => decodeContent('x', 'hex'), /encoding must be/)
		const bytes = new Uint8Array(70_000).map((_, i) => i % 251)
		assert.deepEqual(decodeContent(encodeBase64(bytes), 'base64'), bytes)
	})
})
