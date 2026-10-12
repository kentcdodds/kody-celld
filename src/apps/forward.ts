// What crosses between the app origin and package code. Kody credentials and
// host-internal headers never reach the app; the app cannot set Kody cookies.

export const appSessionCookieName = 'kody_app_session'
export const appStateCookieName = 'kody_app_state'
export const handoffParam = '__kody_handoff'
export const appContextHeader = 'x-kody-app-context'

const kodyCookieNames = new Set([appSessionCookieName, appStateCookieName, 'kody_session', 'kody_console'])

export type AppPackageContext = {
	packageName: string
	version: string
	hostedUrl: string
	appBasePath: string
	assetBasePath: string
}

export type AppRequestContext = { runId: string; packageContext: AppPackageContext }

function cookieName(pair: string) {
	const eq = pair.indexOf('=')
	return (eq === -1 ? pair : pair.slice(0, eq)).trim()
}

/** The query string without `__kody_handoff`; untouched (byte-for-byte) when the param is absent. */
export function searchWithoutHandoff(url: URL) {
	if (!url.searchParams.has(handoffParam)) return url.search
	const params = new URLSearchParams(url.search)
	params.delete(handoffParam)
	const search = params.toString()
	return search ? `?${search}` : ''
}

export function cookieHeaderWithoutKody(header: string | null): string | null {
	if (!header) return null
	const kept = header
		.split(';')
		.map((pair) => pair.trim())
		.filter((pair) => pair !== '' && !kodyCookieNames.has(cookieName(pair)))
	return kept.length > 0 ? kept.join('; ') : null
}

/** The Request the package's fetch handler sees: mount stripped, credentials removed, context attached. */
export function buildAppRequest(
	request: Request,
	input: { origin: string; restPath: string; context: AppRequestContext },
): Request {
	const target = new URL(`${input.origin}${input.restPath}${searchWithoutHandoff(new URL(request.url))}`)
	const headers = new Headers(request.headers)
	for (const name of [...headers.keys()]) if (name.startsWith('x-kody-')) headers.delete(name)
	const cookie = cookieHeaderWithoutKody(request.headers.get('cookie'))
	if (cookie) headers.set('cookie', cookie)
	else headers.delete('cookie')
	headers.set(appContextHeader, JSON.stringify(input.context))
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	return new Request(target, {
		method: request.method,
		headers,
		redirect: 'manual',
		...(hasBody ? { body: request.body, duplex: 'half' } : {}),
	} as RequestInit)
}

export function sanitizeAppResponse(response: Response): Response {
	const headers = new Headers()
	for (const [name, value] of response.headers) {
		if (name === 'set-cookie' || name.startsWith('x-kody-')) continue
		headers.append(name, value)
	}
	for (const cookie of response.headers.getSetCookie()) {
		if (!kodyCookieNames.has(cookieName(cookie.split(';')[0] ?? ''))) headers.append('set-cookie', cookie)
	}
	headers.set('x-content-type-options', 'nosniff')
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
