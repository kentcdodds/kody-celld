import type { BlobRecord, UserCell } from '../cells/user-cell.ts'
import type { Env } from '../env.ts'
import { bytesToHex } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { blobConfigFromEnv, maxBlobUrlTtlSeconds, type BlobConfig } from './config.ts'
import { normalizeBlobKey, normalizeBlobPrefix, objectKeyFor, resolveContentType, signBlobUrl } from './keys.ts'
import { createBlobStore, type BlobStore } from './store.ts'

export type BlobScope = {
	env: Env
	userCell: DurableObjectStub<UserCell>
	userId: string
	packageName: string | null
	baseUrl: string
}

export const maxBlobMetadataEntries = 20
export const maxBlobMetadataValueLength = 1024

export class BlobService {
	readonly config: BlobConfig
	readonly store: BlobStore
	private readonly scope: BlobScope

	constructor(scope: BlobScope) {
		this.scope = scope
		this.config = blobConfigFromEnv(scope.env)
		this.store = createBlobStore(this.config, scope.env.BLOBS)
	}

	private objectKey(key: string) {
		return objectKeyFor(this.scope.userId, key)
	}

	async put(input: {
		key: unknown
		body: Uint8Array
		contentType?: string | undefined
		metadata?: unknown
	}): Promise<BlobRecord> {
		const key = normalizeBlobKey(input.key)
		const contentType = resolveContentType(key, input.contentType)
		const metadata = normalizeMetadata(input.metadata)
		if (input.body.byteLength > this.config.maxBytes) {
			throw new KodyError(
				'blob_too_large',
				`Blob is ${input.body.byteLength} bytes; the server accepts at most ${this.config.maxBytes} (KODY_BLOB_MAX_BYTES).`,
				{ status: 413 },
			)
		}
		const previous = await this.scope.userCell.blobReserve({ key, size: input.body.byteLength })
		const sha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', input.body as BufferSource)))
		const stored = await this.store.put(this.objectKey(key), input.body, {
			contentType,
			customMetadata: { sha256, ...(this.scope.packageName ? { package: this.scope.packageName } : {}) },
		})
		try {
			return await this.scope.userCell.blobIndexPut({
				key,
				size: stored.size,
				contentType,
				sha256,
				etag: stored.etag,
				packageName: this.scope.packageName,
				metadata,
			})
		} catch (error) {
			// The index is the source of truth for quotas; a racing put that lost
			// the re-check must not leave an unindexed object behind.
			if (!previous) await this.store.delete([this.objectKey(key)]).catch(() => {})
			throw error
		}
	}

	async head(key: unknown): Promise<BlobRecord | null> {
		return this.scope.userCell.blobIndexGet(normalizeBlobKey(key))
	}

	async get(key: unknown): Promise<{ record: BlobRecord; body: Uint8Array } | null> {
		const normalized = normalizeBlobKey(key)
		const record = await this.scope.userCell.blobIndexGet(normalized)
		if (!record) return null
		const object = await this.store.get(this.objectKey(normalized))
		if (!object) {
			// Index and bucket disagree (bucket restored from an older snapshot,
			// object removed out-of-band): drop the stale index row.
			await this.scope.userCell.blobIndexDelete(normalized)
			return null
		}
		return { record, body: object.body }
	}

	async delete(key: unknown): Promise<BlobRecord | null> {
		const normalized = normalizeBlobKey(key)
		const record = await this.scope.userCell.blobIndexDelete(normalized)
		await this.store.delete([this.objectKey(normalized)])
		return record
	}

	async list(input: { prefix?: unknown; cursor?: unknown; limit?: unknown }) {
		const prefix = normalizeBlobPrefix(input.prefix)
		const cursor = typeof input.cursor === 'string' && input.cursor ? input.cursor : undefined
		const limit = typeof input.limit === 'number' ? input.limit : undefined
		const page = await this.scope.userCell.blobIndexList({ prefix, cursor, limit })
		return { prefix, items: page.items, cursor: page.cursor }
	}

	async url(input: { key: unknown; expiresIn?: unknown }) {
		const key = normalizeBlobKey(input.key)
		const record = await this.scope.userCell.blobIndexGet(key)
		if (!record) throw new KodyError('blob_not_found', `No blob at "${key}".`, { status: 404 })
		const ttl =
			typeof input.expiresIn === 'number' && Number.isFinite(input.expiresIn)
				? Math.min(Math.max(Math.floor(input.expiresIn), 1), maxBlobUrlTtlSeconds)
				: this.config.urlTtlSeconds
		const expiresAt = Math.floor(Date.now() / 1000) + ttl
		const url = await signBlobUrl(this.scope.env.KODY_MASTER_KEY, {
			baseUrl: this.scope.baseUrl,
			userId: this.scope.userId,
			key,
			expiresAt,
		})
		return { key, url, expiresAt: new Date(expiresAt * 1000).toISOString(), expiresIn: ttl, record }
	}

	usage() {
		return this.scope.userCell.blobUsage()
	}
}

export function normalizeMetadata(input: unknown): Record<string, string> {
	if (input === undefined || input === null) return {}
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw new KodyError('invalid_args', 'metadata must be an object of string values.')
	}
	const entries = Object.entries(input as Record<string, unknown>)
	if (entries.length > maxBlobMetadataEntries) {
		throw new KodyError('invalid_args', `metadata may have at most ${maxBlobMetadataEntries} entries.`)
	}
	const out: Record<string, string> = {}
	for (const [name, value] of entries) {
		if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) {
			throw new KodyError('invalid_args', `metadata key "${name}" must match [a-zA-Z0-9_.-]{1,64}.`)
		}
		if (typeof value !== 'string' || value.length > maxBlobMetadataValueLength) {
			throw new KodyError(
				'invalid_args',
				`metadata.${name} must be a string of at most ${maxBlobMetadataValueLength} characters.`,
			)
		}
		out[name] = value
	}
	return out
}

/** Decodes capability `content` (utf8 text or base64) into bytes. */
export function decodeContent(content: unknown, encoding: unknown): Uint8Array {
	if (typeof content !== 'string') throw new KodyError('invalid_args', 'content must be a string.')
	const mode = encoding === undefined ? 'utf8' : encoding
	if (mode === 'utf8') return new TextEncoder().encode(content)
	if (mode === 'base64') {
		const cleaned = content.replace(/\s+/g, '')
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
			throw new KodyError('invalid_args', 'content is not valid base64.')
		}
		const binary = atob(cleaned)
		const bytes = new Uint8Array(binary.length)
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
		return bytes
	}
	throw new KodyError('invalid_args', 'encoding must be "utf8" or "base64".')
}

export function encodeBase64(bytes: Uint8Array) {
	let binary = ''
	const chunk = 0x8000
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
	}
	return btoa(binary)
}
