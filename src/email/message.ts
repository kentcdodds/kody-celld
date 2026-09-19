import PostalMime, { addressParser, type Address } from 'postal-mime'
import type { EmailAddress, EmailAttachmentMeta } from '../cells/user-cell.ts'
import { randomId } from '../lib/crypto.ts'

/** Provider-independent inbound message, ready for `emailMessageStore`. */
export type NormalizedEmail = {
	from: EmailAddress
	to: Array<EmailAddress>
	cc: Array<EmailAddress>
	replyTo: Array<EmailAddress>
	subject: string
	messageId: string | null
	inReplyTo: string | null
	references: Array<string>
	date: string | null
	text: string | null
	html: string | null
	headers: Record<string, string>
	attachments: Array<EmailAttachmentMeta & { contentBase64: string }>
}

export type AttachmentInput = {
	filename?: string | null | undefined
	contentType?: string | null | undefined
	contentBase64: string
	contentId?: string | null | undefined
	disposition?: 'attachment' | 'inline' | null | undefined
}

/** Headers worth keeping for automation; everything else (Received chains, DKIM blobs, ...) is dropped. */
export const safeHeaderNames = new Set([
	'date',
	'from',
	'to',
	'cc',
	'reply-to',
	'subject',
	'message-id',
	'in-reply-to',
	'references',
	'list-id',
	'list-unsubscribe',
	'precedence',
	'auto-submitted',
	'x-mailer',
	'x-priority',
	'importance',
	'content-type',
	'delivered-to',
	'return-path',
	'received',
	'authentication-results',
	'x-spam-status',
	'x-spam-score',
])

export const maxHeaderValueLength = 2_000
export const maxSubjectLength = 998
export const maxAttachments = 25

export function normalizeEmailAddress(address: string) {
	return address.trim().toLowerCase()
}

export function isEmailAddress(value: string) {
	return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && value.length <= 254
}

function flattenAddresses(list: Array<Address> | undefined): Array<EmailAddress> {
	const out: Array<EmailAddress> = []
	for (const item of list ?? []) {
		if (item.group) {
			for (const member of item.group) {
				if (member.address) out.push({ address: normalizeEmailAddress(member.address), name: member.name || null })
			}
		} else if (item.address) {
			out.push({ address: normalizeEmailAddress(item.address), name: item.name || null })
		}
	}
	return out
}

/** Parses `Name <a@b>, c@d` style lists; tolerant of provider quirks. */
export function parseAddressList(raw: string | null | undefined): Array<EmailAddress> {
	if (!raw || !raw.trim()) return []
	try {
		return flattenAddresses(addressParser(raw))
	} catch {
		return raw
			.split(',')
			.map((part) => part.trim())
			.filter(isEmailAddress)
			.map((address) => ({ address: normalizeEmailAddress(address), name: null }))
	}
}

export function parseSingleAddress(raw: string | null | undefined): EmailAddress | null {
	return parseAddressList(raw)[0] ?? null
}

export function toAddressInput(value: unknown): Array<EmailAddress> {
	if (typeof value === 'string') return parseAddressList(value)
	if (!value) return []
	const items = Array.isArray(value) ? value : [value]
	const out: Array<EmailAddress> = []
	for (const item of items) {
		if (typeof item === 'string') out.push(...parseAddressList(item))
		else if (item && typeof item === 'object') {
			const record = item as Record<string, unknown>
			const address = record.address ?? record.email ?? record.Email
			if (typeof address === 'string' && isEmailAddress(address.trim())) {
				const name = record.name ?? record.Name
				out.push({ address: normalizeEmailAddress(address), name: typeof name === 'string' && name ? name : null })
			}
		}
	}
	return out
}

export function stripAngle(id: string | null | undefined) {
	if (!id) return null
	const trimmed = id.trim()
	return trimmed ? trimmed.replace(/^<|>$/g, '') : null
}

export function parseReferences(raw: string | null | undefined): Array<string> {
	if (!raw) return []
	return raw
		.split(/[\s,]+/)
		.map((id) => stripAngle(id))
		.filter((id): id is string => id !== null)
}

export function pickSafeHeaders(entries: Iterable<[string, string]>): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [rawName, rawValue] of entries) {
		const name = rawName.trim().toLowerCase()
		if (!safeHeaderNames.has(name)) continue
		const value = String(rawValue).replace(/\s+/g, ' ').trim().slice(0, maxHeaderValueLength)
		if (!value) continue
		// Only the top-most Received: (our own hop) is kept; the rest is upstream noise.
		if (name === 'received' && name in out) continue
		out[name] = name in out ? `${out[name]}, ${value}` : value
	}
	return out
}

function sanitizeFilename(value: string | null | undefined) {
	if (!value) return ''
	let out = ''
	for (const char of value.trim()) {
		const code = char.charCodeAt(0)
		out += char === '/' || char === '\\' || code < 0x20 ? '_' : char
	}
	return out
}

export function attachmentFromInput(
	input: AttachmentInput,
	index: number,
): EmailAttachmentMeta & { contentBase64: string } {
	const contentBase64 = input.contentBase64.replace(/\s+/g, '')
	const contentType = (input.contentType?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream').slice(
		0,
		200,
	)
	return {
		id: randomId('att'),
		filename: (sanitizeFilename(input.filename) || `attachment-${index + 1}`).slice(0, 255),
		contentType,
		size: base64Size(contentBase64),
		contentId: stripAngle(input.contentId) ?? null,
		disposition: input.disposition === 'inline' ? 'inline' : 'attachment',
		contentBase64,
	}
}

export function base64Size(base64: string) {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

export function bytesToBase64(bytes: Uint8Array) {
	let binary = ''
	const chunk = 0x8000
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
	}
	return btoa(binary)
}

export function base64ToBytes(base64: string) {
	const binary = atob(base64.replace(/\s+/g, ''))
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

export function cleanSubject(value: unknown) {
	return typeof value === 'string'
		? value
				.replace(/[\r\n]+/g, ' ')
				.trim()
				.slice(0, maxSubjectLength)
		: ''
}

export function cleanBody(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : null
}

/** Parses a raw RFC 5322 message (string or bytes) into the normalized shape. */
export async function parseRawEmail(raw: string | Uint8Array | ArrayBuffer): Promise<NormalizedEmail> {
	const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'base64', rfc822Attachments: true })
	const attachments = parsed.attachments.slice(0, maxAttachments).map((attachment, index) =>
		attachmentFromInput(
			{
				filename: attachment.filename,
				contentType: attachment.mimeType,
				contentBase64:
					typeof attachment.content === 'string' ? attachment.content : bytesToBase64(toBytes(attachment.content)),
				contentId: attachment.contentId ?? null,
				disposition: attachment.disposition ?? (attachment.related ? 'inline' : 'attachment'),
			},
			index,
		),
	)
	const from = flattenAddresses(parsed.from ? [parsed.from] : [])[0] ?? { address: '', name: null }
	return {
		from,
		to: flattenAddresses(parsed.to),
		cc: flattenAddresses(parsed.cc),
		replyTo: flattenAddresses(parsed.replyTo),
		subject: cleanSubject(parsed.subject),
		messageId: stripAngle(parsed.messageId),
		inReplyTo: stripAngle(parsed.inReplyTo),
		references: parseReferences(parsed.references),
		date: parsed.date ?? null,
		text: cleanBody(parsed.text),
		html: cleanBody(parsed.html),
		headers: pickSafeHeaders(parsed.headers.map((header) => [header.key, header.value] as [string, string])),
		attachments,
	}
}

function toBytes(content: ArrayBuffer | Uint8Array | string) {
	if (typeof content === 'string') return new TextEncoder().encode(content)
	return content instanceof Uint8Array ? content : new Uint8Array(content)
}

/**
 * Splits `local+tag@domain`, returning the routable base local (before the
 * first `+`) so plus-tags can never bypass reservation or ownership checks.
 */
export function splitInboxAddress(address: string, domain: string): { local: string; tag: string | null } | null {
	const normalized = normalizeEmailAddress(address)
	const at = normalized.lastIndexOf('@')
	if (at <= 0) return null
	if (normalized.slice(at + 1) !== domain) return null
	const localPart = normalized.slice(0, at)
	const plus = localPart.indexOf('+')
	const local = plus === -1 ? localPart : localPart.slice(0, plus)
	if (!local) return null
	return { local, tag: plus === -1 ? null : localPart.slice(plus + 1) || null }
}

export function formatAddress(address: EmailAddress) {
	if (!address.name) return address.address
	const name = address.name.replace(/["\\\r\n]/g, '')
	return `"${name}" <${address.address}>`
}

export function snippetOf(text: string | null, html: string | null, length = 200) {
	const source = text ?? (html ? html.replace(/<[^>]+>/g, ' ') : '')
	return source.replace(/\s+/g, ' ').trim().slice(0, length)
}
