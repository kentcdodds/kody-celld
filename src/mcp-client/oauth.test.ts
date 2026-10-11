import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { oauthPolicyFetch } from './client.ts'
import {
	assertBrowserRedirect,
	mcpBrowserFormActionOrigin,
	beginMcpAuthorization,
	completeMcpAuthorization,
	mcpAuthorizeUrl,
	mcpClientMetadataDocument,
	mcpOAuthScopes,
	mcpOAuthUrls,
	pickClientMode,
	probeMcpOAuth,
	refreshMcpTokens,
} from './oauth.ts'
import { isInvalidGrant } from './oauth-store.ts'
import { mcpConfigFromEnv } from './policy.ts'
import { startTestMcpServer } from './test-server.ts'

const config = mcpConfigFromEnv({ KODY_PRIVATE_HOSTS: '172.30.0.0/16' })
const serverUrl = 'http://172.30.1.5/mcp'
const httpsUrls = mcpOAuthUrls('https://kody.example.com/')
const httpUrls = mcpOAuthUrls('http://localhost:8080')

describe('URLs and the metadata document', () => {
	it('derives everything from the public origin; CIMD only on https', () => {
		assert.deepEqual(httpsUrls, {
			clientOrigin: 'https://kody.example.com',
			callbackUrl: 'https://kody.example.com/account/mcp-servers/oauth/callback',
			clientMetadataUrl: 'https://kody.example.com/oauth/client-metadata.json',
		})
		assert.equal(httpUrls.clientMetadataUrl, null)
		assert.equal(
			mcpAuthorizeUrl('https://kody.example.com/x', 'home'),
			'https://kody.example.com/account/mcp-servers/home/authorize',
		)
		assert.deepEqual(mcpClientMetadataDocument(httpsUrls), {
			client_id: 'https://kody.example.com/oauth/client-metadata.json',
			client_name: 'Kody (celld)',
			client_uri: 'https://kody.example.com',
			redirect_uris: ['https://kody.example.com/account/mcp-servers/oauth/callback'],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		})
		assert.equal(mcpClientMetadataDocument(httpUrls), null)
	})
})

describe('probeMcpOAuth / pickClientMode', () => {
	it('finds the authorization server and picks the mode', async () => {
		for (const [mode, expected] of [
			['dynamic', 'dynamic'],
			['metadata', 'metadata'],
			['none', null],
		] as const) {
			const server = startTestMcpServer({ oauth: { mode } })
			const discovery = (await probeMcpOAuth(serverUrl, oauthPolicyFetch(config, server.fetch)))!
			assert.equal(discovery.authorizationServerUrl, 'http://172.30.1.5')
			assert.equal(
				pickClientMode(discovery, { hasPreregistered: false, clientMetadataUrl: httpsUrls.clientMetadataUrl }),
				expected,
			)
		}
		const server = startTestMcpServer({ oauth: { mode: 'metadata' } })
		const discovery = (await probeMcpOAuth(serverUrl, oauthPolicyFetch(config, server.fetch)))!
		assert.equal(
			pickClientMode(discovery, { hasPreregistered: false, clientMetadataUrl: null }),
			null,
			'no CIMD on http origins',
		)
		assert.equal(pickClientMode(discovery, { hasPreregistered: true, clientMetadataUrl: null }), 'preregistered')
	})

	it('refuses an authorization server on a private host that is not allowlisted', async () => {
		const server = startTestMcpServer({ oauth: { mode: 'dynamic', authorizationServer: 'http://10.9.9.9' } })
		await assert.rejects(probeMcpOAuth(serverUrl, oauthPolicyFetch(config, server.fetch)), /mcp_host_not_allowed/)
		assert.ok(!server.requests.some((r) => r.url.startsWith('http://10.9.9.9')), 'the private host is never fetched')
	})

	it('returns null for a server without OAuth metadata', async () => {
		const server = startTestMcpServer({ bearer: 'tok' })
		server.setRespond((url) =>
			url.pathname.startsWith('/.well-known/') ? new Response('nope', { status: 404 }) : null,
		)
		assert.equal(await probeMcpOAuth(serverUrl, oauthPolicyFetch(config, server.fetch)), null)
	})

	it('refuses authorization server metadata whose issuer does not match the fetch URL', async () => {
		const server = startTestMcpServer({ oauth: { mode: 'dynamic' } })
		server.setRespond((url) =>
			url.pathname === '/.well-known/oauth-authorization-server'
				? Response.json({
						issuer: 'https://honest.example',
						authorization_endpoint: 'https://honest.example/authorize',
						token_endpoint: 'http://172.30.1.5/token',
						registration_endpoint: 'http://172.30.1.5/register',
						response_types_supported: ['code'],
						code_challenge_methods_supported: ['S256'],
					})
				: null,
		)
		await assert.rejects(
			probeMcpOAuth(serverUrl, oauthPolicyFetch(config, server.fetch)),
			/mcp_oauth_failed[\s\S]*does not match/,
		)
	})
})

describe('probe failures and scopes', () => {
	it('reports a failing authorization server as mcp_oauth_failed, not as unsupported', async () => {
		const server = startTestMcpServer({ oauth: { mode: 'dynamic' } })
		server.setRespond((url) =>
			url.pathname === '/.well-known/oauth-authorization-server' ? new Response('down', { status: 503 }) : null,
		)
		await assert.rejects(probeMcpOAuth(serverUrl, oauthPolicyFetch(config, server.fetch)), /mcp_oauth_failed/)
	})

	it('takes scopes from the challenge, else from the resource metadata', async () => {
		const server = startTestMcpServer({ oauth: { mode: 'dynamic' } })
		const discovery = (await probeMcpOAuth(serverUrl, oauthPolicyFetch(config, server.fetch)))!
		assert.deepEqual(mcpOAuthScopes(discovery, 'Bearer scope="a b"'), ['a', 'b'])
		assert.deepEqual(mcpOAuthScopes(discovery), ['mcp'])
	})
})

describe('begin / complete / refresh', () => {
	it('DCR: registers, redirects with PKCE, exchanges the code, refreshes', async () => {
		const server = startTestMcpServer({ oauth: { mode: 'dynamic' } })
		const fetchFn = oauthPolicyFetch(config, server.fetch)
		const begun = await beginMcpAuthorization({ serverUrl, urls: httpUrls, client: null, discovery: null, fetchFn })
		assert.equal(begun.authorizationUrl.origin, 'http://172.30.1.5')
		assert.equal(begun.authorizationUrl.searchParams.get('state'), begun.state)
		assert.equal(begun.authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
		assert.equal(begun.savedClient?.client_id, 'dyn-1')
		const back = await server.fetch(begun.authorizationUrl.href)
		const code = new URL(back.headers.get('location')!).searchParams.get('code')!
		const done = await completeMcpAuthorization({
			serverUrl,
			urls: httpUrls,
			client: begun.savedClient,
			discovery: begun.discovery,
			verifier: begun.verifier,
			state: begun.state,
			code,
			fetchFn,
		})
		assert.match(done.tokens.access_token, /^at-/)
		const refreshed = await refreshMcpTokens({
			client: begun.savedClient!,
			refreshToken: done.tokens.refresh_token!,
			discovery: begun.discovery,
			fetchFn,
		})
		assert.notEqual(refreshed.access_token, done.tokens.access_token)
		await assert.rejects(
			refreshMcpTokens({
				client: begun.savedClient!,
				refreshToken: done.tokens.refresh_token!,
				discovery: begun.discovery,
				fetchFn,
			}),
			(error) => isInvalidGrant(error),
			'a rotated refresh token is rejected',
		)
	})

	it('CIMD: presents the metadata URL as client_id and never registers', async () => {
		const server = startTestMcpServer({ oauth: { mode: 'metadata' } })
		const begun = await beginMcpAuthorization({
			serverUrl,
			urls: httpsUrls,
			client: null,
			discovery: null,
			fetchFn: oauthPolicyFetch(config, server.fetch),
		})
		assert.equal(begun.authorizationUrl.searchParams.get('client_id'), httpsUrls.clientMetadataUrl)
		assert.equal(server.oauth!.registrations, 0)
	})
})

describe('assertBrowserRedirect', () => {
	it('allows https and allowlisted http; refuses everything else', () => {
		assert.equal(assertBrowserRedirect(new URL('https://idp.example.com/a'), config).host, 'idp.example.com')
		assert.equal(assertBrowserRedirect(new URL('http://172.30.1.5/authorize'), config).host, '172.30.1.5')
		for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://idp.example.com/a']) {
			assert.throws(() => assertBrowserRedirect(new URL(bad), config), /mcp_oauth_failed/)
		}
	})
})

describe('mcpBrowserFormActionOrigin', () => {
	const discovery = (endpoint: string) =>
		({
			authorizationServerUrl: 'http://172.30.1.5',
			authorizationServerMetadata: { authorization_endpoint: endpoint },
		}) as never
	it('returns the origin only for an http authorize endpoint on an allowlisted host', () => {
		assert.equal(
			mcpBrowserFormActionOrigin(discovery('http://172.30.1.5:8123/auth/authorize'), config),
			'http://172.30.1.5:8123',
		)
		assert.equal(
			mcpBrowserFormActionOrigin(discovery('https://idp.example.com/authorize'), config),
			null,
			'https is already allowed',
		)
		assert.equal(
			mcpBrowserFormActionOrigin(discovery('http://idp.example.com/authorize'), config),
			null,
			'public http is refused',
		)
		assert.equal(mcpBrowserFormActionOrigin(discovery('javascript:alert(1)'), config), null)
	})
})

describe('endpoint origins (#53)', () => {
	for (const [field, endpoint] of [
		['authorization_endpoint', 'http://172.30.1.6/authorize'],
		['token_endpoint', 'http://172.30.1.6/token'],
	] as const) {
		it(`refuses metadata whose ${field} is on a different origin than the issuer`, async () => {
			const server = startTestMcpServer({ oauth: { mode: 'dynamic' } })
			server.setRespond((u) =>
				u.pathname === '/.well-known/oauth-authorization-server'
					? Response.json({
							issuer: 'http://172.30.1.5',
							authorization_endpoint: 'http://172.30.1.5/authorize',
							token_endpoint: 'http://172.30.1.5/token',
							registration_endpoint: 'http://172.30.1.5/register',
							response_types_supported: ['code'],
							code_challenge_methods_supported: ['S256'],
							[field]: endpoint,
						})
					: null,
			)
			await assert.rejects(
				probeMcpOAuth(serverUrl, oauthPolicyFetch(config, server.fetch)),
				new RegExp(`mcp_oauth_failed[\\s\\S]*${field} .*different origin`),
			)
		})
	}

	it('refresh refuses cached discovery whose token_endpoint is off the issuer origin', async () => {
		await assert.rejects(
			refreshMcpTokens({
				client: { client_id: 'c' },
				refreshToken: 'rt',
				discovery: {
					authorizationServerUrl: 'http://172.30.1.5',
					authorizationServerMetadata: {
						issuer: 'http://172.30.1.5',
						authorization_endpoint: 'http://172.30.1.5/authorize',
						token_endpoint: 'http://172.30.1.6/token',
						response_types_supported: ['code'],
						code_challenge_methods_supported: ['S256'],
					},
				} as never,
				fetchFn: fetch,
			}),
			/mcp_oauth_failed[\s\S]*token_endpoint .*different origin/,
		)
	})
})
