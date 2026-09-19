import type { EmailAddress, EmailAttachmentMeta } from '../cells/user-cell.ts'
import { KodyError } from '../lib/errors.ts'
import type { OutboundConfig } from './config.ts'
import { formatAddress, stripAngle } from './message.ts'

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

function toBlob(attachment: OutboundAttachment) {
	const binary = atob(attachment.contentBase64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return new Blob([bytes], { type: attachment.contentType })
}

/** Builds the provider HTTP request. Pure so it can be unit-tested without network. */
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
		case 'resend':
			return {
				url: `${config.baseUrl}/emails`,
				method: 'POST',
				headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					from: formatAddress(message.from),
					to: message.to.map(formatAddress),
					...(message.cc.length ? { cc: message.cc.map(formatAddress) } : {}),
					...(message.replyTo.length ? { reply_to: message.replyTo.map(formatAddress) } : {}),
					subject: message.subject,
					...(message.text !== null ? { text: message.text } : {}),
					...(message.html !== null ? { html: message.html } : {}),
					...(Object.keys(headers).length ? { headers } : {}),
					...(message.attachments.length
						? {
								attachments: message.attachments.map((a) => ({
									filename: a.filename,
									content: a.contentBase64,
									content_type: a.contentType,
									...(a.contentId ? { content_id: a.contentId } : {}),
								})),
							}
						: {}),
				}),
			}
		case 'postmark':
			return {
				url: `${config.baseUrl}/email`,
				method: 'POST',
				headers: {
					'x-postmark-server-token': config.token,
					'content-type': 'application/json',
					accept: 'application/json',
				},
				body: JSON.stringify({
					From: formatAddress(message.from),
					To: message.to.map(formatAddress).join(', '),
					...(message.cc.length ? { Cc: message.cc.map(formatAddress).join(', ') } : {}),
					...(message.replyTo.length ? { ReplyTo: message.replyTo.map(formatAddress).join(', ') } : {}),
					Subject: message.subject,
					...(message.text !== null ? { TextBody: message.text } : {}),
					...(message.html !== null ? { HtmlBody: message.html } : {}),
					...(Object.keys(headers).length
						? { Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })) }
						: {}),
					...(message.attachments.length
						? {
								Attachments: message.attachments.map((a) => ({
									Name: a.filename,
									Content: a.contentBase64,
									ContentType: a.contentType,
									...(a.contentId ? { ContentID: `cid:${a.contentId}` } : {}),
								})),
							}
						: {}),
					MessageStream: 'outbound',
				}),
			}
		case 'mailgun': {
			const form = new FormData()
			form.set('from', formatAddress(message.from))
			for (const to of message.to) form.append('to', formatAddress(to))
			for (const cc of message.cc) form.append('cc', formatAddress(cc))
			if (message.replyTo.length) form.set('h:Reply-To', message.replyTo.map(formatAddress).join(', '))
			form.set('subject', message.subject)
			if (message.text !== null) form.set('text', message.text)
			if (message.html !== null) form.set('html', message.html)
			for (const [name, value] of Object.entries(headers)) form.set(`h:${name}`, value)
			for (const a of message.attachments) {
				form.append(a.disposition === 'inline' ? 'inline' : 'attachment', toBlob(a), a.filename)
			}
			return {
				url: `${config.baseUrl}/v3/${config.mailgunDomain}/messages`,
				method: 'POST',
				headers: { authorization: `Basic ${btoa(`api:${config.token}`)}` },
				body: form,
			}
		}
		case 'sendgrid': {
			const personalization: Record<string, unknown> = { to: message.to.map(sgAddress) }
			if (message.cc.length) personalization.cc = message.cc.map(sgAddress)
			const content: Array<{ type: string; value: string }> = []
			if (message.text !== null) content.push({ type: 'text/plain', value: message.text })
			if (message.html !== null) content.push({ type: 'text/html', value: message.html })
			return {
				url: `${config.baseUrl}/v3/mail/send`,
				method: 'POST',
				headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					personalizations: [personalization],
					from: sgAddress(message.from),
					...(message.replyTo[0] ? { reply_to: sgAddress(message.replyTo[0]) } : {}),
					subject: message.subject,
					content,
					...(Object.keys(headers).length ? { headers } : {}),
					...(message.attachments.length
						? {
								attachments: message.attachments.map((a) => ({
									content: a.contentBase64,
									filename: a.filename,
									type: a.contentType,
									disposition: a.disposition,
									...(a.contentId ? { content_id: a.contentId } : {}),
								})),
							}
						: {}),
				}),
			}
		}
	}
}

function sgAddress(address: EmailAddress) {
	return address.name ? { email: address.address, name: address.name } : { email: address.address }
}

/** Extracts the provider's message id from a successful response. */
export function parseSendResponse(
	provider: OutboundConfig['provider'],
	status: number,
	headers: Headers,
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
	const idFrom = (value: unknown) => (typeof value === 'string' && value ? stripAngle(value) : null)
	switch (provider) {
		case 'bridge':
			return { provider, providerMessageId: idFrom(body.messageId), status: status === 202 ? 'queued' : 'sent' }
		case 'resend':
			return { provider, providerMessageId: idFrom(body.id), status: 'queued' }
		case 'postmark':
			return { provider, providerMessageId: idFrom(body.MessageID), status: 'queued' }
		case 'mailgun':
			return { provider, providerMessageId: idFrom(body.id), status: 'queued' }
		case 'sendgrid':
			return { provider, providerMessageId: idFrom(headers.get('x-message-id')), status: 'queued' }
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
			{
				status: 502,
			},
		)
	}
	return parseSendResponse(config.provider, response.status, response.headers, text)
}
