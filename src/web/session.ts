import type { SessionRecord } from '../auth/account-store.ts'
import {
	assertSameOrigin,
	clearCookie,
	consoleCookieName,
	consoleSessionTtlMs,
	cookiesAreSecure,
	csrfToken,
	parseCookies,
	serializeCookie,
	sessionCookieName,
	sessionTtlMs,
} from '../auth/cookies.ts'
import type { UserRecord } from '../cells/registry-cell.ts'
import type { Env } from '../env.ts'
import { sha256Hex } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { constantTimeEqualString } from '../auth/password.ts'

export type WebSession = {
	user: UserRecord
	session: SessionRecord
	csrf: string
}

const registry = (env: Env) => env.REGISTRY.getByName('registry')

export async function readWebSession(request: Request, env: Env): Promise<WebSession | null> {
	const raw = parseCookies(request.headers.get('cookie'))[sessionCookieName]
	if (!raw) return null
	const resolved = await registry(env).sessionResolve(raw, sessionTtlMs)
	if (!resolved) return null
	return {
		user: resolved.user,
		session: resolved.session,
		csrf: await csrfToken(env.KODY_MASTER_KEY, resolved.session.id),
	}
}

/** Returns the `Set-Cookie` value for a fresh browser session. */
export async function startWebSession(request: Request, env: Env, userId: string) {
	const created = await registry(env).sessionCreate({
		userId,
		ttlMs: sessionTtlMs,
		userAgent: request.headers.get('user-agent'),
	})
	return serializeCookie(sessionCookieName, created.id, {
		maxAgeSeconds: sessionTtlMs / 1000,
		secure: cookiesAreSecure(env.KODY_PUBLIC_URL),
	})
}

export async function endWebSession(request: Request, env: Env) {
	const raw = parseCookies(request.headers.get('cookie'))[sessionCookieName]
	if (raw) await registry(env).sessionDelete(raw)
	return clearCookie(sessionCookieName, cookiesAreSecure(env.KODY_PUBLIC_URL))
}

/** Every state-changing browser form: same-origin headers plus the session's CSRF token. */
export function assertCsrf(request: Request, env: Env, session: { csrf: string }, form: Record<string, string>) {
	assertSameOrigin(request, env.KODY_PUBLIC_URL)
	if (!form.csrf || !constantTimeEqualString(form.csrf, session.csrf)) {
		throw new KodyError('csrf_mismatch', 'This form has expired. Reload the page and try again.', { status: 403 })
	}
}

// ------------------------------------------------------------ admin console

async function consoleSignature(env: Env, expiresAt: number) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(env.KODY_MASTER_KEY),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const adminHash = await sha256Hex(env.KODY_ADMIN_TOKEN)
	const sig = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`kody-celld:console:${adminHash}:${expiresAt}`),
	)
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The admin console is a stateless signed cookie bound to both the master key
 * and the admin token, so rotating either signs every console out.
 */
export async function startConsoleSession(env: Env) {
	const expiresAt = Date.now() + consoleSessionTtlMs
	const value = `${expiresAt}.${await consoleSignature(env, expiresAt)}`
	return serializeCookie(consoleCookieName, value, {
		maxAgeSeconds: consoleSessionTtlMs / 1000,
		secure: cookiesAreSecure(env.KODY_PUBLIC_URL),
		path: '/console',
	})
}

export function endConsoleSession(env: Env) {
	return serializeCookie(consoleCookieName, '', {
		maxAgeSeconds: 0,
		secure: cookiesAreSecure(env.KODY_PUBLIC_URL),
		path: '/console',
	})
}

export type ConsoleSession = { csrf: string; expiresAt: number }

export async function readConsoleSession(request: Request, env: Env): Promise<ConsoleSession | null> {
	const raw = parseCookies(request.headers.get('cookie'))[consoleCookieName]
	if (!raw) return null
	const [expiresRaw, signature] = raw.split('.')
	const expiresAt = Number(expiresRaw)
	if (!signature || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
	if (!constantTimeEqualString(signature, await consoleSignature(env, expiresAt))) return null
	return { csrf: await csrfToken(env.KODY_MASTER_KEY, `console:${signature}`), expiresAt }
}
