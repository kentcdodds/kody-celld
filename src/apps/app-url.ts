// src/apps/app-url.ts
import { packageNamePattern } from '../packages/manifest.ts'

/**
 * Where package apps live (`KODY_APP_BASE_URL`). Kent's decision on #42: apps
 * get their own origin so installed browser code never rides the owner's
 * Kody session. Path mode puts every user on one app host; subdomain mode
 * gives each user an origin of their own.
 */
export type AppOriginConfig = {
	mode: 'path' | 'subdomain'
	protocol: 'http:' | 'https:'
	/** Path mode: the app host. Subdomain mode: the apex under the wildcard. */
	hostname: string
	/** `''` or `:<port>`. */
	port: string
}

export type AppConfigResult = { ok: true; config: AppOriginConfig; baseUrl: string } | { ok: false; error: string }

export type AppRequestMatch =
	| { kind: 'app'; userId: string; packageName: string; origin: string; mountPath: string; restPath: string }
	| { kind: 'root' }
	| { kind: 'not-found' }

const wildcardPattern = /^(https?):\/\/\*\.(.+)$/i
const userIdPattern = /^user_([0-9a-f]{32})$/
const userLabelPattern = /^user-([0-9a-f]{32})$/
const pathUserIdPattern = /^[A-Za-z0-9_-]{1,64}$/

/** null = package apps are off. A result with `ok: false` keeps them off and explains why. */
export function readAppConfig(env: {
	KODY_APP_BASE_URL?: string | undefined
	KODY_PUBLIC_URL: string
}): AppConfigResult | null {
	const raw = env.KODY_APP_BASE_URL?.trim()
	if (!raw) return null
	const wildcard = wildcardPattern.exec(raw)
	let parsed: URL
	try {
		parsed = new URL(wildcard ? `${wildcard[1]}://${wildcard[2]}` : raw)
	} catch {
		return { ok: false, error: `KODY_APP_BASE_URL "${raw}" is not a URL.` }
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { ok: false, error: 'KODY_APP_BASE_URL must use http or https.' }
	}
	if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
		return { ok: false, error: 'KODY_APP_BASE_URL must be an origin: no path, query, fragment, or credentials.' }
	}
	const config: AppOriginConfig = {
		mode: wildcard ? 'subdomain' : 'path',
		protocol: parsed.protocol,
		hostname: parsed.hostname,
		port: parsed.port ? `:${parsed.port}` : '',
	}
	let publicHostname: string
	try {
		publicHostname = new URL(env.KODY_PUBLIC_URL).hostname
	} catch {
		return { ok: false, error: 'KODY_PUBLIC_URL is not a URL.' }
	}
	// Cookies ignore ports, so "another port on the Kody host" is still the Kody site.
	if (publicHostname === config.hostname) {
		return { ok: false, error: 'KODY_APP_BASE_URL must use a different host than KODY_PUBLIC_URL.' }
	}
	if (config.mode === 'subdomain' && publicHostname.endsWith(`.${config.hostname}`)) {
		return { ok: false, error: `KODY_PUBLIC_URL must not sit under the package-app wildcard *.${config.hostname}.` }
	}
	const baseUrl = `${config.protocol}//${wildcard ? '*.' : ''}${config.hostname}${config.port}`
	return { ok: true, config, baseUrl }
}

/** Any request to the app host (any port) belongs to the app origin and never to first-party routes. */
export function isAppOriginHost(config: AppOriginConfig, url: URL) {
	const hostname = url.hostname.toLowerCase()
	if (hostname === config.hostname) return true
	return config.mode === 'subdomain' && hostname.endsWith(`.${config.hostname}`)
}

export function appOrigin(config: AppOriginConfig, userId: string): string | null {
	if (config.mode === 'path') return `${config.protocol}//${config.hostname}${config.port}`
	const match = userIdPattern.exec(userId)
	return match ? `${config.protocol}//user-${match[1]}.${config.hostname}${config.port}` : null
}

export function appMountPath(config: AppOriginConfig, userId: string, packageName: string) {
	return config.mode === 'path' ? `/u/${userId}/packages/${packageName}` : `/packages/${packageName}`
}

/** The app's public mount URL, without a trailing slash (`packageContext.hostedUrl`). */
export function appUrl(config: AppOriginConfig, userId: string, packageName: string): string | null {
	const origin = appOrigin(config, userId)
	return origin ? `${origin}${appMountPath(config, userId, packageName)}` : null
}

export function matchAppRequest(config: AppOriginConfig, url: URL): AppRequestMatch | null {
	if (!isAppOriginHost(config, url)) return null
	const hostname = url.hostname.toLowerCase()
	const origin = `${url.protocol}//${url.host}`
	if (config.mode === 'path') {
		if (url.pathname === '/') return { kind: 'root' }
		const match = /^\/u\/([^/]+)(\/packages\/.*)$/.exec(url.pathname)
		if (!match?.[1] || !match[2] || !pathUserIdPattern.test(match[1])) return { kind: 'not-found' }
		return withPackage(match[1], `/u/${match[1]}`, match[2], origin)
	}
	if (hostname === config.hostname) return url.pathname === '/' ? { kind: 'root' } : { kind: 'not-found' }
	const label = userLabelPattern.exec(hostname.slice(0, -(config.hostname.length + 1)))
	if (!label) return { kind: 'not-found' }
	if (url.pathname === '/') return { kind: 'root' }
	return withPackage(`user_${label[1]}`, '', url.pathname, origin)
}

function withPackage(userId: string, prefix: string, rest: string, origin: string): AppRequestMatch {
	if (!rest.startsWith('/packages/')) return { kind: 'not-found' }
	const segments = rest.slice('/packages/'.length).split('/')
	const take = segments[0]?.startsWith('@') ? 2 : 1
	if (segments.length < take) return { kind: 'not-found' }
	const packageName = segments.slice(0, take).join('/')
	if (!packageNamePattern.test(packageName)) return { kind: 'not-found' }
	const tail = rest.slice(`/packages/${packageName}`.length)
	return {
		kind: 'app',
		userId,
		packageName,
		origin,
		mountPath: `${prefix}/packages/${packageName}`,
		restPath: tail === '' ? '/' : tail,
	}
}
