import { KodyError } from '../lib/errors.ts'
import { inboundProviders, type InboundProvider } from './config.ts'
import {
	attachmentFromInput,
	bytesToBase64,
	cleanBody,
	cleanSubject,
	isEmailAddress,
	maxAttachments,
	normalizeEmailAddress,
	parseAddressList,
	parseRawEmail,
	parseReferences,
	parseSingleAddress,
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

/** Parses a raw header block ("Name: value\r\n...") as SendGrid's `headers` field ships it. */
export function parseHeaderBlock(block: string): Array<[string, string]> {
	const out: Array<[string, string]> = []
	const lines = block.replace(/\r\n/g, '\n').split('\n')
	let current: [string, string] | null = null
	for (const line of lines) {
		if (/^[ \t]/.test(line) && current) {
			current[1] += ` ${line.trim()}`
			continue
		}
		const colon = line.indexOf(':')
		if (colon <= 0) continue
		current = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
		out.push(current)
	}
	return out
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

function attachmentsFromFiles(files: Array<FormFile>, inlineIds: Map<string, string> = new Map()) {
	return files.slice(0, maxAttachments).map((file, index) => {
		const contentId = inlineIds.get(file.field) ?? null
		return attachmentFromInput(
			{
				filename: file.filename,
				contentType: file.contentType,
				contentBase64: bytesToBase64(file.bytes),
				contentId,
				disposition: contentId ? 'inline' : 'attachment',
			},
			index,
		)
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

function expectForm(payload: InboundPayload, provider: string) {
	if (payload.kind !== 'form') {
		throw new KodyError(
			'invalid_email_payload',
			`${provider} deliveries must be multipart/form-data or form-urlencoded.`,
		)
	}
	return payload
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

/** Postmark inbound webhook (JSON). */
export async function normalizePostmark(payload: InboundPayload): Promise<InboundEmail> {
	const body = expectJson(payload, 'Postmark')
	const fromFull =
		body.FromFull && typeof body.FromFull === 'object' ? (body.FromFull as Record<string, unknown>) : null
	const from =
		(fromFull && typeof fromFull.Email === 'string'
			? { address: normalizeEmailAddress(fromFull.Email), name: str(fromFull.Name) }
			: null) ?? parseSingleAddress(str(body.From))
	if (!from) throw new KodyError('invalid_email_payload', 'Postmark payload has no From.')
	const headers = headersFromArray(body.Headers)
	const message: NormalizedEmail = {
		from,
		to: toAddressInput(body.ToFull).length ? toAddressInput(body.ToFull) : parseAddressList(str(body.To)),
		cc: toAddressInput(body.CcFull).length ? toAddressInput(body.CcFull) : parseAddressList(str(body.Cc)),
		replyTo: parseAddressList(str(body.ReplyTo)),
		subject: cleanSubject(body.Subject),
		messageId:
			stripAngle(str(body.MessageID)) ?? stripAngle(headers.find(([k]) => k.toLowerCase() === 'message-id')?.[1]),
		inReplyTo: stripAngle(headers.find(([k]) => k.toLowerCase() === 'in-reply-to')?.[1]),
		references: parseReferences(headers.find(([k]) => k.toLowerCase() === 'references')?.[1]),
		date: str(body.Date),
		text: cleanBody(body.TextBody),
		html: cleanBody(body.HtmlBody),
		headers: pickSafeHeaders(headers),
		attachments: attachmentsFromJson(body.Attachments),
	}
	const originalRecipient = str(body.OriginalRecipient)
	return finish(
		'postmark',
		message,
		{ from: null, to: originalRecipient ? [originalRecipient] : undefined },
		str(body.MessageID),
	)
}

/** Mailgun route `forward()` (multipart/form-data, parsed fields or `body-mime`). */
export async function normalizeMailgun(payload: InboundPayload): Promise<InboundEmail> {
	const form = expectForm(payload, 'Mailgun')
	const f = (name: string) => str(form.fields.get(name))
	const recipient = f('recipient')
	const envelopeTo = recipient ? recipient.split(',').map((r) => r.trim()) : undefined
	const mime = f('body-mime')
	if (mime) {
		const message = await parseRawEmail(mime)
		return finish('mailgun', message, { from: f('sender'), to: envelopeTo }, message.messageId)
	}
	const sender = f('sender')
	const from =
		parseSingleAddress(f('from') ?? f('From')) ??
		(sender ? { address: normalizeEmailAddress(sender), name: null } : null)
	if (!from) throw new KodyError('invalid_email_payload', 'Mailgun payload has no from.')
	let headerPairs: Array<[string, string]> = []
	const rawHeaders = f('message-headers')
	if (rawHeaders) {
		try {
			headerPairs = headersFromArray(JSON.parse(rawHeaders))
		} catch {
			headerPairs = []
		}
	}
	const inlineIds = new Map<string, string>()
	const contentIdMap = f('content-id-map')
	if (contentIdMap) {
		try {
			for (const [cid, field] of Object.entries(JSON.parse(contentIdMap) as Record<string, string>)) {
				inlineIds.set(field, stripAngle(cid) ?? cid)
			}
		} catch {
			// ignore malformed map
		}
	}
	const message: NormalizedEmail = {
		from,
		to: parseAddressList(f('To') ?? f('to')),
		cc: parseAddressList(f('Cc') ?? f('cc')),
		replyTo: parseAddressList(f('Reply-To')),
		subject: cleanSubject(f('subject') ?? f('Subject') ?? ''),
		messageId: stripAngle(f('Message-Id') ?? f('message-id')),
		inReplyTo: stripAngle(f('In-Reply-To')),
		references: parseReferences(f('References')),
		date: f('Date'),
		text: cleanBody(f('body-plain')),
		html: cleanBody(f('body-html')),
		headers: pickSafeHeaders(headerPairs),
		attachments: attachmentsFromFiles(form.files, inlineIds),
	}
	return finish('mailgun', message, { from: f('sender'), to: envelopeTo }, message.messageId)
}

/** Mailgun signs `timestamp + token` with the webhook signing key (hex HMAC-SHA256). */
export async function verifyMailgunSignature(
	fields: Map<string, string>,
	signingKey: string,
	now = Date.now(),
	toleranceSeconds = 300,
) {
	const timestamp = fields.get('timestamp') ?? ''
	const token = fields.get('token') ?? ''
	const signature = fields.get('signature') ?? ''
	if (!/^\d+$/.test(timestamp) || !token || !signature) return false
	if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(signingKey),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}${token}`)))
	const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
	const provided = signature.toLowerCase()
	if (provided.length !== hex.length) return false
	let diff = 0
	for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ provided.charCodeAt(i)
	return diff === 0
}

/** SendGrid Inbound Parse (multipart/form-data; parsed fields or the "send raw" `email` field). */
export async function normalizeSendgrid(payload: InboundPayload): Promise<InboundEmail> {
	const form = expectForm(payload, 'SendGrid')
	const f = (name: string) => str(form.fields.get(name))
	let envelopeFrom: string | null = null
	let envelopeTo: Array<string> | undefined
	const envelopeRaw = f('envelope')
	if (envelopeRaw) {
		try {
			const envelope = JSON.parse(envelopeRaw) as { from?: unknown; to?: unknown }
			envelopeFrom = str(envelope.from)
			envelopeTo = Array.isArray(envelope.to)
				? envelope.to.filter((x): x is string => typeof x === 'string')
				: undefined
		} catch {
			// fall back to headers
		}
	}
	const raw = f('email')
	if (raw) {
		const message = await parseRawEmail(raw)
		return finish('sendgrid', message, { from: envelopeFrom, to: envelopeTo }, message.messageId)
	}
	const headerPairs = parseHeaderBlock(f('headers') ?? '')
	const header = (name: string) => headerPairs.find(([k]) => k.toLowerCase() === name)?.[1]
	const from = parseSingleAddress(f('from') ?? header('from'))
	if (!from) throw new KodyError('invalid_email_payload', 'SendGrid payload has no from.')
	const inlineIds = new Map<string, string>()
	const info = f('attachment-info')
	if (info) {
		try {
			for (const [field, meta] of Object.entries(JSON.parse(info) as Record<string, { 'content-id'?: string }>)) {
				if (meta['content-id']) inlineIds.set(field, stripAngle(meta['content-id']) ?? meta['content-id'])
			}
		} catch {
			// ignore malformed info
		}
	}
	const message: NormalizedEmail = {
		from,
		to: parseAddressList(f('to') ?? header('to')),
		cc: parseAddressList(f('cc') ?? header('cc')),
		replyTo: parseAddressList(header('reply-to')),
		subject: cleanSubject(f('subject') ?? header('subject') ?? ''),
		messageId: stripAngle(header('message-id')),
		inReplyTo: stripAngle(header('in-reply-to')),
		references: parseReferences(header('references')),
		date: header('date') ?? null,
		text: cleanBody(f('text')),
		html: cleanBody(f('html')),
		headers: pickSafeHeaders(headerPairs),
		attachments: attachmentsFromFiles(form.files, inlineIds),
	}
	return finish('sendgrid', message, { from: envelopeFrom, to: envelopeTo }, message.messageId)
}

/**
 * Raw RFC 5322 bytes (`message/rfc822`) with the SMTP envelope in
 * `x-kody-envelope-from` / `x-kody-envelope-to` headers. Used by the Cloudflare
 * Email Worker forwarder (examples/cloudflare-email-forwarder) and the
 * mail-bridge sidecar; `generic` accepts it too.
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
		case 'postmark':
			return normalizePostmark(payload)
		case 'mailgun':
			return normalizeMailgun(payload)
		case 'sendgrid':
			return normalizeSendgrid(payload)
		case 'cloudflare':
		case 'bridge':
			return normalizeRaw(provider, payload)
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
