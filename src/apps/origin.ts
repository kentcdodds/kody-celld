import { readCookie, serializeCookie } from '../auth/cookies.ts'
import type { UserRecord } from '../cells/registry-cell.ts'
import { type AppOriginConfig, type AppRequestMatch, matchAppRequest } from './app-url.ts'
import { appSessionCookieName, appStateCookieName, handoffParam, searchWithoutHandoff } from './forward.ts'
import { appNotFoundPage, openFromKodyPage } from './pages.ts'
import { appSessionMaxMs, consumeHandoff, newAppState, signAppSession, verifyAppSession } from './tokens.ts'

export type AppTarget = Extract<AppRequestMatch, { kind: 'app' }>

export type AppOriginDeps = {
	config: AppOriginConfig
	masterKey: string
	/** KODY_PUBLIC_URL without a trailing slash. */
	publicUrl: string
	burnHandoff(jti: string, expiresAtMs: number): Promise<boolean>
	sessionAlive(userId: string, sessionId: string): Promise<boolean>
	getUser(userId: string): Promise<UserRecord | null>
	serve(request: Request, target: AppTarget, user: UserRecord): Promise<Response>
	now?: () => number
}

export const appStateMaxAgeSeconds = 300

function plain(status: number, message: string) {
	return new Response(message, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
	})
}

/**
 * Everything on the app origin. Owner-only: a request is served only with a
 * valid `kody_app_session` for the URL's user whose parent Kody session is
 * still alive. A `__kody_handoff` is swapped for that cookie (only in the
 * browser that holds the matching `kody_app_state`) and removed from the URL
 * before anything else sees it.
 */
export async function handleAppOriginRequest(request: Request, url: URL, deps: AppOriginDeps): Promise<Response> {
	const match = matchAppRequest(deps.config, url)
	if (!match || match.kind === 'not-found') return appNotFoundPage()
	if (match.kind === 'root') {
		return new Response(null, { status: 302, headers: { location: `${deps.publicUrl}/`, 'cache-control': 'no-store' } })
	}
	const safeMethod = request.method === 'GET' || request.method === 'HEAD'
	// Sibling apps are same-site; CORS would block their reads, not their side effects.
	if (!safeMethod) {
		const origin = request.headers.get('origin')
		const site = request.headers.get('sec-fetch-site')
		if (
			(origin !== null && origin !== `${deps.config.protocol}//${url.host}`) ||
			(site !== null && site !== 'same-origin')
		) {
			return plain(403, 'Cross-origin mutating requests to a package app are not allowed.')
		}
	}
	const now = deps.now?.() ?? Date.now()
	const cookieOptions = {
		secure: deps.config.protocol === 'https:',
		path: deps.config.mode === 'path' ? `/u/${match.userId}/` : '/',
	}
	const token = url.searchParams.get(handoffParam)
	if (token) {
		const state = (await readCookie(request, appStateCookieName)) ?? ''
		const result = await consumeHandoff({
			masterKey: deps.masterKey,
			token,
			expected: { uid: match.userId, pkg: match.packageName, st: state },
			burn: deps.burnHandoff,
			now,
		})
		if (result.ok) {
			const value = await signAppSession(deps.masterKey, {
				uid: result.claims.uid,
				sid: result.claims.sid,
				exp: now + appSessionMaxMs,
			})
			const headers = new Headers({
				location: `${deps.config.protocol}//${url.host}${url.pathname}${searchWithoutHandoff(url)}`,
				'cache-control': 'no-store',
			})
			headers.append(
				'set-cookie',
				await serializeCookie(appSessionCookieName, value, { ...cookieOptions, maxAgeSeconds: appSessionMaxMs / 1000 }),
			)
			headers.append(
				'set-cookie',
				await serializeCookie(appStateCookieName, '', { ...cookieOptions, maxAgeSeconds: 0 }),
			)
			return new Response(null, { status: 302, headers })
		}
		console.warn('[kody-celld] package-app handoff rejected', { reason: result.reason })
	}
	const raw = await readCookie(request, appSessionCookieName)
	const claims = raw ? await verifyAppSession(deps.masterKey, raw, now) : null
	if (!claims || claims.uid !== match.userId || !(await deps.sessionAlive(claims.uid, claims.sid))) {
		// A failed handoff must not loop back to Kody; only a plain navigation starts the dance.
		if (!safeMethod || token) return openFromKodyPage(deps.publicUrl, match.packageName)
		const state = newAppState()
		const headers = new Headers({
			location: `${deps.publicUrl}/apps/open?package=${encodeURIComponent(match.packageName)}&state=${state}`,
			'cache-control': 'no-store',
		})
		headers.append(
			'set-cookie',
			await serializeCookie(appStateCookieName, state, { ...cookieOptions, maxAgeSeconds: appStateMaxAgeSeconds }),
		)
		return new Response(null, { status: 302, headers })
	}
	const user = await deps.getUser(claims.uid)
	if (!user) return openFromKodyPage(deps.publicUrl, match.packageName)
	return deps.serve(request, match, user)
}
