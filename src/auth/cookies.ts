import { KodyError } from '../lib/errors.ts'

export const sessionCookieName = 'kody_session'
export const consoleCookieName = 'kody_console'
export const sessionTtlMs = 30 * 24 * 60 * 60 * 1000
export const consoleSessionTtlMs = 12 * 60 * 60 * 1000

export function parseCookies(header: string | null): Record<string, string> {
	const out: Record<string, string> = {}
	if (!header) return out
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq === -1) continue
		const name = part.slice(0, eq).trim()
		if (!name) continue
		try {
			out[name] = decodeURIComponent(part.slice(eq + 1).trim())
		} catch {
			out[name] = part.slice(eq + 1).trim()
		}
	}
	return out
}

export function serializeCookie(
	name: string,
	value: string,
	options: { maxAgeSeconds: number; secure: boolean; path?: string },
) {
	const parts = [
		`${name}=${encodeURIComponent(value)}`,
		`Path=${options.path ?? '/'}`,
		`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
		'HttpOnly',
		'SameSite=Lax',
	]
	if (options.secure) parts.push('Secure')
	return parts.join('; ')
}

export function clearCookie(name: string, secure: boolean) {
	return serializeCookie(name, '', { maxAgeSeconds: 0, secure })
}

/** Cookies carry `Secure` whenever the public URL is https; loopback dev stays plain http. */
export function cookiesAreSecure(publicUrl: string) {
	try {
		return new URL(publicUrl).protocol === 'https:'
	} catch {
		return false
	}
}

/**
 * Browser form posts must come from our own origin. `Sec-Fetch-Site` covers
 * modern browsers; `Origin` covers the rest. Requests with neither header
 * (curl, scripts) are allowed through because they cannot carry an ambient
 * cookie from a third-party page.
 */
export function assertSameOrigin(request: Request, publicUrl: string) {
	const fetchSite = request.headers.get('sec-fetch-site')
	if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
		throw new KodyError('cross_site_request', 'Cross-site form submissions are refused.', { status: 403 })
	}
	const origin = request.headers.get('origin')
	if (!origin || origin === 'null') return
	const allowed = new Set([new URL(publicUrl).origin, new URL(request.url).origin])
	if (!allowed.has(origin)) {
		throw new KodyError('cross_site_request', 'Cross-site form submissions are refused.', { status: 403 })
	}
}

/**
 * Same-site form posts still get a per-session CSRF token so a `SameSite=Lax`
 * gap (top-level navigations) or a permissive proxy cannot replay a form.
 */
export async function csrfToken(masterKey: string, sessionId: string) {
	return sessionSignature(masterKey, sessionId, 'csrf', '')
}

/**
 * HMAC over `payload`, keyed by the server master key and bound to one browser
 * session and one purpose. Used to make hidden form state (e.g. the pending
 * OAuth authorization request shown on the consent page) tamper-evident
 * without server-side storage.
 */
export async function sessionSignature(masterKey: string, sessionId: string, purpose: string, payload: string) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(masterKey),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const sig = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`kody-celld:${purpose}:${sessionId}:${payload.length}:${payload}`),
	)
	return Array.from(new Uint8Array(sig).slice(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')
}
