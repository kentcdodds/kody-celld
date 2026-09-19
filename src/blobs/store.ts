import { KodyError } from '../lib/errors.ts'
import type { BlobConfig, S3Config } from './config.ts'
import { parseListObjects, signS3Request } from './s3.ts'

export type StoredObjectMeta = {
	key: string
	size: number
	etag: string
	contentType: string
	uploaded: string
	customMetadata: Record<string, string>
}

export type StoredObject = StoredObjectMeta & { body: Uint8Array }

export type StoreListPage = {
	objects: Array<Pick<StoredObjectMeta, 'key' | 'size' | 'etag' | 'uploaded'>>
	cursor: string | null
}

/**
 * The object-store seam: everything above it (capabilities, signed URLs, the
 * per-user index) works against these five calls, so swapping R2 for a direct
 * S3 endpoint is configuration, not code.
 */
export interface BlobStore {
	readonly kind: 'r2' | 's3'
	put(
		key: string,
		body: Uint8Array,
		options: { contentType: string; customMetadata?: Record<string, string> },
	): Promise<StoredObjectMeta>
	get(key: string): Promise<StoredObject | null>
	head(key: string): Promise<StoredObjectMeta | null>
	delete(keys: Array<string>): Promise<void>
	list(options: { prefix: string; cursor?: string | null; limit: number }): Promise<StoreListPage>
}

function metaFromR2(object: R2Object): StoredObjectMeta {
	return {
		key: object.key,
		size: object.size,
		etag: object.etag,
		contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
		uploaded: object.uploaded.toISOString(),
		customMetadata: object.customMetadata ?? {},
	}
}

export class R2BlobStore implements BlobStore {
	readonly kind = 'r2' as const
	private readonly bucket: R2Bucket

	constructor(bucket: R2Bucket) {
		this.bucket = bucket
	}

	async put(key: string, body: Uint8Array, options: { contentType: string; customMetadata?: Record<string, string> }) {
		const object = await this.bucket.put(key, body as BufferSource, {
			httpMetadata: { contentType: options.contentType },
			customMetadata: options.customMetadata ?? {},
		})
		return metaFromR2(object)
	}

	async get(key: string) {
		const object = await this.bucket.get(key)
		if (!object) return null
		return { ...metaFromR2(object), body: new Uint8Array(await object.arrayBuffer()) }
	}

	async head(key: string) {
		const object = await this.bucket.head(key)
		return object ? metaFromR2(object) : null
	}

	async delete(keys: Array<string>) {
		if (keys.length === 0) return
		await this.bucket.delete(keys)
	}

	async list(options: { prefix: string; cursor?: string | null; limit: number }) {
		const page = await this.bucket.list({
			prefix: options.prefix,
			limit: options.limit,
			...(options.cursor ? { cursor: options.cursor } : {}),
		})
		return {
			objects: page.objects.map((object) => ({
				key: object.key,
				size: object.size,
				etag: object.etag,
				uploaded: object.uploaded.toISOString(),
			})),
			cursor: page.truncated ? page.cursor : null,
		}
	}
}

const metadataHeaderPrefix = 'x-amz-meta-'

function metaFromS3Headers(key: string, headers: Headers): StoredObjectMeta {
	const customMetadata: Record<string, string> = {}
	headers.forEach((value, name) => {
		if (name.startsWith(metadataHeaderPrefix)) customMetadata[name.slice(metadataHeaderPrefix.length)] = value
	})
	const lastModified = headers.get('last-modified')
	return {
		key,
		size: Number(headers.get('content-length') ?? 0),
		etag: (headers.get('etag') ?? '').replaceAll('"', ''),
		contentType: headers.get('content-type') ?? 'application/octet-stream',
		uploaded: lastModified ? new Date(lastModified).toISOString() : new Date().toISOString(),
		customMetadata,
	}
}

export class S3BlobStore implements BlobStore {
	readonly kind = 's3' as const
	private readonly config: S3Config
	private readonly fetcher: typeof fetch

	constructor(config: S3Config, fetcher: typeof fetch = fetch) {
		this.config = config
		this.fetcher = fetcher
	}

	private objectKey(key: string) {
		return `${this.config.prefix}${key}`
	}

	private stripPrefix(key: string) {
		return key.startsWith(this.config.prefix) ? key.slice(this.config.prefix.length) : key
	}

	private async send(input: Parameters<typeof signS3Request>[1]) {
		const request = await signS3Request(this.config, input)
		let response: Response
		try {
			response = await this.fetcher(request)
		} catch (error) {
			throw new KodyError('blob_store_unavailable', `S3 endpoint unreachable: ${(error as Error).message}`, {
				status: 502,
			})
		}
		return response
	}

	private async fail(response: Response, action: string): Promise<never> {
		const text = (await response.text()).slice(0, 500)
		const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `http_${response.status}`
		throw new KodyError('blob_store_error', `S3 ${action} failed (${code}).`, {
			status: 502,
			details: { code, httpStatus: response.status },
		})
	}

	async put(key: string, body: Uint8Array, options: { contentType: string; customMetadata?: Record<string, string> }) {
		const headers: Record<string, string> = {
			'content-type': options.contentType,
			'content-length': String(body.byteLength),
		}
		for (const [name, value] of Object.entries(options.customMetadata ?? {})) {
			headers[`${metadataHeaderPrefix}${name}`] = value
		}
		const response = await this.send({ method: 'PUT', key: this.objectKey(key), headers, body })
		if (!response.ok) return this.fail(response, 'PUT')
		await response.arrayBuffer()
		return {
			key,
			size: body.byteLength,
			etag: (response.headers.get('etag') ?? '').replaceAll('"', ''),
			contentType: options.contentType,
			uploaded: new Date().toISOString(),
			customMetadata: options.customMetadata ?? {},
		}
	}

	async get(key: string) {
		const response = await this.send({ method: 'GET', key: this.objectKey(key) })
		if (response.status === 404) {
			await response.arrayBuffer()
			return null
		}
		if (!response.ok) return this.fail(response, 'GET')
		return { ...metaFromS3Headers(key, response.headers), body: new Uint8Array(await response.arrayBuffer()) }
	}

	async head(key: string) {
		const response = await this.send({ method: 'HEAD', key: this.objectKey(key) })
		await response.arrayBuffer()
		if (response.status === 404) return null
		if (!response.ok) return this.fail(response, 'HEAD')
		return metaFromS3Headers(key, response.headers)
	}

	async delete(keys: Array<string>) {
		// Per-object DELETE keeps the signer simple (no XML multi-delete payload
		// with Content-MD5); blob deletes are single-key in practice.
		for (const key of keys) {
			const response = await this.send({ method: 'DELETE', key: this.objectKey(key) })
			await response.arrayBuffer()
			if (!response.ok && response.status !== 404) return this.fail(response, 'DELETE')
		}
	}

	async list(options: { prefix: string; cursor?: string | null; limit: number }) {
		const query: Record<string, string> = {
			'list-type': '2',
			prefix: this.objectKey(options.prefix),
			'max-keys': String(options.limit),
		}
		if (options.cursor) query['continuation-token'] = options.cursor
		const response = await this.send({ method: 'GET', key: '', query })
		if (!response.ok) return this.fail(response, 'LIST')
		const parsed = parseListObjects(await response.text())
		return {
			objects: parsed.objects.map((object) => ({
				key: this.stripPrefix(object.key),
				size: object.size,
				etag: object.etag,
				uploaded: object.lastModified,
			})),
			cursor: parsed.continuationToken,
		}
	}
}

export function createBlobStore(config: BlobConfig, bucket: R2Bucket | undefined): BlobStore {
	if (config.provider === 's3' && config.s3) return new S3BlobStore(config.s3)
	if (!bucket) {
		throw new KodyError('blob_store_unavailable', 'The BLOBS R2 binding is missing from the worker config.', {
			status: 503,
		})
	}
	return new R2BlobStore(bucket)
}
