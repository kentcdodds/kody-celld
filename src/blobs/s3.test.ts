import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { S3Config } from './config.ts'
import { parseListObjects, s3ObjectUrl, signS3Request } from './s3.ts'

// The well-known SigV4 example from the AWS S3 docs ("GET Object" test case).
// These credentials are AWS's published documentation placeholders, not real keys.
const awsExample: S3Config = {
	endpoint: 'https://s3.amazonaws.com',
	bucket: 'examplebucket',
	region: 'us-east-1',
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
	prefix: '',
	forcePathStyle: false,
}

describe('s3 signing', () => {
	it('builds path-style and virtual-hosted URLs with canonical queries', () => {
		assert.equal(
			s3ObjectUrl({ ...awsExample, forcePathStyle: true, endpoint: 'http://minio:9000' }, 'users/u1/a b.txt').url,
			'http://minio:9000/examplebucket/users/u1/a%20b.txt',
		)
		const listed = s3ObjectUrl(awsExample, '', { 'list-type': '2', prefix: 'users/u1/' })
		assert.equal(listed.url, 'https://examplebucket.s3.amazonaws.com/?list-type=2&prefix=users%2Fu1%2F')
		assert.equal(listed.canonicalQuery, 'list-type=2&prefix=users%2Fu1%2F')
	})

	it('reproduces the AWS documentation signature for GET Object', async () => {
		const request = await signS3Request(
			awsExample,
			{ method: 'GET', key: 'test.txt', headers: { Range: 'bytes=0-9' } },
			new Date('2013-05-24T00:00:00Z'),
		)
		assert.equal(request.url, 'https://examplebucket.s3.amazonaws.com/test.txt')
		assert.equal(
			request.headers.get('authorization'),
			'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
		)
		assert.equal(request.headers.get('x-amz-date'), '20130524T000000Z')
	})

	it('parses ListObjectsV2 responses including continuation tokens and entities', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok&amp;en</NextContinuationToken>
  <Contents><Key>users/u1/a&amp;b.txt</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>12</Size></Contents>
  <Contents><Key>users/u1/c.txt</Key><LastModified>2026-01-02T00:00:00.000Z</LastModified><ETag>"def"</ETag><Size>3</Size></Contents>
</ListBucketResult>`
		assert.deepEqual(parseListObjects(xml), {
			objects: [
				{ key: 'users/u1/a&b.txt', size: 12, etag: 'abc', lastModified: '2026-01-01T00:00:00.000Z' },
				{ key: 'users/u1/c.txt', size: 3, etag: 'def', lastModified: '2026-01-02T00:00:00.000Z' },
			],
			truncated: true,
			continuationToken: 'tok&en',
		})
		assert.deepEqual(parseListObjects('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'), {
			objects: [],
			truncated: false,
			continuationToken: null,
		})
	})
})
