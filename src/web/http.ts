// Request/response helpers shared by the browser routes. Pages themselves are
// rendered by `src/app/render.tsx` (Remix SSR); nothing here builds markup.

import { type AppSession } from '#universal/app-session.ts'
import type { WebSession } from './session.ts'

export function redirect(location: string, headers: HeadersInit = {}) {
	return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...headers } })
}

/** Reads a form post (urlencoded or multipart) into a flat string map. */
export async function readForm(request: Request): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	const type = request.headers.get('content-type') ?? ''
	if (!type.includes('application/x-www-form-urlencoded') && !type.includes('multipart/form-data')) return out
	const data = await request.formData()
	for (const [key, value] of data.entries()) if (typeof value === 'string') out[key] = value
	return out
}

/** Only `/path` continuations are honored so a sign-in link cannot bounce off-site. */
export function safeNext(value: string | null | undefined, fallback = '/account') {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback
	return value
}

/** The shell's view of a signed-in browser session (never the cookie or CSRF token). */
export function appSessionOf(session: WebSession | null, options: { isAdmin?: boolean } = {}): AppSession | null {
	if (!session) return null
	return {
		displayName: session.user.email.split('@')[0] || session.user.email,
		email: session.user.email,
		avatarUrl: null,
		isAdmin: options.isAdmin ?? false,
	}
}
