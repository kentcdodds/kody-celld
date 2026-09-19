import { describeBlobConfig } from '../blobs/config.ts'
import { BlobService, decodeContent, encodeBase64 } from '../blobs/service.ts'
import { KodyError } from '../lib/errors.ts'
import { defineCapability, defineDomain, type CapabilityContext } from './define.ts'

export const blobsDomain = defineDomain({
	name: 'blobs',
	description:
		'Per-user binary/file storage on the fleet bucket (celld R2 binding by default, or any S3-compatible bucket via KODY_BLOB_PROVIDER=s3). Keys are scoped to the calling user; packages see the same namespace as ad hoc code. Use blobUrl to hand a file to a browser or another service without exposing bucket credentials.',
	guide:
		'Write with blobPut (utf8 text or base64), read back with blobGet (base64 or utf8), list with blobList, delete with blobDelete. blobUrl mints a time-limited signed download link served by this Kody instance. Quotas: KODY_BLOB_MAX_BYTES per object, KODY_QUOTA_BLOBS / KODY_QUOTA_BLOB_BYTES per user (blobUsage shows them).',
})

function service(ctx: CapabilityContext) {
	return new BlobService({
		env: ctx.env,
		userCell: ctx.userCell,
		userId: ctx.user.id,
		packageName: ctx.packageName,
		baseUrl: ctx.baseUrl,
	})
}

const maxInlineReadBytes = 5 * 1024 * 1024

export const blobPut = defineCapability<{
	key: string
	content: string
	encoding?: 'utf8' | 'base64'
	contentType?: string
	metadata?: Record<string, string>
}>({
	domain: 'blobs',
	name: 'blobPut',
	description: 'Store a file/blob under a key (creates or overwrites). Content is utf8 text or base64-encoded bytes.',
	tags: ['blobs', 'write', 'files'],
	keywords: ['upload file', 'save blob', 'store bytes', 'r2 put', 's3 put', 'write object', 'save image'],
	inputSchema: {
		type: 'object',
		properties: {
			key: {
				type: 'string',
				description: 'Path-like key such as reports/2026-09/summary.pdf (no leading slash, no "..").',
			},
			content: { type: 'string' },
			encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
			contentType: { type: 'string', description: 'MIME type; inferred from the key extension when omitted.' },
			metadata: { type: 'object', description: 'Up to 20 short string entries stored with the blob.' },
		},
		required: ['key', 'content'],
	},
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.blobPut({ key: 'notes/hello.txt', content: 'hello' })
}`,
	async handler(args, ctx) {
		const body = decodeContent(args.content, args.encoding)
		return service(ctx).put({ key: args.key, body, contentType: args.contentType, metadata: args.metadata })
	},
})

export const blobGet = defineCapability<{ key: string; encoding?: 'utf8' | 'base64' }>({
	domain: 'blobs',
	name: 'blobGet',
	description:
		'Read a blob back as utf8 text or base64 (inline reads are capped at 5 MB; use blobUrl for larger files).',
	tags: ['blobs', 'read', 'files'],
	keywords: ['download file', 'read blob', 'get object', 'r2 get', 's3 get'],
	inputSchema: {
		type: 'object',
		properties: { key: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'base64' } },
		required: ['key'],
	},
	readOnly: true,
	async handler(args, ctx) {
		const found = await service(ctx).get(args.key)
		if (!found) throw new KodyError('blob_not_found', `No blob at "${args.key}".`, { status: 404 })
		if (found.body.byteLength > maxInlineReadBytes) {
			throw new KodyError(
				'blob_too_large',
				`Blob is ${found.body.byteLength} bytes; inline reads stop at ${maxInlineReadBytes}. Use blobUrl instead.`,
				{ status: 413 },
			)
		}
		const encoding = args.encoding ?? 'base64'
		return {
			...found.record,
			encoding,
			content: encoding === 'utf8' ? new TextDecoder().decode(found.body) : encodeBase64(found.body),
		}
	},
})

export const blobHead = defineCapability<{ key: string }>({
	domain: 'blobs',
	name: 'blobHead',
	description: 'Fetch a blob’s metadata (size, contentType, sha256, custom metadata) without its content.',
	tags: ['blobs', 'read', 'files'],
	keywords: ['blob metadata', 'file size', 'exists', 'head object'],
	inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
	readOnly: true,
	async handler(args, ctx) {
		const record = await service(ctx).head(args.key)
		if (!record) throw new KodyError('blob_not_found', `No blob at "${args.key}".`, { status: 404 })
		return record
	},
})

export const blobList = defineCapability<{ prefix?: string; cursor?: string; limit?: number }>({
	domain: 'blobs',
	name: 'blobList',
	description: 'List blobs by key prefix with cursor pagination.',
	tags: ['blobs', 'read', 'files'],
	keywords: ['list files', 'list objects', 'browse blobs', 'directory'],
	inputSchema: {
		type: 'object',
		properties: { prefix: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', default: 100 } },
	},
	readOnly: true,
	async handler(args, ctx) {
		return service(ctx).list(args)
	},
})

export const blobDelete = defineCapability<{ key: string }>({
	domain: 'blobs',
	name: 'blobDelete',
	description: 'Delete a blob. Succeeds (deleted: false) when the key does not exist.',
	tags: ['blobs', 'write', 'destructive'],
	keywords: ['delete file', 'remove blob', 'delete object'],
	inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
	async handler(args, ctx) {
		const record = await service(ctx).delete(args.key)
		return { key: args.key, deleted: record !== null, freedBytes: record?.size ?? 0 }
	},
})

export const blobUrl = defineCapability<{ key: string; expiresIn?: number }>({
	domain: 'blobs',
	name: 'blobUrl',
	description:
		'Mint a time-limited signed download URL for a blob, served by this Kody instance (bucket credentials stay on the server).',
	tags: ['blobs', 'read', 'files', 'share'],
	keywords: ['signed url', 'presigned', 'share file', 'download link', 'public link'],
	inputSchema: {
		type: 'object',
		properties: {
			key: { type: 'string' },
			expiresIn: {
				type: 'integer',
				description: 'Seconds until the link stops working (default KODY_BLOB_URL_TTL_SECONDS, max 7 days).',
			},
		},
		required: ['key'],
	},
	readOnly: true,
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  const { url } = await kody.blobUrl({ key: 'reports/latest.pdf', expiresIn: 3600 })
  return { url }
}`,
	async handler(args, ctx) {
		return service(ctx).url(args)
	},
})

export const blobUsage = defineCapability<Record<string, never>>({
	domain: 'blobs',
	name: 'blobUsage',
	description:
		'Show blob count/bytes used, the per-user quotas, and which storage provider backs blobs (no credentials).',
	tags: ['blobs', 'read', 'usage'],
	keywords: ['storage usage', 'blob quota', 'bucket provider', 'how much space'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		const svc = service(ctx)
		const usage = await svc.usage()
		return { ...usage, maxBlobBytes: svc.config.maxBytes, provider: describeBlobConfig(svc.config) }
	},
})

export const blobCapabilities = [blobPut, blobGet, blobHead, blobList, blobDelete, blobUrl, blobUsage]
