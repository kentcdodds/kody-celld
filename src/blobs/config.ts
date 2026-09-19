/**
 * Operator-level blob storage configuration. The default provider is the R2
 * binding (`BLOBS`), which celld serves from the fleet bucket under
 * `r2/<bucket_name>/` and `celld dev` from its local storage directory. The
 * `s3` provider talks SigV4 to any S3-compatible endpoint directly (a second
 * bucket, MinIO, Tigris, Backblaze B2, Cloudflare R2 over S3, …) for operators
 * who want blobs outside the celld fleet bucket. Keys never reach sandbox code.
 */

export type BlobProviderKind = 'r2' | 's3'

export type BlobEnv = {
	KODY_BLOB_PROVIDER?: string
	KODY_BLOB_S3_ENDPOINT?: string
	KODY_BLOB_S3_BUCKET?: string
	KODY_BLOB_S3_REGION?: string
	KODY_BLOB_S3_ACCESS_KEY_ID?: string
	KODY_BLOB_S3_SECRET_ACCESS_KEY?: string
	KODY_BLOB_S3_PREFIX?: string
	KODY_BLOB_S3_FORCE_PATH_STYLE?: string
	KODY_BLOB_MAX_BYTES?: string
	KODY_BLOB_URL_TTL_SECONDS?: string
}

export type S3Config = {
	endpoint: string
	bucket: string
	region: string
	accessKeyId: string
	secretAccessKey: string
	/** Object-key prefix inside the bucket (no leading slash; trailing slash added). */
	prefix: string
	forcePathStyle: boolean
}

export type BlobConfig = {
	provider: BlobProviderKind
	s3: S3Config | null
	/** Largest single object accepted through blobPut / PUT /api/blobs. */
	maxBytes: number
	/** Default lifetime of blobUrl links. */
	urlTtlSeconds: number
}

export const defaultBlobMaxBytes = 25 * 1024 * 1024
export const defaultBlobUrlTtlSeconds = 3600
export const maxBlobUrlTtlSeconds = 7 * 24 * 3600

function trimmed(value: string | undefined) {
	const v = value?.trim()
	return v ? v : undefined
}

function required(name: keyof BlobEnv, env: BlobEnv) {
	const value = trimmed(env[name])
	if (value === undefined) throw new Error(`${name} is required when KODY_BLOB_PROVIDER=s3.`)
	return value
}

function integer(name: string, raw: string | undefined, fallback: number, min: number, max: number) {
	const value = trimmed(raw)
	if (value === undefined) return fallback
	if (!/^\d+$/.test(value)) throw new Error(`${name}: expected an integer, got "${raw}".`)
	const n = Number(value)
	if (n < min || n > max) throw new Error(`${name}: must be between ${min} and ${max}.`)
	return n
}

function boolean(name: string, raw: string | undefined, fallback: boolean) {
	const value = trimmed(raw)?.toLowerCase()
	if (value === undefined) return fallback
	if (value === '1' || value === 'true' || value === 'yes') return true
	if (value === '0' || value === 'false' || value === 'no') return false
	throw new Error(`${name}: expected true/false, got "${raw}".`)
}

export function blobConfigFromEnv(env: BlobEnv): BlobConfig {
	const providerRaw = trimmed(env.KODY_BLOB_PROVIDER)?.toLowerCase() ?? 'r2'
	if (providerRaw !== 'r2' && providerRaw !== 's3') {
		throw new Error(`KODY_BLOB_PROVIDER: expected r2 or s3, got "${env.KODY_BLOB_PROVIDER}".`)
	}
	let s3: S3Config | null = null
	if (providerRaw === 's3') {
		const endpointRaw = required('KODY_BLOB_S3_ENDPOINT', env)
		let endpoint: URL
		try {
			endpoint = new URL(endpointRaw)
		} catch {
			throw new Error(`KODY_BLOB_S3_ENDPOINT: "${endpointRaw}" is not a valid URL.`)
		}
		if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
			throw new Error('KODY_BLOB_S3_ENDPOINT: only http(s) URLs are supported.')
		}
		const prefix = (trimmed(env.KODY_BLOB_S3_PREFIX) ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
		s3 = {
			endpoint: endpoint.toString().replace(/\/+$/, ''),
			bucket: required('KODY_BLOB_S3_BUCKET', env),
			region: trimmed(env.KODY_BLOB_S3_REGION) ?? 'auto',
			accessKeyId: required('KODY_BLOB_S3_ACCESS_KEY_ID', env),
			secretAccessKey: required('KODY_BLOB_S3_SECRET_ACCESS_KEY', env),
			prefix: prefix ? `${prefix}/` : '',
			forcePathStyle: boolean('KODY_BLOB_S3_FORCE_PATH_STYLE', env.KODY_BLOB_S3_FORCE_PATH_STYLE, true),
		}
	}
	return {
		provider: providerRaw,
		s3,
		maxBytes: integer('KODY_BLOB_MAX_BYTES', env.KODY_BLOB_MAX_BYTES, defaultBlobMaxBytes, 1024, 1024 * 1024 * 1024),
		urlTtlSeconds: integer(
			'KODY_BLOB_URL_TTL_SECONDS',
			env.KODY_BLOB_URL_TTL_SECONDS,
			defaultBlobUrlTtlSeconds,
			1,
			maxBlobUrlTtlSeconds,
		),
	}
}

/** Safe-to-print summary (no credentials). */
export function describeBlobConfig(config: BlobConfig) {
	return {
		provider: config.provider,
		maxBytes: config.maxBytes,
		urlTtlSeconds: config.urlTtlSeconds,
		s3: config.s3
			? {
					endpoint: config.s3.endpoint,
					bucket: config.s3.bucket,
					region: config.s3.region,
					prefix: config.s3.prefix,
					forcePathStyle: config.s3.forcePathStyle,
					hasCredentials: true,
				}
			: null,
	}
}
