import type { EmailAddress, EmailAttachmentMeta } from '../cells/user-cell.ts'
import { KodyError } from '../lib/errors.ts'
import type { OutboundConfig } from './config.ts'

export type OutboundAttachment = EmailAttachmentMeta & { contentBase64: string }

export type OutboundMessage = {
	from: EmailAddress
	to: Array<EmailAddress>
	cc: Array<EmailAddress>
	replyTo: Array<EmailAddress>
	subject: string
	text: string | null
	html: string | null
	headers: Record<string, string>
	inReplyTo: string | null
	references: Array<string>
	attachments: Array<OutboundAttachment>
}

export type OutboundRequest = {
	url: string
	method: 'POST'
	headers: Record<string, string>
	body: string | FormData
}

export type SendResult = {
	provider: OutboundConfig['provider']
	providerMessageId: string | null
	status: 'queued' | 'sent'
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Headers a package may set on outbound mail; anything else is dropped. */
export const allowedOutboundHeaders = new Set([
	'x-entity-ref-id',
	'x-kody-tag',
	'list-unsubscribe',
	'precedence',
	'auto-submitted',
])

function customHeaders(message: OutboundMessage): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [name, value] of Object.entries(message.headers)) {
		const key = name.toLowerCase()
		if (allowedOutboundHeaders.has(key)) out[key] = value
	}
	if (message.inReplyTo) out['in-reply-to'] = `<${message.inReplyTo}>`
	if (message.references.length > 0) out['references'] = message.references.map((id) => `<${id}>`).join(' ')
	return out
}

/** Builds the mail-bridge HTTP request. Pure so it can be unit-tested without network. */
export function buildOutboundRequest(config: OutboundConfig, message: OutboundMessage): OutboundRequest {
	const headers = customHeaders(message)
	switch (config.provider) {
		case 'bridge':
			return {
				url: `${config.baseUrl}/send`,
				method: 'POST',
				headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					from: message.from,
					to: message.to,
					cc: message.cc,
					replyTo: message.replyTo,
					subject: message.subject,
					text: message.text,
					html: message.html,
					headers,
					attachments: message.attachments.map((a) => ({
						filename: a.filename,
						contentType: a.contentType,
						contentBase64: a.contentBase64,
						contentId: a.contentId,
						disposition: a.disposition,
					})),
				}),
			}
		default: {
			const _exhaustive: never = config.provider
			throw new Error(`Unhandled outbound provider: ${String(_exhaustive)}`)
		}
	}
}

/** Extracts the provider's message id from a successful response. */
export function parseSendResponse(
	provider: OutboundConfig['provider'],
	status: number,
	_headers: Headers,
	bodyText: string,
): SendResult {
	let body: Record<string, unknown> = {}
	if (bodyText.trim().startsWith('{')) {
		try {
			body = JSON.parse(bodyText) as Record<string, unknown>
		} catch {
			body = {}
		}
	}
	const idFrom = (value: unknown) => (typeof value === 'string' && value ? value.replace(/^<|>$/g, '') : null)
	switch (provider) {
		case 'bridge':
			return { provider, providerMessageId: idFrom(body.messageId), status: status === 202 ? 'queued' : 'sent' }
		default: {
			const _exhaustive: never = provider
			throw new Error(`Unhandled outbound provider: ${String(_exhaustive)}`)
		}
	}
}

export async function sendOutbound(
	config: OutboundConfig,
	message: OutboundMessage,
	fetchImpl: FetchLike = fetch,
): Promise<SendResult> {
	const request = buildOutboundRequest(config, message)
	let response: Response
	try {
		response = await fetchImpl(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal: AbortSignal.timeout(config.timeoutMs),
		})
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new KodyError('email_provider_error', `${config.provider}: request failed: ${reason}`, { status: 502 })
	}
	const text = await response.text()
	if (!response.ok) {
		throw new KodyError(
			'email_provider_error',
			`${config.provider}: responded ${response.status}: ${text.slice(0, 300)}`,
			{ status: 502 },
		)
	}
	return parseSendResponse(config.provider, response.status, response.headers, text)
}
