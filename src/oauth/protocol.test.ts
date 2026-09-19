import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pkceChallenge } from '../integrations/oauth.ts'
import {
	authorizationServerMetadata,
	normalizeScope,
	oauthErrorBody,
	OAuthProtocolError,
	parseAuthorizeRequest,
	parseClientRegistration,
	protectedResourceMetadata,
	readClientCredentials,
	redirectUriMatches,
	redirectWithParams,
	validateRedirectUri,
	verifyPkce,
} from './protocol.ts'

const issuer = 'https://kody.example'
const verifier = 'v'.repeat(43)

describe('discovery metadata', () => {
	it('advertises code + PKCE S256 only, DCR, revocation, and the /mcp resource', () => {
		const as = authorizationServerMetadata(issuer)
		assert.equal(as.issuer, issuer)
		assert.equal(as.authorization_endpoint, `${issuer}/oauth/authorize`)
		assert.equal(as.token_endpoint, `${issuer}/oauth/token`)
		assert.equal(as.registration_endpoint, `${issuer}/oauth/register`)
		assert.equal(as.revocation_endpoint, `${issuer}/oauth/revoke`)
		assert.deepEqual(as.response_types_supported, ['code'])
		assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
		assert.ok(as.grant_types_supported.includes('refresh_token'))
		const pr = protectedResourceMetadata(issuer)
		assert.equal(pr.resource, `${issuer}/mcp`)
		assert.deepEqual(pr.authorization_servers, [issuer])
	})

	it('serializes protocol errors as RFC 6749 bodies, also after an RPC hop', () => {
		assert.deepEqual(oauthErrorBody(new OAuthProtocolError('invalid_grant', 'nope')), {
			status: 400,
			body: { error: 'invalid_grant', error_description: 'nope' },
		})
		const hopped = new Error('Unknown client.')
		hopped.name = new OAuthProtocolError('invalid_client', 'Unknown client.', 401).name
		assert.deepEqual(oauthErrorBody(hopped), {
			status: 401,
			body: { error: 'invalid_client', error_description: 'Unknown client.' },
		})
		assert.equal(oauthErrorBody(new Error('boom')).body.error, 'server_error')
	})
})

describe('parseClientRegistration (RFC 7591)', () => {
	it('defaults to a public authorization_code + refresh client named after the redirect host', () => {
		const reg = parseClientRegistration({ redirect_uris: ['https://app.example/cb'] })
		assert.equal(reg.tokenEndpointAuthMethod, 'none')
		assert.deepEqual(reg.grantTypes, ['authorization_code', 'refresh_token'])
		assert.equal(reg.clientName, 'app.example')
		assert.equal(reg.clientUri, null)
	})

	it('keeps confidential methods and metadata, trims names, validates URLs', () => {
		const reg = parseClientRegistration({
			redirect_uris: ['https://app.example/cb'],
			token_endpoint_auth_method: 'client_secret_basic',
			client_name: 'n'.repeat(200),
			client_uri: 'https://app.example',
			logo_uri: 'https://app.example/logo.png',
			software_id: 'sw',
			software_version: '1.2',
			grant_types: ['authorization_code'],
			response_types: ['code'],
		})
		assert.equal(reg.tokenEndpointAuthMethod, 'client_secret_basic')
		assert.equal(reg.clientName.length, 120)
		assert.deepEqual(reg.grantTypes, ['authorization_code'])
		assert.equal(reg.clientUri, 'https://app.example/')
		assert.equal(reg.softwareId, 'sw')
		assert.throws(
			() => parseClientRegistration({ redirect_uris: ['https://a.example/'], logo_uri: 'javascript:1' }),
			/http/,
		)
		assert.throws(() => parseClientRegistration({ redirect_uris: ['https://a.example/'], client_name: 5 }), /string/)
	})

	it('refuses shapes it cannot honour', () => {
		assert.throws(() => parseClientRegistration(null), /JSON object/)
		assert.throws(() => parseClientRegistration({}), /redirect_uri/)
		assert.throws(() => parseClientRegistration({ redirect_uris: [] }), /redirect_uri/)
		assert.throws(
			() => parseClientRegistration({ redirect_uris: Array.from({ length: 17 }, (_, i) => `https://a.example/${i}`) }),
			/At most 16/,
		)
		assert.throws(
			() =>
				parseClientRegistration({
					redirect_uris: ['https://a.example/'],
					token_endpoint_auth_method: 'private_key_jwt',
				}),
			/token_endpoint_auth_method/,
		)
		assert.throws(
			() => parseClientRegistration({ redirect_uris: ['https://a.example/'], grant_types: ['implicit'] }),
			/Unsupported grant_type/,
		)
		assert.throws(
			() => parseClientRegistration({ redirect_uris: ['https://a.example/'], grant_types: ['refresh_token'] }),
			/must include authorization_code/,
		)
		assert.throws(
			() => parseClientRegistration({ redirect_uris: ['https://a.example/'], response_types: ['token'] }),
			/response_type/,
		)
	})
})

describe('redirect URIs', () => {
	it('accepts https, loopback http, and private-use schemes; refuses the rest', () => {
		assert.equal(validateRedirectUri('https://app.example/cb?x=1'), 'https://app.example/cb?x=1')
		assert.equal(validateRedirectUri('http://127.0.0.1:49152/cb'), 'http://127.0.0.1:49152/cb')
		assert.equal(validateRedirectUri('http://localhost/cb'), 'http://localhost/cb')
		assert.equal(validateRedirectUri('http://[::1]:3000/cb'), 'http://[::1]:3000/cb')
		assert.equal(validateRedirectUri('com.example.app:/oauth'), 'com.example.app:/oauth')
		assert.throws(() => validateRedirectUri('http://app.example/cb'), /loopback/)
		assert.throws(() => validateRedirectUri('https://app.example/cb#frag'), /fragment/)
		assert.throws(() => validateRedirectUri('https://user:pw@app.example/cb'), /credentials/)
		assert.throws(() => validateRedirectUri('javascript:alert(1)'), /refused/)
		assert.throws(() => validateRedirectUri('data:text/html,hi'), /refused/)
		assert.throws(() => validateRedirectUri('/relative'), /absolute/)
		assert.throws(() => validateRedirectUri(42), /strings/)
		assert.throws(() => validateRedirectUri(`https://a.example/${'x'.repeat(2048)}`), /strings/)
	})

	it('matches exactly, except the port of a loopback http redirect', () => {
		const registered = ['https://app.example/cb', 'http://127.0.0.1:1234/cb']
		assert.equal(redirectUriMatches('https://app.example/cb', registered), true)
		assert.equal(redirectUriMatches('https://app.example/cb/', registered), false)
		assert.equal(redirectUriMatches('https://app.example/cb?extra=1', registered), false)
		assert.equal(redirectUriMatches('http://127.0.0.1:65000/cb', registered), true)
		assert.equal(redirectUriMatches('http://localhost:65000/cb', registered), false, 'host must match too')
		assert.equal(redirectUriMatches('http://127.0.0.1:65000/other', registered), false)
		assert.equal(redirectUriMatches('not a url', registered), false)
	})

	it('appends response parameters without clobbering the registered query', () => {
		assert.equal(
			redirectWithParams('https://app.example/cb?keep=1', { code: 'c', state: null, iss: issuer }),
			'https://app.example/cb?keep=1&code=c&iss=https%3A%2F%2Fkody.example',
		)
	})
})

describe('parseAuthorizeRequest', () => {
	const client = { clientId: 'mcpc_1', redirectUris: ['https://app.example/cb'] }
	const good = async (overrides: Record<string, string | null> = {}) => {
		const params = new URLSearchParams({
			client_id: 'mcpc_1',
			redirect_uri: 'https://app.example/cb',
			response_type: 'code',
			code_challenge: await pkceChallenge(verifier),
			code_challenge_method: 'S256',
			scope: 'openid profile offline_access',
			state: 'xyz',
		})
		for (const [key, value] of Object.entries(overrides)) {
			if (value === null) params.delete(key)
			else params.set(key, value)
		}
		return params
	}

	it('normalizes a valid request, dropping unknown scopes and pinning the resource', async () => {
		const parsed = parseAuthorizeRequest(await good(), client, issuer)
		assert.equal(parsed.clientId, 'mcpc_1')
		assert.equal(parsed.redirectUri, 'https://app.example/cb')
		assert.equal(parsed.scope, 'openid profile')
		assert.equal(parsed.resource, `${issuer}/mcp`)
		assert.equal(parsed.state, 'xyz')
		assert.equal(parsed.codeChallengeMethod, 'S256')
		// A single registered redirect may be implied; the issuer itself is an acceptable resource.
		const implied = parseAuthorizeRequest(await good({ redirect_uri: null, resource: issuer }), client, issuer)
		assert.equal(implied.redirectUri, 'https://app.example/cb')
		const defaulted = parseAuthorizeRequest(await good({ code_challenge_method: null, scope: null }), client, issuer)
		assert.equal(defaulted.scope, '')
	})

	it('refuses unknown clients, foreign redirects, implicit flow, missing/plain PKCE, wrong resources', async () => {
		const code = (params: URLSearchParams, c: typeof client | null = client) => {
			try {
				parseAuthorizeRequest(params, c, issuer)
				return null
			} catch (error) {
				return (error as OAuthProtocolError).code
			}
		}
		assert.equal(code(await good({ client_id: null })), 'invalid_request')
		assert.equal(code(await good(), null), 'invalid_client')
		assert.equal(code(await good({ redirect_uri: 'https://evil.example/cb' })), 'invalid_request')
		assert.equal(code(await good({ response_type: 'token' })), 'unsupported_response_type')
		assert.equal(code(await good({ code_challenge: null })), 'invalid_request')
		assert.equal(code(await good({ code_challenge: 'short' })), 'invalid_request')
		assert.equal(code(await good({ code_challenge_method: 'plain' })), 'invalid_request')
		assert.equal(code(await good({ resource: 'https://other.example/mcp' })), 'invalid_target')
		assert.equal(code(await good({ state: 's'.repeat(1025) })), 'invalid_request')
		const two = { clientId: 'mcpc_1', redirectUris: ['https://a.example/', 'https://b.example/'] }
		assert.equal(
			code(await good({ redirect_uri: null }), two),
			'invalid_request',
			'ambiguous redirect must be explicit',
		)
	})
})

describe('scope, PKCE, client credentials', () => {
	it('normalizeScope keeps known scopes in canonical order', () => {
		assert.equal(normalizeScope('email openid bogus openid'), 'openid email')
		assert.equal(normalizeScope(null), '')
		assert.equal(normalizeScope('   '), '')
	})

	it('verifyPkce is S256 only and rejects malformed verifiers', async () => {
		const challenge = await pkceChallenge(verifier)
		assert.equal(await verifyPkce(verifier, challenge), true)
		assert.equal(await verifyPkce(`${verifier}x`, challenge), false)
		assert.equal(await verifyPkce(verifier, verifier), false, 'plain method is not accepted')
		assert.equal(await verifyPkce(null, challenge), false)
		assert.equal(await verifyPkce('too-short', challenge), false)
		assert.equal(await verifyPkce('v'.repeat(129), challenge), false)
	})

	it('readClientCredentials prefers Basic, then body fields, and reports the method used', () => {
		const post = (headers: Record<string, string> = {}) =>
			new Request(`${issuer}/oauth/token`, { method: 'POST', headers })
		const basic = readClientCredentials(
			post({ authorization: `Basic ${btoa('mcpc_1:s%3Acret')}` }),
			new URLSearchParams({ client_id: 'ignored' }),
		)
		assert.deepEqual(basic, { clientId: 'mcpc_1', clientSecret: 's:cret', method: 'client_secret_basic' })
		assert.deepEqual(readClientCredentials(post(), new URLSearchParams({ client_id: 'mcpc_1', client_secret: 'x' })), {
			clientId: 'mcpc_1',
			clientSecret: 'x',
			method: 'client_secret_post',
		})
		assert.deepEqual(readClientCredentials(post(), new URLSearchParams({ client_id: 'mcpc_1' })), {
			clientId: 'mcpc_1',
			clientSecret: null,
			method: 'none',
		})
		assert.throws(() => readClientCredentials(post({ authorization: 'Basic !!!' }), new URLSearchParams()), /Malformed/)
		assert.throws(
			() => readClientCredentials(post({ authorization: `Basic ${btoa('nocolon')}` }), new URLSearchParams()),
			/Malformed/,
		)
	})
})
