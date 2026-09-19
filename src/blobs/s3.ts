import { bytesToHex } from '../lib/crypto.ts'
import type { S3Config } from './config.ts'

/**
 * Minimal AWS Signature V4 signer for S3-compatible object stores. Only what
 * the blob store needs: single-request PUT / GET / HEAD / DELETE and a
 * ListObjectsV2 GET. Payloads are signed with their SHA-256 (no chunked
 * uploads), which every S3-compatible store accepts.
 */

const encoder = new TextEncoder()

async function sha256(data: Uint8Array | string) {
	const bytes = typeof data === 'string' ? encoder.encode(data) : data
	return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)))
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
}

// RFC 3986 unreserved set; S3 wants every other byte percent-encoded, and
// path segments keep "/" while query values encode it.
function uriEncode(value: string, encodeSlash: boolean) {
	let out = ''
	for (const char of value) {
		if (/[A-Za-z0-9\-_.~]/.test(char)) out += char
		else if (char === '/' && !encodeSlash) out += char
		else {
			for (const byte of encoder.encode(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
		}
	}
	return out
}

function amzDate(date: Date) {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

export type S3Request = {
	method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
	/** Object key inside the bucket ('' for bucket-level requests such as list). */
	key: string
	query?: Record<string, string>
	headers?: Record<string, string>
	body?: Uint8Array
}

export function s3ObjectUrl(config: S3Config, key: string, query: Record<string, string> = {}) {
	const endpoint = new URL(config.endpoint)
	const encodedKey = uriEncode(key, false)
	if (config.forcePathStyle) {
		endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${config.bucket}${encodedKey ? `/${encodedKey}` : ''}`
	} else {
		endpoint.hostname = `${config.bucket}.${endpoint.hostname}`
		endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${encodedKey}`
	}
	const canonicalQuery = Object.keys(query)
		.sort()
		.map((k) => `${uriEncode(k, true)}=${uriEncode(query[k] ?? '', true)}`)
		.join('&')
	return { url: `${endpoint.origin}${endpoint.pathname}${canonicalQuery ? `?${canonicalQuery}` : ''}`, canonicalQuery }
}

/** Builds a signed `Request` for the S3 call described by `input`. */
export async function signS3Request(config: S3Config, input: S3Request, now = new Date()): Promise<Request> {
	const { url, canonicalQuery } = s3ObjectUrl(config, input.key, input.query)
	const parsed = new URL(url)
	const payloadHash = await sha256(input.body ?? new Uint8Array())
	const dateTime = amzDate(now)
	const date = dateTime.slice(0, 8)
	const headers: Record<string, string> = {
		host: parsed.host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': dateTime,
		...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
	}
	const signedHeaderNames = Object.keys(headers).sort()
	const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('')
	const signedHeaders = signedHeaderNames.join(';')
	const canonicalRequest = [
		input.method,
		parsed.pathname,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join('\n')
	const scope = `${date}/${config.region}/s3/aws4_request`
	const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, await sha256(canonicalRequest)].join('\n')
	const kDate = await hmac(encoder.encode(`AWS4${config.secretAccessKey}`), date)
	const kRegion = await hmac(kDate, config.region)
	const kService = await hmac(kRegion, 's3')
	const kSigning = await hmac(kService, 'aws4_request')
	const signature = bytesToHex(new Uint8Array(await hmac(kSigning, stringToSign)))
	const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
	const { host: _host, ...requestHeaders } = headers
	return new Request(url, {
		method: input.method,
		headers: { ...requestHeaders, authorization },
		body: input.body && input.method === 'PUT' ? (input.body as BodyInit) : null,
	})
}

/** Parses the subset of a ListObjectsV2 XML response the blob store needs. */
export function parseListObjects(xml: string) {
	const objects: Array<{ key: string; size: number; etag: string; lastModified: string }> = []
	const contentsPattern = /<Contents>([\s\S]*?)<\/Contents>/g
	const text = (block: string, tag: string) => {
		const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)
		return match?.[1] ?? ''
	}
	const decode = (value: string) =>
		value
			.replaceAll('&lt;', '<')
			.replaceAll('&gt;', '>')
			.replaceAll('&quot;', '"')
			.replaceAll('&apos;', "'")
			.replaceAll('&amp;', '&')
	for (const match of xml.matchAll(contentsPattern)) {
		const block = match[1] ?? ''
		objects.push({
			key: decode(text(block, 'Key')),
			size: Number(text(block, 'Size')),
			etag: decode(text(block, 'ETag')).replaceAll('"', ''),
			lastModified: text(block, 'LastModified'),
		})
	}
	const truncated = text(xml, 'IsTruncated') === 'true'
	const continuationToken = truncated ? decode(text(xml, 'NextContinuationToken')) || null : null
	return { objects, truncated, continuationToken }
}
