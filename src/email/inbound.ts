import { KodyError } from '../lib/errors.ts'
import { inboundProviders, type InboundProvider } from './config.ts'
import {
	attachmentFromInput,
	cleanBody,
	cleanSubject,
	isEmailAddress,
	maxAttachments,
	normalizeEmailAddress,
	parseRawEmail,
	parseReferences,
	pickSafeHeaders,
	stripAngle,
	toAddressInput,
	type NormalizedEmail,
} from './message.ts'

/** What the HTTP layer hands an adapter: already-decoded body in one of three shapes. */
export type InboundPayload =
	| { kind: 'json'; body: unknown; headers: Headers }
	| { kind: 'form'; fields: Map<string, string>; files: Array<FormFile>; headers: Headers }
	| { kind: 'raw'; bytes: Uint8Array; headers: Headers }

export type FormFile = { field: string; filename: string; contentType: string; bytes: Uint8Array }

export type InboundEmail = {
	provider: InboundProvider
	envelopeFrom: string | null
	/** Envelope recipients when the provider tells us, else header To/Cc addresses. */
	recipients: Array<string>
	providerMessageId: string | null
	message: NormalizedEmail
}

export function isInboundProvider(value: string): value is InboundProvider {
	return (inboundProviders as ReadonlyArray<string>).includes(value)
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new KodyError('invalid_email_payload', 'Expected a JSON object.')
	}
	return value as Record<string, unknown>
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null
}

function headersFromArray(value: unknown): Array<[string, string]> {
	if (!Array.isArray(value)) return []
	const out: Array<[string, string]> = []
	for (const item of value) {
		if (Array.isArray(item) && typeof item[0] === 'string') out.push([item[0], String(item[1] ?? '')])
		else if (item && typeof item === 'object') {
			const r = item as Record<string, unknown>
			const name = r.name ?? r.Name
			const val = r.value ?? r.Value
			if (typeof name === 'string') out.push([name, String(val ?? '')])
		}
	}
	return out
}

function headersFromRecord(value: unknown): Array<[string, string]> {
	if (Array.isArray(value)) return headersFromArray(value)
	if (typeof value !== 'object' || value === null) return []
	return Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
}

function attachmentsFromJson(value: unknown): NormalizedEmail['attachments'] {
	if (!Array.isArray(value)) return []
	return value.slice(0, maxAttachments).flatMap((item, index) => {
		if (!item || typeof item !== 'object') return []
		const r = item as Record<string, unknown>
		const content = r.contentBase64 ?? r.content_base64 ?? r.Content ?? r.content
		if (typeof content !== 'string') return []
		const filename = r.filename ?? r.Name ?? r.name
		const contentType = r.contentType ?? r.content_type ?? r.ContentType ?? r.type
		const contentId = r.contentId ?? r.content_id ?? r.ContentID
		return [
			attachmentFromInput(
				{
					filename: typeof filename === 'string' ? filename : null,
					contentType: typeof contentType === 'string' ? contentType : null,
					contentBase64: content,
					contentId: typeof contentId === 'string' ? contentId : null,
					disposition:
						r.disposition === 'inline' || (typeof contentId === 'string' && contentId) ? 'inline' : 'attachment',
				},
				index,
			),
		]
	})
}

function finish(
	provider: InboundProvider,
	message: NormalizedEmail,
	envelope: { from?: string | null | undefined; to?: Array<string> | undefined },
	providerMessageId: string | null,
): InboundEmail {
	const envelopeTo = (envelope.to ?? []).map(normalizeEmailAddress).filter(isEmailAddress)
	const recipients = envelopeTo.length > 0 ? envelopeTo : [...message.to, ...message.cc].map((a) => a.address)
	if (!message.from.address) {
		throw new KodyError('invalid_email_payload', 'The message has no From address.')
	}
	return {
		provider,
		envelopeFrom: envelope.from ? normalizeEmailAddress(envelope.from) : null,
		recipients: [...new Set(recipients)],
		providerMessageId,
		message,
	}
}

function expectJson(payload: InboundPayload, provider: string) {
	if (payload.kind !== 'json') {
		throw new KodyError('invalid_email_payload', `${provider} deliveries must be application/json.`)
	}
	return record(payload.body)
}

/**
 * `generic`: the simplest possible contract for any forwarder or script:
 * `{ from, to, cc?, subject, text?, html?, headers?, messageId?, attachments?: [{filename, contentType, contentBase64}] }`
 * or `{ raw: "<rfc822 text>" }` (optionally with `envelope: { from, to: [] }`).
 */
export async function normalizeGeneric(payload: InboundPayload): Promise<InboundEmail> {
	if (payload.kind === 'raw') {
		return normalizeRaw('generic', payload)
	}
	const body = expectJson(payload, 'generic')
	const envelope = body.envelope && typeof body.envelope === 'object' ? (body.envelope as Record<string, unknown>) : {}
	const envelopeTo = Array.isArray(envelope.to) ? envelope.to.filter((x): x is string => typeof x === 'string') : []
	const envelopeFrom = str(envelope.from)
	if (typeof body.raw === 'string') {
		const message = await parseRawEmail(body.raw)
		return finish('generic', message, { from: envelopeFrom, to: envelopeTo }, str(body.messageId) ?? message.messageId)
	}
	const from = toAddressInput(body.from)[0]
	if (!from) throw new KodyError('invalid_email_payload', '"from" is required.')
	const message: NormalizedEmail = {
		from,
		to: toAddressInput(body.to),
		cc: toAddressInput(body.cc),
		replyTo: toAddressInput(body.replyTo ?? body.reply_to),
		subject: cleanSubject(body.subject),
		messageId: stripAngle(str(body.messageId ?? body.message_id)),
		inReplyTo: stripAngle(str(body.inReplyTo ?? body.in_reply_to)),
		references: Array.isArray(body.references)
			? body.references.filter((x): x is string => typeof x === 'string').map((x) => stripAngle(x) ?? x)
			: parseReferences(str(body.references)),
		date: str(body.date),
		text: cleanBody(body.text),
		html: cleanBody(body.html),
		headers: pickSafeHeaders(headersFromRecord(body.headers)),
		attachments: attachmentsFromJson(body.attachments),
	}
	return finish('generic', message, { from: envelopeFrom, to: envelopeTo }, message.messageId)
}

/**
 * Raw RFC 5322 bytes (`message/rfc822`) with the SMTP envelope in
 * `x-kody-envelope-from` / `x-kody-envelope-to` headers. Used by the
 * mail-bridge sidecar and any forwarder (including the Cloudflare Email
 * Routing example under examples/); `generic` accepts it too.
 */
export async function normalizeRaw(provider: InboundProvider, payload: InboundPayload): Promise<InboundEmail> {
	if (payload.kind !== 'raw') {
		throw new KodyError('invalid_email_payload', `${provider} deliveries must be message/rfc822 bytes.`)
	}
	if (payload.bytes.byteLength === 0) throw new KodyError('invalid_email_payload', 'Empty message.')
	const message = await parseRawEmail(payload.bytes)
	const envelopeTo = payload.headers
		.get('x-kody-envelope-to')
		?.split(',')
		.map((r) => r.trim())
		.filter(Boolean)
	return finish(
		provider,
		message,
		{ from: payload.headers.get('x-kody-envelope-from'), to: envelopeTo },
		message.messageId,
	)
}

export async function normalizeInbound(provider: InboundProvider, payload: InboundPayload): Promise<InboundEmail> {
	switch (provider) {
		case 'generic':
			return normalizeGeneric(payload)
		case 'bridge':
			return normalizeRaw(provider, payload)
		default: {
			const _exhaustive: never = provider
			throw new Error(`Unhandled inbound provider: ${String(_exhaustive)}`)
		}
	}
}

/** Decodes the HTTP body into the shape adapters expect based on content-type. */
export async function readInboundPayload(request: Request, maxBytes: number): Promise<InboundPayload> {
	const contentType = (request.headers.get('content-type') ?? '').toLowerCase()
	const declared = Number(request.headers.get('content-length') ?? 0)
	if (declared > maxBytes) throw new KodyError('email_too_large', `Body exceeds ${maxBytes} bytes.`, { status: 413 })
	if (contentType.startsWith('application/json')) {
		const text = await request.text()
		if (text.length > maxBytes)
			throw new KodyError('email_too_large', `Body exceeds ${maxBytes} bytes.`, { status: 413 })
		let body: unknown
		try {
			body = JSON.parse(text)
		} catch {
			throw new KodyError('invalid_email_payload', 'Body is not valid JSON.')
		}
		return { kind: 'json', body, headers: request.headers }
	}
	if (contentType.startsWith('multipart/form-data') || contentType.startsWith('application/x-www-form-urlencoded')) {
		const formData = await request.formData()
		const fields = new Map<string, string>()
		const files: Array<FormFile> = []
		let total = 0
		for (const [name, value] of formData) {
			if (typeof value === 'string') {
				total += value.length
				fields.set(name, value)
			} else {
				const bytes = new Uint8Array(await value.arrayBuffer())
				total += bytes.byteLength
				files.push({
					field: name,
					filename: value.name || name,
					contentType: value.type || 'application/octet-stream',
					bytes,
				})
			}
			if (total > maxBytes) throw new KodyError('email_too_large', `Body exceeds ${maxBytes} bytes.`, { status: 413 })
		}
		return { kind: 'form', fields, files, headers: request.headers }
	}
	const bytes = new Uint8Array(await request.arrayBuffer())
	if (bytes.byteLength > maxBytes)
		throw new KodyError('email_too_large', `Body exceeds ${maxBytes} bytes.`, { status: 413 })
	return { kind: 'raw', bytes, headers: request.headers }
}
