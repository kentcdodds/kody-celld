import {
	auth,
	discoverOAuthServerInfo,
	extractWWWAuthenticateParams,
	refreshAuthorization,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { hostMatchesAllowlist } from '../lib/host-allowlist.ts'
import { KodyError } from '../lib/errors.ts'
import type { McpOAuthClientMode } from './oauth-store.ts'
import type { McpConfig } from './policy.ts'

export type McpOAuthUrls = { clientOrigin: string; callbackUrl: string; clientMetadataUrl: string | null }

export const mcpOAuthCallbackPath = '/account/mcp-servers/oauth/callback'
export const mcpClientMetadataPath = '/oauth/client-metadata.json'
export const mcpOAuthClientName = 'Kody (celld)'

export function mcpOAuthUrls(publicUrl: string): McpOAuthUrls {
	const origin = new URL(publicUrl).origin
	return {
		clientOrigin: origin,
		callbackUrl: `${origin}${mcpOAuthCallbackPath}`,
		clientMetadataUrl: origin.startsWith('https:') ? `${origin}${mcpClientMetadataPath}` : null,
	}
}

export function mcpAuthorizeUrl(publicUrl: string, name: string) {
	return `${new URL(publicUrl).origin}/account/mcp-servers/${encodeURIComponent(name)}/authorize`
}

function clientMetadata(urls: McpOAuthUrls): OAuthClientMetadata {
	return {
		client_name: mcpOAuthClientName,
		client_uri: urls.clientOrigin,
		redirect_uris: [urls.callbackUrl],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
	}
}

export function mcpClientMetadataDocument(urls: McpOAuthUrls): Record<string, unknown> | null {
	if (!urls.clientMetadataUrl) return null
	return { client_id: urls.clientMetadataUrl, ...clientMetadata(urls) }
}

/** RFC 9728 → RFC 8414 discovery through the policy fetch. null when the server advertises no authorization server metadata. */
export async function probeMcpOAuth(
	serverUrl: string,
	fetchFn: typeof fetch,
	challenge?: string | null,
): Promise<OAuthDiscoveryState | null> {
	const params = challenge
		? extractWWWAuthenticateParams(new Response(null, { headers: { 'www-authenticate': challenge } }))
		: {}
	let info
	try {
		info = await discoverOAuthServerInfo(serverUrl, { resourceMetadataUrl: params.resourceMetadataUrl, fetchFn })
	} catch (error) {
		throw failed(error, 'discovery')
	}
	if (!info.authorizationServerMetadata) return null
	return { ...info, ...(params.resourceMetadataUrl ? { resourceMetadataUrl: params.resourceMetadataUrl.href } : {}) }
}

export function pickClientMode(
	discovery: OAuthDiscoveryState,
	options: { hasPreregistered: boolean; clientMetadataUrl: string | null },
): McpOAuthClientMode | null {
	const metadata = discovery.authorizationServerMetadata as Record<string, unknown> | undefined
	if (options.hasPreregistered) return 'preregistered'
	if (options.clientMetadataUrl && metadata?.client_id_metadata_document_supported === true) return 'metadata'
	if (typeof metadata?.registration_endpoint === 'string') return 'dynamic'
	return null
}

export function mcpOAuthScopes(discovery: OAuthDiscoveryState, challenge?: string | null): Array<string> {
	const fromChallenge = challenge
		? extractWWWAuthenticateParams(new Response(null, { headers: { 'www-authenticate': challenge } })).scope
		: undefined
	if (fromChallenge) return fromChallenge.split(/\s+/).filter(Boolean)
	const supported = (discovery.resourceMetadata as { scopes_supported?: Array<string> } | undefined)?.scopes_supported
	return Array.isArray(supported) ? supported : []
}

/** An OAuthClientProvider over in-memory values; the caller persists whatever it captured. */
export class McpOAuthProvider implements OAuthClientProvider {
	authorizationUrl: URL | null = null
	savedClient: OAuthClientInformationMixed | null = null
	savedTokens: OAuthTokens | null = null
	savedVerifier: string | null = null
	savedDiscovery: OAuthDiscoveryState | null = null

	private readonly input: {
		urls: McpOAuthUrls
		client: OAuthClientInformationMixed | null
		discovery: OAuthDiscoveryState | null
		state: string
		verifier?: string
	}

	constructor(input: McpOAuthProvider['input']) {
		this.input = input
	}

	get redirectUrl() {
		return this.input.urls.callbackUrl
	}
	get clientMetadataUrl() {
		return this.input.urls.clientMetadataUrl ?? undefined
	}
	get clientMetadata() {
		return clientMetadata(this.input.urls)
	}
	state() {
		return this.input.state
	}
	clientInformation() {
		return this.savedClient ?? this.input.client ?? undefined
	}
	saveClientInformation(information: OAuthClientInformationMixed) {
		this.savedClient = information
	}
	/** Never hand stored tokens to auth(): begin always starts a new grant; refresh goes through refreshMcpTokens. */
	tokens() {
		return undefined
	}
	saveTokens(tokens: OAuthTokens) {
		this.savedTokens = tokens
	}
	redirectToAuthorization(url: URL) {
		this.authorizationUrl = url
	}
	saveCodeVerifier(verifier: string) {
		this.savedVerifier = verifier
	}
	codeVerifier() {
		const verifier = this.savedVerifier ?? this.input.verifier
		if (!verifier) throw new KodyError('mcp_oauth_failed', 'No PKCE verifier for this authorization.', { status: 502 })
		return verifier
	}
	saveDiscoveryState(state: OAuthDiscoveryState) {
		this.savedDiscovery = state
	}
	discoveryState() {
		return this.savedDiscovery ?? this.input.discovery ?? undefined
	}
}

function randomState() {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')
}

function failed(error: unknown, step: string): KodyError {
	const known = KodyError.fromUnknown(error)
	if (known) return known
	const message = error instanceof Error ? error.message : String(error)
	return new KodyError('mcp_oauth_failed', `OAuth ${step} failed: ${message.replace(/[?#]\S*/g, '').slice(0, 300)}`, {
		status: 502,
	})
}

export async function beginMcpAuthorization(input: {
	serverUrl: string
	urls: McpOAuthUrls
	client: OAuthClientInformationMixed | null
	discovery: OAuthDiscoveryState | null
	fetchFn: typeof fetch
	state?: string
}) {
	const state = input.state ?? randomState()
	const provider = new McpOAuthProvider({ urls: input.urls, client: input.client, discovery: input.discovery, state })
	let result
	try {
		result = await auth(provider, { serverUrl: input.serverUrl, fetchFn: input.fetchFn })
	} catch (error) {
		throw failed(error, 'authorization start')
	}
	if (result !== 'REDIRECT' || !provider.authorizationUrl || !provider.savedVerifier) {
		throw new KodyError('mcp_oauth_failed', 'The authorization server did not start an authorization.', { status: 502 })
	}
	return {
		authorizationUrl: provider.authorizationUrl,
		state,
		verifier: provider.savedVerifier,
		savedClient: provider.savedClient,
		discovery: provider.savedDiscovery ?? input.discovery,
	}
}

export async function completeMcpAuthorization(input: {
	serverUrl: string
	urls: McpOAuthUrls
	client: OAuthClientInformationMixed | null
	discovery: OAuthDiscoveryState | null
	verifier: string
	state: string
	code: string
	fetchFn: typeof fetch
}) {
	const provider = new McpOAuthProvider({
		urls: input.urls,
		client: input.client,
		discovery: input.discovery,
		state: input.state,
		verifier: input.verifier,
	})
	let result
	try {
		result = await auth(provider, { serverUrl: input.serverUrl, authorizationCode: input.code, fetchFn: input.fetchFn })
	} catch (error) {
		throw failed(error, 'token exchange')
	}
	if (result !== 'AUTHORIZED' || !provider.savedTokens) {
		throw new KodyError('mcp_oauth_failed', 'The token exchange returned no tokens.', { status: 502 })
	}
	return { tokens: provider.savedTokens, savedClient: provider.savedClient }
}

/** refresh_token grant (errors are thrown as-is so the store can tell invalid_grant from transient failures). */
export async function refreshMcpTokens(input: {
	client: OAuthClientInformationMixed
	refreshToken: string
	discovery: OAuthDiscoveryState | null
	fetchFn: typeof fetch
}): Promise<OAuthTokens> {
	if (!input.discovery) throw new Error('No cached OAuth discovery for this server; authorize again.')
	const resource = (input.discovery.resourceMetadata as { resource?: string } | undefined)?.resource
	return refreshAuthorization(input.discovery.authorizationServerUrl, {
		metadata: input.discovery.authorizationServerMetadata,
		clientInformation: input.client,
		refreshToken: input.refreshToken,
		...(resource ? { resource: new URL(resource) } : {}),
		fetchFn: input.fetchFn,
	})
}

/** The provider authorize URL is where we send the user's browser: https, or http to an allowlisted host only. */
export function assertBrowserRedirect(url: URL, config: McpConfig): URL {
	if (url.protocol === 'https:') return url
	if (url.protocol === 'http:' && hostMatchesAllowlist(url.hostname.toLowerCase(), config.allowPrivateHosts)) return url
	throw new KodyError('mcp_oauth_failed', `Refusing to send the browser to a ${url.protocol} authorization URL.`, {
		status: 502,
	})
}
