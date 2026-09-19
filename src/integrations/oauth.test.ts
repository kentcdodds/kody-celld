import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	buildAuthorizeUrl,
	buildTokenRequest,
	decodeState,
	encodeState,
	isTokenExpired,
	parseIntegrationConfig,
	parseIntegrationUsage,
	parseScopes,
	parseTokenResponse,
	pkceChallenge,
	randomUrlSafe,
	tokenExpirySkewMs,
	usagePermits,
} from './oauth.ts'

const base = {
	name: 'github',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	clientId: 'client-id-public',
	allowedHosts: ['API.GitHub.com', 'uploads.github.com', 'api.github.com'],
}

describe('parseIntegrationConfig', () => {
	it('normalizes hosts, scopes, and defaults', () => {
		const config = parseIntegrationConfig({ ...base, scopes: 'repo read:user repo' })
		assert.equal(config.flow, 'authorization_code')
		assert.equal(config.tokenAuthStyle, 'body')
		assert.equal(config.provider, 'github')
		assert.deepEqual(config.scopes, ['repo', 'read:user'])
		assert.deepEqual(config.allowedHosts, ['api.github.com', 'uploads.github.com'])
		assert.deepEqual(config.usage, { mode: 'any' })
	})

	it('requires allowedHosts and rejects credential-bearing or non-http URLs', () => {
		assert.throws(() => parseIntegrationConfig({ ...base, allowedHosts: [] }), /allowedHosts is required/)
		assert.throws(() => parseIntegrationConfig({ ...base, tokenUrl: 'ftp://x/token' }), /must use http/)
		assert.throws(() => parseIntegrationConfig({ ...base, tokenUrl: 'https://u:p@x/token' }), /embed credentials/)
		assert.throws(() => parseIntegrationConfig({ ...base, tokenUrl: 'https://x/token#frag' }), /fragment/)
		assert.throws(() => parseIntegrationConfig({ ...base, name: 'bad name!' }), /name must be/)
		assert.throws(() => parseIntegrationConfig({ ...base, allowedHosts: ['https://x.example/p'] }), /invalid_host/)
	})

	it('client_credentials needs no authorizeUrl; reserved authorizeParams are refused', () => {
		const cc = parseIntegrationConfig({ ...base, authorizeUrl: undefined, flow: 'client_credentials' })
		assert.equal(cc.authorizeUrl, null)
		assert.throws(() => parseIntegrationConfig({ ...base, authorizeParams: { state: 'x' } }), /set by Kody/)
		assert.throws(() => parseIntegrationConfig({ ...base, flow: 'implicit' }), /flow must be/)
	})
})

describe('scopes + usage', () => {
	it('parses scope strings and arrays, dropping blanks and duplicates', () => {
		assert.deepEqual(parseScopes('a, b  c a'), ['a', 'b', 'c'])
		assert.deepEqual(parseScopes(['x', ' ', 'x']), ['x'])
		assert.throws(() => parseScopes([1]), /array of strings/)
	})

	it('usage grants: any vs package-limited', () => {
		assert.deepEqual(parseIntegrationUsage(undefined), { mode: 'any' })
		assert.deepEqual(parseIntegrationUsage(['@a/b', '@a/b']), { mode: 'packages', packages: ['@a/b'] })
		assert.deepEqual(parseIntegrationUsage({ mode: 'packages', packages: ['c'] }), {
			mode: 'packages',
			packages: ['c'],
		})
		assert.throws(() => parseIntegrationUsage({ mode: 'packages', packages: [] }), /at least one/)
		assert.throws(() => parseIntegrationUsage(['Not A Package']), /not a package name/)
		const limited = parseIntegrationUsage(['@a/b'])
		assert.equal(usagePermits(limited, '@a/b'), true)
		assert.equal(usagePermits(limited, '@a/other'), false)
		assert.equal(usagePermits(limited, null), false, 'ad hoc execute is refused by a package-limited grant')
		assert.equal(usagePermits({ mode: 'any' }, null), true)
	})
})

describe('PKCE + state', () => {
	it('derives an S256 challenge in URL-safe base64', async () => {
		// RFC 7636 appendix B vector.
		const challenge = await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
		assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
		assert.match(randomUrlSafe(), /^[A-Za-z0-9_-]{43}$/)
	})

	it('encodes and validates connect state, rejecting malformed input', () => {
		const state = encodeState('user_1', 'connect_2', 'n0nce')
		assert.deepEqual(decodeState(state), { userId: 'user_1', connectId: 'connect_2', nonce: 'n0nce' })
		assert.equal(decodeState('a.b'), null)
		assert.equal(decodeState('a..c'), null)
		assert.equal(decodeState('a.b.c/d'), null)
	})

	it('builds the authorize URL with Kody-controlled parameters last', () => {
		const config = parseIntegrationConfig({ ...base, scopes: ['a', 'b'], authorizeParams: { prompt: 'consent' } })
		const url = new URL(
			buildAuthorizeUrl({ config, redirectUri: 'https://kody.example/cb', state: 's', codeChallenge: 'c' }),
		)
		assert.equal(url.searchParams.get('response_type'), 'code')
		assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
		assert.equal(url.searchParams.get('scope'), 'a b')
		assert.equal(url.searchParams.get('prompt'), 'consent')
		assert.equal(url.searchParams.get('redirect_uri'), 'https://kody.example/cb')
	})
})

describe('token endpoint', () => {
	const config = parseIntegrationConfig({ ...base, scopes: ['a'] })

	it('sends the client secret in the body or as Basic auth, never both', () => {
		const body = buildTokenRequest({
			config,
			clientSecret: 'cs',
			grant: { grantType: 'authorization_code', code: 'code', redirectUri: 'https://k/cb', codeVerifier: 'v' },
		})
		const params = new URLSearchParams(body.body)
		assert.equal(params.get('client_secret'), 'cs')
		assert.equal(params.get('code_verifier'), 'v')
		assert.equal(body.headers.authorization, undefined)

		const basic = buildTokenRequest({
			config: { ...config, tokenAuthStyle: 'basic' },
			clientSecret: 'cs',
			grant: { grantType: 'refresh_token', refreshToken: 'rt' },
		})
		assert.match(basic.headers.authorization ?? '', /^Basic /)
		assert.equal(new URLSearchParams(basic.body).get('client_secret'), null)
		assert.equal(new URLSearchParams(basic.body).get('refresh_token'), 'rt')

		const cc = buildTokenRequest({ config, clientSecret: null, grant: { grantType: 'client_credentials' } })
		assert.equal(new URLSearchParams(cc.body).get('scope'), 'a')
		assert.equal(new URLSearchParams(cc.body).get('client_secret'), null)
	})

	it('parses JSON and form-encoded responses and computes expiry', () => {
		const now = new Date('2026-01-01T00:00:00Z')
		const json = parseTokenResponse({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'a' }),
			now,
		})
		assert.equal(json.accessToken, 'at')
		assert.equal(json.refreshToken, 'rt')
		assert.equal(json.tokenType, 'Bearer')
		assert.equal(json.expiresAt, '2026-01-01T01:00:00.000Z')
		const form = parseTokenResponse({
			status: 200,
			contentType: 'application/x-www-form-urlencoded',
			body: 'access_token=at2&token_type=bearer',
		})
		assert.equal(form.accessToken, 'at2')
		assert.equal(form.expiresAt, null)
	})

	it('turns provider errors into a KodyError without token material', () => {
		assert.throws(
			() =>
				parseTokenResponse({
					status: 400,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'invalid_grant', error_description: 'bad', access_token: 'leak' }),
				}),
			(error: Error) => /invalid_grant/.test(error.message) && !/leak/.test(error.message),
		)
		assert.throws(() => parseTokenResponse({ status: 200, contentType: null, body: '<html>' }), /no access_token/)
	})

	it('treats tokens as expired within the skew window', () => {
		const now = new Date('2026-01-01T00:00:00Z')
		assert.equal(isTokenExpired(null, now), false)
		assert.equal(isTokenExpired(new Date(now.getTime() + tokenExpirySkewMs * 2).toISOString(), now), false)
		assert.equal(isTokenExpired(new Date(now.getTime() + tokenExpirySkewMs / 2).toISOString(), now), true)
		assert.equal(isTokenExpired(new Date(now.getTime() - 1).toISOString(), now), true)
	})
})
