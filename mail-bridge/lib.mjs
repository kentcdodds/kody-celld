// Pure helpers for the mail bridge (unit-tested without sockets).
import { randomUUID, timingSafeEqual } from 'node:crypto'
import os from 'node:os'

const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export function normalizeAddress(value) {
	return String(value ?? '')
		.trim()
		.replace(/^<|>$/g, '')
		.toLowerCase()
}

export function isEmailAddress(value) {
	return emailPattern.test(value) && value.length <= 320
}

function integer(raw, fallback, min, max) {
	if (raw === undefined || String(raw).trim() === '') return fallback
	const value = Number(raw)
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`Expected an integer between ${min} and ${max}, got "${raw}".`)
	}
	return value
}

/** Reads and validates the bridge configuration from process env. */
export function configFromEnv(env) {
	const required = (name) => {
		const value = env[name]?.trim()
		if (!value) throw new Error(`${name} is required.`)
		return value
	}
	const kodyUrl = required('KODY_URL').replace(/\/+$/, '')
	if (!/^https?:\/\//.test(kodyUrl)) throw new Error('KODY_URL must be an http(s) URL.')
	const domains = required('KODY_EMAIL_DOMAIN')
		.split(',')
		.map((d) => d.trim().toLowerCase())
		.filter(Boolean)
	for (const domain of domains) {
		if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))
			throw new Error(`KODY_EMAIL_DOMAIN: "${domain}" is not a bare domain.`)
	}
	const token = required('MAIL_BRIDGE_TOKEN')
	if (token.length < 16) throw new Error('MAIL_BRIDGE_TOKEN must be at least 16 characters.')
	const smtpUrl = env.MAIL_BRIDGE_SMTP_URL?.trim() || null
	if (smtpUrl && !/^smtps?:\/\//.test(smtpUrl)) {
		throw new Error('MAIL_BRIDGE_SMTP_URL must be an smtp:// or smtps:// URL (user:pass@host:port).')
	}
	return {
		kodyUrl,
		inboundToken: required('KODY_EMAIL_INBOUND_TOKEN'),
		domains,
		token,
		smtpUrl,
		hostname: env.MAIL_BRIDGE_HOSTNAME?.trim() || os.hostname(),
		bind: env.MAIL_BRIDGE_BIND?.trim() || '0.0.0.0',
		smtpPort: integer(env.MAIL_BRIDGE_SMTP_PORT, 25, 1, 65535),
		httpPort: integer(env.MAIL_BRIDGE_HTTP_PORT, 8025, 1, 65535),
		maxBytes: integer(env.MAIL_BRIDGE_MAX_BYTES, 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
		sendTimeoutMs: integer(env.MAIL_BRIDGE_SEND_TIMEOUT_MS, 30_000, 1_000, 300_000),
		kodyTimeoutMs: integer(env.MAIL_BRIDGE_KODY_TIMEOUT_MS, 15_000, 1_000, 120_000),
		tls:
			env.MAIL_BRIDGE_TLS_CERT && env.MAIL_BRIDGE_TLS_KEY
				? { certPath: env.MAIL_BRIDGE_TLS_CERT, keyPath: env.MAIL_BRIDGE_TLS_KEY }
				: null,
		// Mail from the relay's point of view is "sent" once accepted; we report
		// that back to Kody as a delivery event unless disabled.
		reportEvents: env.MAIL_BRIDGE_REPORT_EVENTS !== '0',
	}
}

/** Does this RCPT TO belong to one of our domains? */
export function acceptsRecipient(config, address) {
	const normalized = normalizeAddress(address)
	if (!isEmailAddress(normalized)) return false
	const domain = normalized.slice(normalized.lastIndexOf('@') + 1)
	return config.domains.includes(domain)
}

/** Constant-time bearer check for POST /send. */
export function bearerMatches(header, token) {
	const presented = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? ''
	const a = Buffer.from(presented)
	const b = Buffer.from(token)
	return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/** `Received:` trace header prepended to every forwarded message. */
export function receivedHeader({ clientHostname, remoteAddress, hostname, recipients, now = new Date() }) {
	const client = `${clientHostname || 'unknown'} (${remoteAddress || 'unknown'})`
	const forLine = recipients.length === 1 ? ` for <${recipients[0]}>` : ''
	return `Received: from ${client}\r\n\tby ${hostname} (kody-mail-bridge) with ESMTP${forLine};\r\n\t${now.toUTCString()}\r\n`
}

/** Maps Kody's inbound HTTP response to an SMTP reply the sender understands. */
export function smtpReplyFor(status, body) {
	const detail = typeof body?.message === 'string' ? body.message : ''
	if (status >= 200 && status < 300) return { code: 250, message: 'OK: queued for Kody' }
	if (status === 404) return { code: 550, message: '5.1.1 No such Kody inbox' }
	if (status === 413) return { code: 552, message: '5.3.4 Message too large for Kody' }
	if (status === 429) return { code: 452, message: '4.2.2 Inbox over quota, try later' }
	if (status === 400 || status === 422)
		return { code: 554, message: `5.6.0 Rejected by Kody${detail ? `: ${detail}` : ''}` }
	return { code: 451, message: '4.3.0 Kody is temporarily unavailable, try later' }
}

const headerNamePattern = /^[a-z0-9-]+$/i
const forbiddenOutboundHeaders = new Set([
	'from',
	'to',
	'cc',
	'bcc',
	'subject',
	'date',
	'message-id',
	'content-type',
	'content-transfer-encoding',
	'mime-version',
	'return-path',
	'received',
	'dkim-signature',
])

function addressList(value) {
	if (!Array.isArray(value)) return []
	return value
		.map((entry) => {
			if (typeof entry === 'string') return normalizeAddress(entry)
			if (entry && typeof entry === 'object' && typeof entry.address === 'string') {
				const address = normalizeAddress(entry.address)
				return typeof entry.name === 'string' && entry.name.trim() ? { name: entry.name.trim(), address } : address
			}
			return null
		})
		.filter((entry) => {
			const address = typeof entry === 'string' ? entry : entry?.address
			return address && isEmailAddress(address)
		})
}

/**
 * Turns the JSON body Kody's bridge adapter posts to /send into nodemailer
 * mail options. Throws on anything that would let a caller impersonate another
 * domain or smuggle headers.
 */
export function buildMailOptions(config, body) {
	if (!body || typeof body !== 'object') throw new Error('Body must be a JSON object.')
	const from = addressList([body.from])[0]
	if (!from) throw new Error('from is required.')
	const fromAddress = typeof from === 'string' ? from : from.address
	if (!acceptsRecipient(config, fromAddress)) {
		throw new Error(`from must be an address on ${config.domains.join(', ')}.`)
	}
	const to = addressList(body.to)
	const cc = addressList(body.cc)
	if (to.length + cc.length === 0) throw new Error('At least one recipient is required.')
	if (to.length + cc.length > 50) throw new Error('At most 50 recipients per message.')
	const replyTo = addressList(body.replyTo)
	const subject = typeof body.subject === 'string' ? body.subject.replace(/[\r\n]+/g, ' ').slice(0, 998) : ''
	const headers = {}
	if (body.headers && typeof body.headers === 'object') {
		for (const [name, value] of Object.entries(body.headers)) {
			const key = name.toLowerCase()
			if (!headerNamePattern.test(key) || forbiddenOutboundHeaders.has(key)) continue
			if (typeof value !== 'string' || /[\r\n]/.test(value)) continue
			headers[key] = value.slice(0, 2000)
		}
	}
	const attachments = Array.isArray(body.attachments)
		? body.attachments.map((a, index) => {
				if (!a || typeof a !== 'object' || typeof a.contentBase64 !== 'string') {
					throw new Error(`attachments[${index}] needs contentBase64.`)
				}
				return {
					filename:
						(typeof a.filename === 'string' && a.filename.replace(/[\\/\r\n]/g, '_')) || `attachment-${index + 1}`,
					content: Buffer.from(a.contentBase64, 'base64'),
					...(typeof a.contentType === 'string' ? { contentType: a.contentType } : {}),
					...(typeof a.contentId === 'string' && a.contentId ? { cid: a.contentId } : {}),
					...(a.disposition === 'inline' ? { contentDisposition: 'inline' } : {}),
				}
			})
		: []
	const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1)
	const messageId = `<${randomUUID()}@${domain}>`
	const options = {
		from,
		to,
		subject,
		headers,
		messageId,
		attachments,
		...(cc.length > 0 ? { cc } : {}),
		...(replyTo.length > 0 ? { replyTo } : {}),
		...(typeof body.text === 'string' ? { text: body.text } : {}),
		...(typeof body.html === 'string' ? { html: body.html } : {}),
	}
	if (headers['in-reply-to']) {
		options.inReplyTo = headers['in-reply-to']
		delete headers['in-reply-to']
	}
	if (headers.references) {
		options.references = headers.references
		delete headers.references
	}
	if (options.text === undefined && options.html === undefined) options.text = ''
	return options
}

/** Strips angle brackets so Kody sees the same id it stores. */
export function bareMessageId(messageId) {
	return String(messageId).replace(/^<|>$/g, '')
}
