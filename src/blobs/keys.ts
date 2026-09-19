import { bytesToHex } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'

export const maxBlobKeyLength = 512

// Conservative S3-safe subset: letters, digits, and `!-_.*'()/`. No `..`
// segments, no leading/trailing slash, no empty segments, no control chars.
const keyPattern = /^[A-Za-z0-9!_.*'()@=,:+ -][A-Za-z0-9!_.*'()@=,:+/ -]*$/

/** Validates a user-facing blob key and returns it unchanged. */
export function normalizeBlobKey(input: unknown): string {
	if (typeof input !== 'string') throw new KodyError('invalid_blob_key', 'Blob key must be a string.')
	const key = input.trim()
	if (!key) throw new KodyError('invalid_blob_key', 'Blob key is required.')
	if (key.length > maxBlobKeyLength) {
		throw new KodyError('invalid_blob_key', `Blob key must be at most ${maxBlobKeyLength} characters.`)
	}
	if (!keyPattern.test(key) || key.endsWith('/')) {
		throw new KodyError(
			'invalid_blob_key',
			`Blob key "${key}" may only use letters, digits, spaces and !_.*'()@=,:+- separated by "/", and must not start or end with "/".`,
		)
	}
	if (key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new KodyError('invalid_blob_key', `Blob key "${key}" must not contain empty, "." or ".." segments.`)
	}
	return key
}

/** Validates a list prefix: like a key, but may end with "/" or be empty. */
export function normalizeBlobPrefix(input: unknown): string {
	if (input === undefined || input === null || input === '') return ''
	if (typeof input !== 'string') throw new KodyError('invalid_blob_key', 'Blob prefix must be a string.')
	const trimmedPrefix = input.trim()
	if (!trimmedPrefix) return ''
	const normalized = normalizeBlobKey(trimmedPrefix.replace(/\/+$/, ''))
	return trimmedPrefix.endsWith('/') ? `${normalized}/` : normalized
}

/**
 * Every user's objects live under their own prefix in the bucket so a key can
 * never address another user's data regardless of what the capability layer
 * does with it.
 */
export function objectKeyFor(userId: string, key: string) {
	return `users/${userId}/${key}`
}

export function userPrefix(userId: string) {
	return `users/${userId}/`
}

const contentTypesByExtension: Record<string, string> = {
	txt: 'text/plain; charset=utf-8',
	md: 'text/markdown; charset=utf-8',
	csv: 'text/csv; charset=utf-8',
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	json: 'application/json',
	xml: 'application/xml',
	yaml: 'application/yaml',
	yml: 'application/yaml',
	pdf: 'application/pdf',
	zip: 'application/zip',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	mp4: 'video/mp4',
	webm: 'video/webm',
	woff2: 'font/woff2',
}

const contentTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/i

/** Picks a content type: explicit (validated) → by extension → octet-stream. */
export function resolveContentType(key: string, explicit: string | undefined) {
	if (explicit !== undefined) {
		const value = explicit.trim()
		if (!contentTypePattern.test(value) || value.length > 200) {
			throw new KodyError('invalid_args', `"${explicit}" is not a valid content type.`)
		}
		return value
	}
	const extension = key.split('/').pop()?.split('.').pop()?.toLowerCase() ?? ''
	return contentTypesByExtension[extension] ?? 'application/octet-stream'
}

export function isTextContentType(contentType: string) {
	const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
	return (
		type.startsWith('text/') ||
		type === 'application/json' ||
		type === 'application/xml' ||
		type === 'application/yaml' ||
		type === 'application/javascript' ||
		type.endsWith('+json') ||
		type.endsWith('+xml')
	)
}

const encoder = new TextEncoder()

async function signingKey(masterKey: string, userId: string) {
	const ikm = await crypto.subtle.importKey('raw', encoder.encode(masterKey), 'HKDF', false, ['deriveKey'])
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode(`kody-celld:${userId}`),
			info: encoder.encode('kody-celld-blob-urls'),
		},
		ikm,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}

function signingPayload(userId: string, key: string, expiresAt: number) {
	return encoder.encode(`${userId}\u0000${key}\u0000${expiresAt}`)
}

/**
 * Time-limited download links are HMAC(master key ⊕ user, key, expiry). They
 * are verified by the worker itself, so they work identically on `celld dev`,
 * a single Docker node and a fleet, and they never expose bucket credentials.
 */
export async function signBlobUrl(
	masterKey: string,
	input: { baseUrl: string; userId: string; key: string; expiresAt: number },
) {
	const key = await signingKey(masterKey, input.userId)
	const signature = await crypto.subtle.sign('HMAC', key, signingPayload(input.userId, input.key, input.expiresAt))
	const url = new URL(`${input.baseUrl.replace(/\/+$/, '')}/blobs/${encodeURIComponent(input.userId)}/`)
	url.pathname += input.key.split('/').map(encodeURIComponent).join('/')
	url.searchParams.set('exp', String(input.expiresAt))
	url.searchParams.set('sig', bytesToHex(new Uint8Array(signature)))
	return url.toString()
}

export async function verifyBlobUrlSignature(
	masterKey: string,
	input: { userId: string; key: string; expiresAt: number; signatureHex: string },
	now = Date.now(),
) {
	if (!Number.isFinite(input.expiresAt) || input.expiresAt * 1000 < now) return false
	if (!/^[0-9a-f]{64}$/.test(input.signatureHex)) return false
	const key = await signingKey(masterKey, input.userId)
	const signature = new Uint8Array(32)
	for (let i = 0; i < 32; i++) signature[i] = parseInt(input.signatureHex.slice(i * 2, i * 2 + 2), 16)
	return crypto.subtle.verify('HMAC', key, signature, signingPayload(input.userId, input.key, input.expiresAt))
}
