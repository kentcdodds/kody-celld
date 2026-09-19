import { constantTimeEqualString } from '../auth/password.ts'
import { pkceChallenge } from '../integrations/oauth.ts'
import { KodyError } from '../lib/errors.ts'
import { isLoopbackHost } from '../secrets/host-policy.ts'

/**
 * Kody's MCP authorization server (OAuth 2.1 + RFC 8414/9728/7591/7009/8707).
 * One grant means the full assistant: there is no capability scope menu, the
 * OIDC identity trio is advertised for clients that want to show who signed in.
 */
export const mcpResourcePath = '/mcp'
export const oauthPaths = {
	authorizationServerMetadata: '/.well-known/oauth-authorization-server',
	protectedResourceMetadata: '/.well-known/oauth-protected-resource',
	authorize: '/oauth/authorize',
	token: '/oauth/token',
	register: '/oauth/register',
	revoke: '/oauth/revoke',
} as const

export const oauthScopes = ['openid', 'profile', 'email'] as const
export const codeTtlMs = 10 * 60 * 1000
export const accessTokenTtlSeconds = 60 * 60
export const refreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000
/** Presenting the immediately previous refresh token again inside this window replays the same response. */
export const refreshReplayGraceMs = 60 * 1000
export const maxRedirectUris = 16
export const maxClientNameLength = 120
/** DCR is open (public clients need no credential); cap abandoned registrations. */
export const unusedClientTtlMs = 30 * 24 * 60 * 60 * 1000

export const tokenEndpointAuthMethods = ['none', 'client_secret_post', 'client_secret_basic'] as const
export type TokenEndpointAuthMethod = (typeof tokenEndpointAuthMethods)[number]

export function authorizationServerMetadata(issuer: string) {
	return {
		issuer,
		authorization_endpoint: `${issuer}${oauthPaths.authorize}`,
		token_endpoint: `${issuer}${oauthPaths.token}`,
		registration_endpoint: `${issuer}${oauthPaths.register}`,
		revocation_endpoint: `${issuer}${oauthPaths.revoke}`,
		scopes_supported: [...oauthScopes],
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: [...tokenEndpointAuthMethods],
		revocation_endpoint_auth_methods_supported: [...tokenEndpointAuthMethods],
		code_challenge_methods_supported: ['S256'],
		service_documentation: 'https://github.com/kentcdodds/kody-celld/blob/main/docs/mcp-oauth.md',
	}
}

export function protectedResourceMetadata(issuer: string) {
	return {
		resource: `${issuer}${mcpResourcePath}`,
		authorization_servers: [issuer],
		scopes_supported: [...oauthScopes],
		bearer_methods_supported: ['header'],
		resource_documentation: 'https://github.com/kentcdodds/kody-celld/blob/main/docs/mcp-oauth.md',
	}
}

/**
 * RFC 6749 §5.2 error; `code` is the OAuth error code. Extends KodyError so
 * the code/status survive the RegistryCell RPC hop (see lib/errors.ts).
 */
export class OAuthProtocolError extends KodyError {
	constructor(code: string, description: string, status = 400) {
		super(code, description, { status })
	}
}

export function oauthErrorBody(error: unknown) {
	const kody = KodyError.fromUnknown(error)
	if (kody) return { status: kody.status, body: { error: kody.code, error_description: kody.message } }
	return {
		status: 500,
		body: { error: 'server_error', error_description: error instanceof Error ? error.message : String(error) },
	}
}

export type ClientRegistration = {
	clientName: string
	redirectUris: Array<string>
	tokenEndpointAuthMethod: TokenEndpointAuthMethod
	grantTypes: Array<'authorization_code' | 'refresh_token'>
	clientUri: string | null
	logoUri: string | null
	softwareId: string | null
	softwareVersion: string | null
}

function readString(value: unknown, field: string, max = 512) {
	if (value === undefined || value === null) return null
	if (typeof value !== 'string') {
		throw new OAuthProtocolError('invalid_client_metadata', `"${field}" must be a string.`)
	}
	return value.slice(0, max)
}

function readHttpUrl(value: unknown, field: string) {
	const raw = readString(value, field)
	if (!raw) return null
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new OAuthProtocolError('invalid_client_metadata', `"${field}" must be an absolute URL.`)
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new OAuthProtocolError('invalid_client_metadata', `"${field}" must be http(s).`)
	}
	return url.toString()
}

/**
 * RFC 7591 metadata → registration. Redirect URIs must be absolute and
 * fragment-free; http is only allowed for loopback (RFC 8252) — everything
 * else needs https or a private-use scheme (`myapp:/callback`).
 */
export function parseClientRegistration(body: unknown): ClientRegistration {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw new OAuthProtocolError('invalid_client_metadata', 'Client metadata must be a JSON object.')
	}
	const meta = body as Record<string, unknown>
	if (!Array.isArray(meta.redirect_uris) || meta.redirect_uris.length === 0) {
		throw new OAuthProtocolError('invalid_redirect_uri', 'At least one redirect_uri is required.')
	}
	if (meta.redirect_uris.length > maxRedirectUris) {
		throw new OAuthProtocolError('invalid_redirect_uri', `At most ${maxRedirectUris} redirect_uris.`)
	}
	const redirectUris = meta.redirect_uris.map((entry) => validateRedirectUri(entry))

	const method = meta.token_endpoint_auth_method ?? 'none'
	if (!tokenEndpointAuthMethods.includes(method as TokenEndpointAuthMethod)) {
		throw new OAuthProtocolError(
			'invalid_client_metadata',
			`token_endpoint_auth_method must be one of ${tokenEndpointAuthMethods.join(', ')}.`,
		)
	}
	const grantTypes = Array.isArray(meta.grant_types) ? meta.grant_types : ['authorization_code', 'refresh_token']
	for (const grant of grantTypes) {
		if (grant !== 'authorization_code' && grant !== 'refresh_token') {
			throw new OAuthProtocolError('invalid_client_metadata', `Unsupported grant_type "${String(grant)}".`)
		}
	}
	if (!grantTypes.includes('authorization_code')) {
		throw new OAuthProtocolError('invalid_client_metadata', 'grant_types must include authorization_code.')
	}
	const responseTypes = Array.isArray(meta.response_types) ? meta.response_types : ['code']
	if (responseTypes.some((type) => type !== 'code')) {
		throw new OAuthProtocolError('invalid_client_metadata', 'Only response_type "code" is supported.')
	}
	const clientName = readString(meta.client_name, 'client_name', maxClientNameLength)?.trim()
	return {
		clientName: clientName || new URL(redirectUris[0]!).hostname || 'MCP client',
		redirectUris,
		tokenEndpointAuthMethod: method as TokenEndpointAuthMethod,
		grantTypes: grantTypes as Array<'authorization_code' | 'refresh_token'>,
		clientUri: readHttpUrl(meta.client_uri, 'client_uri'),
		logoUri: readHttpUrl(meta.logo_uri, 'logo_uri'),
		softwareId: readString(meta.software_id, 'software_id', 120),
		softwareVersion: readString(meta.software_version, 'software_version', 60),
	}
}

export function validateRedirectUri(value: unknown): string {
	if (typeof value !== 'string' || value.length > 2048) {
		throw new OAuthProtocolError('invalid_redirect_uri', 'redirect_uris must be strings.')
	}
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new OAuthProtocolError('invalid_redirect_uri', `"${value}" is not an absolute URL.`)
	}
	if (url.hash) throw new OAuthProtocolError('invalid_redirect_uri', 'redirect_uris may not contain a fragment.')
	if (url.username || url.password) {
		throw new OAuthProtocolError('invalid_redirect_uri', 'redirect_uris may not embed credentials.')
	}
	if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
		throw new OAuthProtocolError('invalid_redirect_uri', 'http redirect_uris are only allowed for loopback hosts.')
	}
	if (url.protocol === 'javascript:' || url.protocol === 'data:' || url.protocol === 'file:') {
		throw new OAuthProtocolError('invalid_redirect_uri', `"${url.protocol}" redirect_uris are refused.`)
	}
	return url.toString()
}

/** Exact match, except loopback http where the port may vary between runs (RFC 8252 §7.3). */
export function redirectUriMatches(requested: string, registered: Array<string>) {
	if (registered.includes(requested)) return true
	let req: URL
	try {
		req = new URL(requested)
	} catch {
		return false
	}
	if (req.protocol !== 'http:' || !isLoopbackHost(req.hostname)) return false
	return registered.some((entry) => {
		try {
			const reg = new URL(entry)
			return (
				reg.protocol === 'http:' &&
				isLoopbackHost(reg.hostname) &&
				reg.hostname === req.hostname &&
				reg.pathname === req.pathname &&
				reg.search === req.search
			)
		} catch {
			return false
		}
	})
}

export type AuthorizeRequest = {
	clientId: string
	redirectUri: string
	codeChallenge: string
	codeChallengeMethod: 'S256'
	state: string | null
	scope: string
	resource: string
}

/**
 * Validates the front-channel query. Errors before the redirect URI is
 * trusted must render (never redirect); after that they may be returned to
 * the client per RFC 6749 §4.1.2.1.
 */
export function parseAuthorizeRequest(
	params: URLSearchParams,
	client: { clientId: string; redirectUris: Array<string> } | null,
	issuer: string,
): AuthorizeRequest {
	const clientId = params.get('client_id')
	if (!clientId) throw new OAuthProtocolError('invalid_request', 'client_id is required.')
	if (!client)
		throw new OAuthProtocolError('invalid_client', 'Unknown client_id. Register with /oauth/register first.', 400)
	const redirectUri = params.get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null)
	if (!redirectUri || !redirectUriMatches(redirectUri, client.redirectUris)) {
		throw new OAuthProtocolError('invalid_request', 'redirect_uri does not match the registered redirect URIs.')
	}
	if (params.get('response_type') !== 'code') {
		throw new OAuthProtocolError('unsupported_response_type', 'Only response_type=code is supported.')
	}
	const codeChallenge = params.get('code_challenge')
	if (!codeChallenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) {
		throw new OAuthProtocolError('invalid_request', 'PKCE is required: send a code_challenge (S256).')
	}
	if ((params.get('code_challenge_method') ?? 'S256') !== 'S256') {
		throw new OAuthProtocolError('invalid_request', 'Only code_challenge_method=S256 is supported.')
	}
	const scope = normalizeScope(params.get('scope'))
	const resource = params.get('resource') ?? `${issuer}${mcpResourcePath}`
	if (resource !== `${issuer}${mcpResourcePath}` && resource !== issuer) {
		throw new OAuthProtocolError('invalid_target', `This server only issues tokens for ${issuer}${mcpResourcePath}.`)
	}
	const state = params.get('state')
	if (state && state.length > 1024) throw new OAuthProtocolError('invalid_request', 'state is too long.')
	return {
		clientId,
		redirectUri,
		codeChallenge,
		codeChallengeMethod: 'S256',
		state,
		scope,
		resource: `${issuer}${mcpResourcePath}`,
	}
}

/** Unknown scopes are dropped rather than rejected — MCP hosts request what discovery lists. */
export function normalizeScope(raw: string | null) {
	const requested = (raw ?? '').split(/\s+/).filter(Boolean)
	const kept = oauthScopes.filter((scope) => requested.includes(scope))
	return kept.join(' ')
}

export async function verifyPkce(verifier: string | null, challenge: string) {
	if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
	return constantTimeEqualString(await pkceChallenge(verifier), challenge)
}

/** Client credentials from the token/revoke request: Basic header or body fields. */
export function readClientCredentials(request: Request, form: URLSearchParams) {
	const header = request.headers.get('authorization')
	if (header && /^Basic\s+/i.test(header)) {
		let decoded: string
		try {
			decoded = atob(header.replace(/^Basic\s+/i, '').trim())
		} catch {
			throw new OAuthProtocolError('invalid_client', 'Malformed Basic credentials.', 401)
		}
		const idx = decoded.indexOf(':')
		if (idx === -1) throw new OAuthProtocolError('invalid_client', 'Malformed Basic credentials.', 401)
		return {
			clientId: decodeURIComponent(decoded.slice(0, idx)),
			clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
			method: 'client_secret_basic' as const,
		}
	}
	const clientId = form.get('client_id')
	const clientSecret = form.get('client_secret')
	return {
		clientId,
		clientSecret,
		method: clientSecret ? ('client_secret_post' as const) : ('none' as const),
	}
}

export function redirectWithParams(redirectUri: string, params: Record<string, string | null>) {
	const url = new URL(redirectUri)
	for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value)
	return url.toString()
}
