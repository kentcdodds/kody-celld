import type { WebhookReplay, WebhookVerification } from '../packages/manifest.ts'

/**
 * Pure helpers for inbound webhook verification. The HMAC itself is computed
 * inside the user's cell (the secret never leaves it); these functions decide
 * what to sign and whether a provider's signature header matches the digest.
 */

export type ProvidedSignature = { hex: Array<string>; base64: Array<string> }

function stripPrefix(value: string, prefix: string | undefined) {
	if (!prefix) return value
	return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

/**
 * Extracts candidate signatures from a header. Supports plain values
 * (`sha256=<hex>`), comma-separated lists, and Stripe-style `k=v` pairs
 * (`t=123,v1=<hex>,v1=<hex>`).
 */
export function parseSignatureHeader(raw: string | null, verification: WebhookVerification): Array<string> {
	if (!raw) return []
	const candidates: Array<string> = []
	for (const part of raw.split(',')) {
		const piece = part.trim()
		if (!piece) continue
		const eq = piece.indexOf('=')
		if (eq > 0 && /^[a-z][a-z0-9_-]*$/i.test(piece.slice(0, eq)) && verification.prefix === undefined) {
			const key = piece.slice(0, eq).toLowerCase()
			if (key === 't') continue
			candidates.push(piece.slice(eq + 1).trim())
			continue
		}
		candidates.push(stripPrefix(piece, verification.prefix).trim())
	}
	return candidates.filter(Boolean)
}

export function constantTimeEqual(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

export function signatureMatches(
	candidates: Array<string>,
	digest: { hex: string; base64: string },
	encoding: WebhookVerification['encoding'],
) {
	const expected = encoding === 'hex' ? digest.hex.toLowerCase() : digest.base64
	return candidates.some((candidate) =>
		constantTimeEqual(encoding === 'hex' ? candidate.toLowerCase() : candidate, expected),
	)
}

/** Reads the delivery timestamp per `replay.timestampFormat`; null when missing/unparseable. */
export function parseTimestamp(raw: string | null, format: NonNullable<WebhookReplay['timestampFormat']>): Date | null {
	if (!raw) return null
	let value = raw.trim()
	if (format === 'stripe-signature') {
		const match = /(?:^|,)\s*t=(\d+)/.exec(value)
		if (!match?.[1]) return null
		value = match[1]
		format = 'unix-seconds'
	}
	if (format === 'iso') {
		const date = new Date(value)
		return Number.isNaN(date.getTime()) ? null : date
	}
	if (!/^\d+$/.test(value)) return null
	const number = Number(value)
	if (!Number.isFinite(number)) return null
	return new Date(format === 'unix-millis' ? number : number * 1000)
}

export function withinTolerance(timestamp: Date, now: Date, toleranceSeconds: number) {
	return Math.abs(now.getTime() - timestamp.getTime()) <= toleranceSeconds * 1000
}

/** The exact bytes a provider signed: the body, or `${timestamp}.${body}` (the header's own timestamp token). */
export function signedMessage(
	verification: WebhookVerification,
	body: string,
	timestampRaw: string | null,
	format: NonNullable<WebhookReplay['timestampFormat']> | undefined,
) {
	if (verification.signedPayload === 'body') return body
	if (!timestampRaw) return null
	if (format === 'stripe-signature') {
		const match = /(?:^|,)\s*t=(\d+)/.exec(timestampRaw)
		return match?.[1] ? `${match[1]}.${body}` : null
	}
	return `${timestampRaw.trim()}.${body}`
}
