import { KodyError } from '../lib/errors.ts'
import { normalizeSecretHost } from '../secrets/host-policy.ts'

// OAuth 2.0 / 2.1 plumbing shared by the connect routes and the UserCell.
// Pure functions only: no storage, no fetch, so they run under node --test.

export const oauthFlows = ['authorization_code', 'client_credentials'] as const
export type OAuthFlow = (typeof oauthFlows)[number]

/** How the client id/secret reach the token endpoint. */
export const tokenAuthStyles = ['body', 'basic'] as const
export type TokenAuthStyle = (typeof tokenAuthStyles)[number]

export const integrationNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
export const maxScopes = 64
export const maxAllowedHosts = 32
export const maxAuthorizeParams = 16
/** Refresh this long before `expires_at` so in-flight requests do not race the expiry. */
export const tokenExpirySkewMs = 60_000
/** A connect link must be opened within this window. */
export const connectTicketTtlMs = 15 * 60_000

export type IntegrationUsage = { mode: 'any' } | { mode: 'packages'; packages: Array<string> }

export type IntegrationConfig = {
	name: string
	provider: string
	description: string | null
	flow: OAuthFlow
	authorizeUrl: string | null
	tokenUrl: string
	clientId: string
	tokenAuthStyle: TokenAuthStyle
	scopes: Array<string>
	scopeSeparator: string
	authorizeParams: Record<string, string>
	allowedHosts: Array<string>
	usage: IntegrationUsage
}

export type TokenResponse = {
	accessToken: string
	refreshToken: string | null
	tokenType: string
	expiresAt: string | null
	scope: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireHttpUrl(value: unknown, label: string) {
	if (typeof value !== 'string' || !value.trim()) throw new KodyError('invalid_args', `${label} is required.`)
	let url: URL
	try {
		url = new URL(value.trim())
	} catch {
		throw new KodyError('invalid_args', `${label} must be an absolute URL.`)
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new KodyError('invalid_args', `${label} must use http(s).`)
	}
	if (url.username || url.password) throw new KodyError('invalid_args', `${label} must not embed credentials.`)
	if (url.hash) throw new KodyError('invalid_args', `${label} must not contain a fragment.`)
	return url.toString()
}

/**
 * Validates the caller-supplied OAuth app + connection description. The client
 * secret is handled separately (encrypted, never part of the returned config).
 */
export function parseIntegrationConfig(raw: Record<string, unknown>): IntegrationConfig {
	const name = typeof raw.name === 'string' ? raw.name.trim() : ''
	if (!integrationNamePattern.test(name)) {
		throw new KodyError('invalid_args', 'name must be 1-64 chars: letters, digits, ".", "_", "-".')
	}
	const provider = typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim().slice(0, 64) : name
	const flow: OAuthFlow = raw.flow === undefined ? 'authorization_code' : (raw.flow as OAuthFlow)
	if (!oauthFlows.includes(flow)) {
		throw new KodyError('invalid_args', `flow must be one of: ${oauthFlows.join(', ')}.`)
	}
	const tokenUrl = requireHttpUrl(raw.tokenUrl, 'tokenUrl')
	const authorizeUrl = flow === 'authorization_code' ? requireHttpUrl(raw.authorizeUrl, 'authorizeUrl') : null
	const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : ''
	if (!clientId || clientId.length > 512) throw new KodyError('invalid_args', 'clientId is required (max 512 chars).')
	const tokenAuthStyle: TokenAuthStyle =
		raw.tokenAuthStyle === undefined ? 'body' : (raw.tokenAuthStyle as TokenAuthStyle)
	if (!tokenAuthStyles.includes(tokenAuthStyle)) {
		throw new KodyError('invalid_args', `tokenAuthStyle must be one of: ${tokenAuthStyles.join(', ')}.`)
	}

	const scopes = parseScopes(raw.scopes)
	const scopeSeparator = raw.scopeSeparator === ',' ? ',' : ' '
	const authorizeParams: Record<string, string> = {}
	if (raw.authorizeParams !== undefined) {
		if (!isRecord(raw.authorizeParams)) throw new KodyError('invalid_args', 'authorizeParams must be an object.')
		for (const [key, value] of Object.entries(raw.authorizeParams)) {
			if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(key) || value.length > 512) {
				throw new KodyError('invalid_args', `authorizeParams["${key}"] must be a short string.`)
			}
			if (
				['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method'].includes(key)
			) {
				throw new KodyError('invalid_args', `authorizeParams["${key}"] is set by Kody and cannot be overridden.`)
			}
			authorizeParams[key] = value
		}
		if (Object.keys(authorizeParams).length > maxAuthorizeParams) {
			throw new KodyError('invalid_args', `At most ${maxAuthorizeParams} authorizeParams are allowed.`)
		}
	}

	const allowedHosts = new Set<string>()
	if (raw.allowedHosts !== undefined) {
		if (!Array.isArray(raw.allowedHosts)) throw new KodyError('invalid_args', 'allowedHosts must be an array.')
		for (const host of raw.allowedHosts) {
			if (typeof host !== 'string') throw new KodyError('invalid_args', 'allowedHosts entries must be strings.')
			allowedHosts.add(normalizeSecretHost(host))
		}
	}
	if (allowedHosts.size === 0) {
		throw new KodyError(
			'invalid_args',
			'allowedHosts is required: list the API hosts the access token may be sent to (e.g. ["api.github.com"]).',
		)
	}
	if (allowedHosts.size > maxAllowedHosts) {
		throw new KodyError('invalid_args', `At most ${maxAllowedHosts} allowedHosts are allowed.`)
	}

	return {
		name,
		provider,
		description:
			typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 500) : null,
		flow,
		authorizeUrl,
		tokenUrl,
		clientId,
		tokenAuthStyle,
		scopes,
		scopeSeparator,
		authorizeParams,
		allowedHosts: [...allowedHosts],
		usage: parseIntegrationUsage(raw.usage),
	}
}

export function parseScopes(raw: unknown): Array<string> {
	if (raw === undefined || raw === null) return []
	const list = typeof raw === 'string' ? raw.split(/[\s,]+/) : raw
	if (!Array.isArray(list)) throw new KodyError('invalid_args', 'scopes must be an array of strings.')
	const scopes: Array<string> = []
	for (const scope of list) {
		if (typeof scope !== 'string') throw new KodyError('invalid_args', 'scopes must be an array of strings.')
		const trimmed = scope.trim()
		if (!trimmed) continue
		if (trimmed.length > 256 || /\s/.test(trimmed)) throw new KodyError('invalid_args', `Scope "${scope}" is invalid.`)
		if (!scopes.includes(trimmed)) scopes.push(trimmed)
	}
	if (scopes.length > maxScopes) throw new KodyError('invalid_args', `At most ${maxScopes} scopes are allowed.`)
	return scopes
}

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

export function parseIntegrationUsage(raw: unknown): IntegrationUsage {
	if (raw === undefined || raw === null || raw === 'any') return { mode: 'any' }
	if (isRecord(raw) && raw.mode === 'any') return { mode: 'any' }
	const packages = isRecord(raw) && raw.mode === 'packages' ? raw.packages : Array.isArray(raw) ? raw : undefined
	if (!Array.isArray(packages)) {
		throw new KodyError('invalid_args', 'usage must be "any" or { mode: "packages", packages: [...] }.')
	}
	const out: Array<string> = []
	for (const name of packages) {
		if (typeof name !== 'string' || !packageNamePattern.test(name)) {
			throw new KodyError('invalid_args', `usage.packages entry "${String(name)}" is not a package name.`)
		}
		if (!out.includes(name)) out.push(name)
	}
	if (out.length === 0) throw new KodyError('invalid_args', 'usage.packages must list at least one package.')
	return { mode: 'packages', packages: out }
}

/** Ad hoc execute has no package name; a locked integration refuses it. */
export function usagePermits(usage: IntegrationUsage, packageName: string | null) {
	if (usage.mode === 'any') return true
	return packageName !== null && usage.packages.includes(packageName)
}

function base64Url(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function randomUrlSafe(bytes = 32) {
	const buffer = new Uint8Array(bytes)
	crypto.getRandomValues(buffer)
	return base64Url(buffer)
}

export async function pkceChallenge(verifier: string) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	return base64Url(new Uint8Array(digest))
}

export function buildAuthorizeUrl(input: {
	config: IntegrationConfig
	redirectUri: string
	state: string
	codeChallenge: string
}) {
	if (!input.config.authorizeUrl) throw new KodyError('invalid_args', 'This integration has no authorizeUrl.')
	const url = new URL(input.config.authorizeUrl)
	for (const [key, value] of Object.entries(input.config.authorizeParams)) url.searchParams.set(key, value)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', input.config.clientId)
	url.searchParams.set('redirect_uri', input.redirectUri)
	url.searchParams.set('state', input.state)
	url.searchParams.set('code_challenge', input.codeChallenge)
	url.searchParams.set('code_challenge_method', 'S256')
	if (input.config.scopes.length > 0)
		url.searchParams.set('scope', input.config.scopes.join(input.config.scopeSeparator))
	return url.toString()
}

export type TokenGrant =
	| { grantType: 'authorization_code'; code: string; redirectUri: string; codeVerifier: string }
	| { grantType: 'refresh_token'; refreshToken: string }
	| { grantType: 'client_credentials' }

/** Builds the token-endpoint request. `clientSecret` is null for public (PKCE-only) clients. */
export function buildTokenRequest(input: {
	config: IntegrationConfig
	clientSecret: string | null
	grant: TokenGrant
}) {
	const body = new URLSearchParams()
	body.set('grant_type', input.grant.grantType)
	const headers: Record<string, string> = {
		'content-type': 'application/x-www-form-urlencoded',
		accept: 'application/json',
	}
	if (input.grant.grantType === 'authorization_code') {
		body.set('code', input.grant.code)
		body.set('redirect_uri', input.grant.redirectUri)
		body.set('code_verifier', input.grant.codeVerifier)
	} else if (input.grant.grantType === 'refresh_token') {
		body.set('refresh_token', input.grant.refreshToken)
	} else if (input.config.scopes.length > 0) {
		body.set('scope', input.config.scopes.join(input.config.scopeSeparator))
	}
	if (input.config.tokenAuthStyle === 'basic' && input.clientSecret !== null) {
		headers.authorization = `Basic ${btoa(`${encodeURIComponent(input.config.clientId)}:${encodeURIComponent(input.clientSecret)}`)}`
	} else {
		body.set('client_id', input.config.clientId)
		if (input.clientSecret !== null) body.set('client_secret', input.clientSecret)
	}
	return { url: input.config.tokenUrl, method: 'POST', headers, body: body.toString() }
}

/**
 * Normalizes a token response (JSON or form-encoded, as GitHub does without an
 * Accept header). Error payloads become a KodyError whose message carries the
 * provider's `error` code but never token material.
 */
export function parseTokenResponse(input: { status: number; contentType: string | null; body: string; now?: Date }) {
	let payload: Record<string, unknown> | null = null
	const trimmed = input.body.trim()
	if (trimmed.startsWith('{')) {
		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (isRecord(parsed)) payload = parsed
		} catch {
			payload = null
		}
	} else if (trimmed && (input.contentType ?? '').includes('x-www-form-urlencoded')) {
		payload = Object.fromEntries(new URLSearchParams(trimmed))
	} else if (trimmed && !trimmed.startsWith('<') && trimmed.includes('=') && !trimmed.includes(' ')) {
		payload = Object.fromEntries(new URLSearchParams(trimmed))
	}
	const errorCode = payload && typeof payload.error === 'string' ? payload.error : null
	if (input.status >= 400 || errorCode) {
		const description = payload && typeof payload.error_description === 'string' ? payload.error_description : null
		throw new KodyError(
			'oauth_token_error',
			`Token endpoint answered ${input.status}${errorCode ? ` (${errorCode})` : ''}${description ? `: ${description.slice(0, 200)}` : '.'}`,
			{ status: 502, details: { providerStatus: input.status, providerError: errorCode } },
		)
	}
	if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) {
		throw new KodyError('oauth_token_error', 'Token endpoint returned no access_token.', {
			status: 502,
			details: { providerStatus: input.status },
		})
	}
	const now = input.now ?? new Date()
	let expiresAt: string | null = null
	const expiresIn = payload.expires_in
	const seconds = typeof expiresIn === 'number' ? expiresIn : typeof expiresIn === 'string' ? Number(expiresIn) : NaN
	if (Number.isFinite(seconds) && seconds > 0) expiresAt = new Date(now.getTime() + seconds * 1000).toISOString()
	return {
		accessToken: payload.access_token,
		refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token ? payload.refresh_token : null,
		tokenType: typeof payload.token_type === 'string' && payload.token_type ? payload.token_type : 'Bearer',
		expiresAt,
		scope: typeof payload.scope === 'string' ? payload.scope : null,
	} satisfies TokenResponse
}

export function isTokenExpired(expiresAt: string | null, now = new Date()) {
	if (expiresAt === null) return false
	return new Date(expiresAt).getTime() - tokenExpirySkewMs <= now.getTime()
}

/** Connect tickets: `<userId>.<connectId>.<nonce>`; the nonce is hashed at rest. */
export function encodeState(userId: string, connectId: string, nonce: string) {
	return `${userId}.${connectId}.${nonce}`
}

export function decodeState(state: string) {
	const parts = state.split('.')
	if (parts.length !== 3) return null
	const [userId, connectId, nonce] = parts
	if (!userId || !connectId || !nonce) return null
	if (!/^[a-zA-Z0-9_-]+$/.test(userId) || !/^[a-zA-Z0-9_-]+$/.test(connectId) || !/^[a-zA-Z0-9_-]+$/.test(nonce))
		return null
	return { userId, connectId, nonce }
}
