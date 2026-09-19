// M7 MCP OAuth 2.1 authorization-server smoke. Plays an MCP host end to end:
// discovery (RFC 8414 / 9728), the WWW-Authenticate challenge on /mcp, dynamic
// client registration (RFC 7591) for public and confidential clients, the
// browser consent flow (sign-in gate, CSRF, signed consent state, deny),
// authorization_code + PKCE S256 exchange, one-time codes, client binding,
// resource indicators (RFC 8707), access tokens on /mcp and /oauth/userinfo,
// refresh rotation with replay detection, RFC 7009 revocation, and user-side
// grant revocation from the account UI. Token values only ever live in this
// process and are never printed.
import { createHash, randomBytes } from 'node:crypto'
import { admin, assert, baseUrl, Browser, hiddenInputs, log, McpClient } from './lib.mjs'

function b64url(buffer) {
	return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function pkce() {
	const verifier = b64url(randomBytes(32))
	const challenge = b64url(createHash('sha256').update(verifier).digest())
	return { verifier, challenge }
}

async function json(pathname, { method = 'GET', headers = {}, body } = {}) {
	const response = await fetch(`${baseUrl}${pathname}`, {
		method,
		headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await response.text()
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch {
		parsed = { raw: text }
	}
	return { status: response.status, headers: response.headers, json: parsed }
}

async function tokenRequest(form, headers = {}) {
	const response = await fetch(`${baseUrl}/oauth/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
		body: new URLSearchParams(form).toString(),
	})
	const body = await response.json().catch(() => ({}))
	// Diagnostics never include token material: only the error and which fields came back.
	const info = {
		status: response.status,
		error: body.error,
		description: body.error_description,
		keys: Object.keys(body),
	}
	return { status: response.status, json: body, info }
}

async function register(metadata) {
	return json('/oauth/register', { method: 'POST', body: metadata })
}

/** Drives the consent page in `browser` and returns the redirect back to the client. */
async function authorize(browser, params, decision = 'approve') {
	const query = new URLSearchParams(params).toString()
	const consent = await browser.get(`/oauth/authorize?${query}`)
	if (consent.status !== 200) return { consent }
	const hidden = hiddenInputs(consent.text)
	assert(hidden.csrf && hidden.q && hidden.sig, 'consent form carries csrf + signed request', Object.keys(hidden))
	const submitted = await browser.post('/oauth/authorize', {
		csrf: hidden.csrf,
		q: hidden.q,
		sig: hidden.sig,
		decision,
	})
	assert(submitted.status === 303 && submitted.location, `consent ${decision} redirects`, submitted)
	const location = new URL(submitted.location)
	return { consent, hidden, location, params: Object.fromEntries(location.searchParams) }
}

async function mcpStatus(token, method = 'ping') {
	const response = await fetch(`${baseUrl}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
	})
	return { status: response.status, challenge: response.headers.get('www-authenticate') }
}

export async function smokeOAuthServer({ user, mcp }) {
	// --- discovery + challenge -------------------------------------------------
	const as = await json('/.well-known/oauth-authorization-server')
	assert(as.status === 200 && as.json.issuer === baseUrl, 'AS metadata served with issuer', as.json)
	assert(as.json.authorization_endpoint === `${baseUrl}/oauth/authorize`, 'authorization_endpoint', as.json)
	assert(as.json.token_endpoint === `${baseUrl}/oauth/token`, 'token_endpoint', as.json)
	assert(as.json.registration_endpoint === `${baseUrl}/oauth/register`, 'registration_endpoint', as.json)
	assert(as.json.revocation_endpoint === `${baseUrl}/oauth/revoke`, 'revocation_endpoint', as.json)
	assert(as.json.code_challenge_methods_supported?.includes('S256'), 'PKCE S256 advertised', as.json)
	assert(as.json.code_challenge_methods_supported?.length === 1, 'only S256 advertised (no plain)', as.json)
	const pr = await json('/.well-known/oauth-protected-resource')
	assert(pr.status === 200 && pr.json.resource === `${baseUrl}/mcp`, 'protected-resource metadata names /mcp', pr.json)
	assert(pr.json.authorization_servers?.[0] === baseUrl, 'protected-resource points at this AS', pr.json)
	const prPath = await json('/.well-known/oauth-protected-resource/mcp')
	assert(prPath.status === 200 && prPath.json.resource === `${baseUrl}/mcp`, 'path-suffixed PRM also served')
	const anon = await mcpStatus(null)
	assert(anon.status === 401, 'unauthenticated /mcp is 401', anon)
	assert(
		anon.challenge?.includes(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`),
		'challenge carries resource_metadata',
		anon.challenge,
	)
	const badBearer = await mcpStatus('mcpat_not_a_real_token')
	assert(
		badBearer.status === 401 && badBearer.challenge?.includes('error="invalid_token"'),
		'bad bearer -> invalid_token',
		badBearer,
	)
	const preflight = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://client.example' } })
	assert(
		preflight.status === 204 && preflight.headers.get('access-control-allow-headers')?.includes('authorization'),
		'MCP preflight',
	)
	log('discovery', 'AS + PRM metadata, 401 challenge, preflight')

	// --- dynamic client registration ---------------------------------------------
	const port = 40000 + Math.floor(Math.random() * 20000)
	const publicReg = await register({
		client_name: 'Smoke MCP Host',
		redirect_uris: [`http://127.0.0.1:${port}/callback`, 'https://host.example/oauth/callback'],
		token_endpoint_auth_method: 'none',
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		client_uri: 'https://host.example',
	})
	assert(publicReg.status === 201 && publicReg.json.client_id, 'public client registered', publicReg.json)
	assert(!('client_secret' in publicReg.json), 'public client gets no secret', Object.keys(publicReg.json))
	const publicClient = publicReg.json.client_id

	const confidentialReg = await register({
		client_name: 'Smoke Server Client',
		redirect_uris: ['https://server.example/cb'],
		token_endpoint_auth_method: 'client_secret_basic',
	})
	assert(
		confidentialReg.status === 201 && confidentialReg.json.client_secret?.startsWith('mcps_'),
		'confidential client gets a secret once',
	)
	const confidential = { id: confidentialReg.json.client_id, secret: confidentialReg.json.client_secret }

	const insecure = await register({ client_name: 'x', redirect_uris: ['http://host.example/cb'] })
	assert(
		insecure.status === 400 && insecure.json.error === 'invalid_redirect_uri',
		'non-loopback http redirect refused',
		insecure.json,
	)
	const fragment = await register({ client_name: 'x', redirect_uris: ['https://host.example/cb#frag'] })
	assert(
		fragment.status === 400 && fragment.json.error === 'invalid_redirect_uri',
		'fragment redirect refused',
		fragment.json,
	)
	const badGrant = await register({ redirect_uris: ['https://host.example/cb'], grant_types: ['implicit'] })
	assert(
		badGrant.status === 400 && badGrant.json.error === 'invalid_client_metadata',
		'implicit grant refused',
		badGrant.json,
	)
	const customScheme = await register({ client_name: 'native', redirect_uris: ['com.example.app:/oauth'] })
	assert(customScheme.status === 201, 'private-use scheme redirect accepted for native apps', customScheme.json)
	log('dcr', 'public + confidential registered, unsafe redirects/grants refused')

	// --- authorize: sign-in gate, validation, deny -------------------------------
	const { verifier, challenge } = pkce()
	const state = b64url(randomBytes(12))
	const authParams = {
		response_type: 'code',
		client_id: publicClient,
		redirect_uri: `http://127.0.0.1:${port}/callback`,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		scope: 'openid profile email offline_access',
		state,
		resource: `${baseUrl}/mcp`,
	}
	const gate = await new Browser().get(`/oauth/authorize?${new URLSearchParams(authParams)}`)
	assert(
		gate.status === 303 && gate.location?.startsWith('/signin?next=%2Foauth%2Fauthorize'),
		'authorize needs a signed-in browser',
		gate,
	)

	const browser = new Browser()
	const signedIn = await browser.post('/signin', {
		method: 'token',
		token: mcp.token,
		next: decodeURIComponent(gate.location.slice('/signin?next='.length)),
	})
	assert(signedIn.status === 303, 'signed in via API token', signedIn)
	assert(
		decodeURIComponent(signedIn.location).startsWith('/oauth/authorize?'),
		'sign-in returns to the authorize request',
		signedIn.location,
	)

	const badRedirect = await browser.get(
		`/oauth/authorize?${new URLSearchParams({ ...authParams, redirect_uri: 'https://evil.example/cb' })}`,
	)
	assert(
		badRedirect.status === 400 && badRedirect.text.includes('invalid_request'),
		'unregistered redirect_uri -> error page, no redirect',
		badRedirect.status,
	)
	const noPkce = await browser.get(`/oauth/authorize?${new URLSearchParams({ ...authParams, code_challenge: '' })}`)
	assert(noPkce.status === 400 && noPkce.text.includes('PKCE'), 'missing PKCE -> error page', noPkce.status)
	const plainPkce = await browser.get(
		`/oauth/authorize?${new URLSearchParams({ ...authParams, code_challenge_method: 'plain' })}`,
	)
	assert(plainPkce.status === 400, 'plain PKCE refused', plainPkce.status)
	const wrongResource = await browser.get(
		`/oauth/authorize?${new URLSearchParams({ ...authParams, resource: 'https://other.example/mcp' })}`,
	)
	assert(
		wrongResource.status === 400 && wrongResource.text.includes('invalid_target'),
		'foreign resource indicator refused',
		wrongResource.status,
	)
	const unknownClient = await browser.get(
		`/oauth/authorize?${new URLSearchParams({ ...authParams, client_id: 'mcpc_nope' })}`,
	)
	assert(unknownClient.status === 400 && unknownClient.text.includes('invalid_client'), 'unknown client -> error page')

	const denied = await authorize(browser, authParams, 'deny')
	assert(
		denied.params.error === 'access_denied' && denied.params.state === state,
		'deny redirects with access_denied + state',
		denied.params,
	)
	assert(denied.location.origin === `http://127.0.0.1:${port}`, 'deny goes back to the registered loopback redirect')

	// Tampering with the signed consent state is refused.
	const consent = await browser.get(`/oauth/authorize?${new URLSearchParams(authParams)}`)
	assert(consent.status === 200 && consent.text.includes('Smoke MCP Host'), 'consent page names the client')
	const hidden = hiddenInputs(consent.text)
	const tamperedQ = hidden.q.replace(
		encodeURIComponent(`http://127.0.0.1:${port}/callback`),
		encodeURIComponent('https://host.example/oauth/callback'),
	)
	assert(tamperedQ !== hidden.q, 'tamper setup changed q')
	const tampered = await browser.post('/oauth/authorize', {
		csrf: hidden.csrf,
		q: tamperedQ,
		sig: hidden.sig,
		decision: 'approve',
	})
	assert(
		tampered.status === 400 && tampered.text.includes('did not match'),
		'tampered consent state refused',
		tampered.status,
	)
	const noCsrf = await browser.post('/oauth/authorize', { q: hidden.q, sig: hidden.sig, decision: 'approve' })
	assert(noCsrf.status === 403, 'consent without csrf refused', noCsrf.status)
	log('authorize', 'sign-in gate, redirect/PKCE/resource validation, deny, signed consent state')

	// --- approve -> code -> tokens -------------------------------------------------
	const approved = await authorize(browser, authParams, 'approve')
	assert(
		approved.params.code && approved.params.state === state,
		'approve redirects with code + state',
		Object.keys(approved.params),
	)
	assert(approved.params.iss === baseUrl, 'redirect carries iss (RFC 9207)', approved.params.iss)
	const code = approved.params.code

	const wrongVerifier = await tokenRequest({
		grant_type: 'authorization_code',
		client_id: publicClient,
		code,
		code_verifier: b64url(randomBytes(32)),
		redirect_uri: authParams.redirect_uri,
	})
	assert(
		wrongVerifier.status === 400 && wrongVerifier.json.error === 'invalid_grant',
		'wrong code_verifier -> invalid_grant',
		wrongVerifier.info,
	)
	// The code was consumed by the failed attempt (one-time), so mint a new one.
	const again = await authorize(browser, authParams, 'approve')
	const otherClientAttempt = await tokenRequest(
		{
			grant_type: 'authorization_code',
			client_id: confidential.id,
			code: again.params.code,
			code_verifier: verifier,
			redirect_uri: authParams.redirect_uri,
		},
		{ authorization: `Basic ${Buffer.from(`${confidential.id}:${confidential.secret}`).toString('base64')}` },
	)
	assert(
		otherClientAttempt.status === 400 && otherClientAttempt.json.error === 'invalid_grant',
		'code is bound to its client',
		otherClientAttempt.info,
	)
	const third = await authorize(browser, authParams, 'approve')
	const wrongResourceExchange = await tokenRequest({
		grant_type: 'authorization_code',
		client_id: publicClient,
		code: third.params.code,
		code_verifier: verifier,
		resource: 'https://other.example/mcp',
	})
	assert(
		wrongResourceExchange.status === 400 && wrongResourceExchange.json.error === 'invalid_target',
		'foreign resource at exchange refused',
		wrongResourceExchange.info,
	)

	const fourth = await authorize(browser, authParams, 'approve')
	const tokens = await tokenRequest({
		grant_type: 'authorization_code',
		client_id: publicClient,
		code: fourth.params.code,
		code_verifier: verifier,
		redirect_uri: authParams.redirect_uri,
		resource: `${baseUrl}/mcp`,
	})
	assert(tokens.status === 200 && tokens.json.token_type === 'Bearer', 'token exchange succeeded', {
		status: tokens.status,
		error: tokens.json.error,
	})
	assert(
		tokens.json.access_token?.startsWith('mcpat_') && tokens.json.refresh_token?.startsWith('mcprt_'),
		'access + refresh tokens issued',
	)
	assert(tokens.json.expires_in === 3600, 'access token lifetime', tokens.json.expires_in)
	assert(tokens.json.scope === 'openid profile email', 'unknown scope dropped, known kept', tokens.json.scope)
	const reuse = await tokenRequest({
		grant_type: 'authorization_code',
		client_id: publicClient,
		code: fourth.params.code,
		code_verifier: verifier,
	})
	assert(reuse.status === 400 && reuse.json.error === 'invalid_grant', 'authorization code is single-use', reuse.info)
	log('token', 'PKCE exchange, one-time code, client + resource binding')

	// --- use the access token --------------------------------------------------
	const oauthMcp = new McpClient(tokens.json.access_token)
	await oauthMcp.initialize()
	const found = await oauthMcp.search({ query: 'secret' })
	assert(found.results?.length > 0, 'search works with an OAuth access token', Object.keys(found))
	const whoami = await oauthMcp.run('export default async function main() { return 40 + 2 }')
	assert(whoami === 42, 'execute works with an OAuth access token', whoami)
	const userinfo = await json('/oauth/userinfo', { headers: { authorization: `Bearer ${tokens.json.access_token}` } })
	assert(
		userinfo.status === 200 && userinfo.json.sub === user.id && userinfo.json.email === user.email,
		'userinfo describes the granting user',
		userinfo.json,
	)
	const clients = await mcp.call('mcpClientList')
	const grant = clients.clients.find((c) => c.clientName === 'Smoke MCP Host')
	assert(grant?.id && grant.clientId === publicClient, 'mcpClientList shows the grant', clients)
	assert(
		!JSON.stringify(clients).includes('mcpat_') && !JSON.stringify(clients).includes('mcprt_'),
		'grant listing has no token material',
	)
	const restApi = await fetch(`${baseUrl}/api/call/apiTokenList`, {
		method: 'POST',
		headers: { authorization: `Bearer ${tokens.json.access_token}`, 'content-type': 'application/json' },
		body: '{}',
	})
	assert(restApi.status === 200, 'OAuth token also authenticates /api', restApi.status)
	log('access', 'search + execute + userinfo + /api with the OAuth token; grant listed without material')

	// --- refresh rotation + replay detection ----------------------------------
	const refreshed = await tokenRequest({
		grant_type: 'refresh_token',
		client_id: publicClient,
		refresh_token: tokens.json.refresh_token,
	})
	assert(
		refreshed.status === 200 && refreshed.json.access_token && refreshed.json.refresh_token,
		'refresh issues a new pair',
		refreshed.json.error,
	)
	assert(
		refreshed.json.access_token !== tokens.json.access_token &&
			refreshed.json.refresh_token !== tokens.json.refresh_token,
		'tokens rotated',
	)
	assert((await mcpStatus(tokens.json.access_token)).status === 401, 'previous access token retired on refresh')
	assert((await mcpStatus(refreshed.json.access_token)).status === 200, 'new access token works')
	const graceReplay = await tokenRequest({
		grant_type: 'refresh_token',
		client_id: publicClient,
		refresh_token: tokens.json.refresh_token,
	})
	assert(
		graceReplay.status === 200 && graceReplay.json.access_token === refreshed.json.access_token,
		'immediate replay returns the same pair (lost-response grace)',
		graceReplay.json.error,
	)
	const otherClientRefresh = await tokenRequest(
		{ grant_type: 'refresh_token', client_id: confidential.id, refresh_token: refreshed.json.refresh_token },
		{ authorization: `Basic ${Buffer.from(`${confidential.id}:${confidential.secret}`).toString('base64')}` },
	)
	assert(
		otherClientRefresh.status === 400 && otherClientRefresh.json.error === 'invalid_grant',
		'refresh token bound to its client',
		otherClientRefresh.info,
	)
	const second = await tokenRequest({
		grant_type: 'refresh_token',
		client_id: publicClient,
		refresh_token: refreshed.json.refresh_token,
	})
	assert(second.status === 200, 'second rotation')
	const thirdRotation = await tokenRequest({
		grant_type: 'refresh_token',
		client_id: publicClient,
		refresh_token: second.json.refresh_token,
	})
	assert(thirdRotation.status === 200, 'third rotation')
	// The first refresh token is now two generations old: replay must kill the family.
	const staleReplay = await tokenRequest({
		grant_type: 'refresh_token',
		client_id: publicClient,
		refresh_token: tokens.json.refresh_token,
	})
	assert(
		staleReplay.status === 400 && staleReplay.json.error === 'invalid_grant',
		'stale refresh replay refused',
		staleReplay.info,
	)
	assert(
		(await mcpStatus(thirdRotation.json.access_token)).status === 401,
		'replay revoked the whole family (live access token dead)',
	)
	const familyDead = await tokenRequest({
		grant_type: 'refresh_token',
		client_id: publicClient,
		refresh_token: thirdRotation.json.refresh_token,
	})
	assert(familyDead.status === 400, 'live refresh token also dead after replay')
	log('refresh', 'rotation, grace replay, client binding, family revocation on stale replay')

	// --- revocation (RFC 7009) --------------------------------------------------
	const fresh = await authorize(browser, authParams, 'approve')
	const pair = await tokenRequest({
		grant_type: 'authorization_code',
		client_id: publicClient,
		code: fresh.params.code,
		code_verifier: verifier,
	})
	assert(pair.status === 200, 'fresh pair for revocation tests')
	const revokeWrongClient = await fetch(`${baseUrl}/oauth/revoke`, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			authorization: `Basic ${Buffer.from(`${confidential.id}:${confidential.secret}`).toString('base64')}`,
		},
		body: new URLSearchParams({ token: pair.json.access_token }).toString(),
	})
	assert(revokeWrongClient.status === 200, 'revoke by another client answers 200 (RFC 7009)')
	assert((await mcpStatus(pair.json.access_token)).status === 200, 'but does not revoke a token it does not own')
	const revokeAccess = await fetch(`${baseUrl}/oauth/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: pair.json.access_token, client_id: publicClient }).toString(),
	})
	assert(
		revokeAccess.status === 200 && (await mcpStatus(pair.json.access_token)).status === 401,
		'access token revoked',
	)
	const afterAccessRevoke = await tokenRequest({
		grant_type: 'refresh_token',
		client_id: publicClient,
		refresh_token: pair.json.refresh_token,
	})
	assert(afterAccessRevoke.status === 200, 'refresh token survives access-token revocation')
	const revokeRefresh = await fetch(`${baseUrl}/oauth/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: afterAccessRevoke.json.refresh_token, client_id: publicClient }).toString(),
	})
	assert(
		revokeRefresh.status === 200 && (await mcpStatus(afterAccessRevoke.json.access_token)).status === 401,
		'revoking the refresh token ends the family',
	)
	log('revoke', 'RFC 7009 access + refresh revocation, client-bound')

	// --- confidential client auth ------------------------------------------------
	const confParams = {
		response_type: 'code',
		client_id: confidential.id,
		redirect_uri: 'https://server.example/cb',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		scope: 'openid',
		state: 's',
	}
	const confApproved = await authorize(browser, confParams, 'approve')
	assert(confApproved.location.origin === 'https://server.example', 'confidential redirect')
	const noSecret = await tokenRequest({
		grant_type: 'authorization_code',
		client_id: confidential.id,
		code: confApproved.params.code,
		code_verifier: verifier,
	})
	assert(
		noSecret.status === 401 && noSecret.json.error === 'invalid_client',
		'confidential client without secret -> invalid_client',
		noSecret.info,
	)
	const wrongSecret = await tokenRequest(
		{
			grant_type: 'authorization_code',
			client_id: confidential.id,
			code: confApproved.params.code,
			code_verifier: verifier,
		},
		{ authorization: `Basic ${Buffer.from(`${confidential.id}:mcps_wrong`).toString('base64')}` },
	)
	assert(wrongSecret.status === 401, 'wrong secret -> 401')
	const confAgain = await authorize(browser, confParams, 'approve')
	const confTokens = await tokenRequest(
		{ grant_type: 'authorization_code', code: confAgain.params.code, code_verifier: verifier },
		{ authorization: `Basic ${Buffer.from(`${confidential.id}:${confidential.secret}`).toString('base64')}` },
	)
	assert(
		confTokens.status === 200 && confTokens.json.access_token,
		'client_secret_basic exchange works',
		confTokens.json.error,
	)
	assert(confTokens.json.scope === 'openid', 'scope narrowed to what was requested')
	log('confidential', 'client_secret_basic enforced')

	// --- user revokes the grant from the account UI ---------------------------
	const clientsPage = await browser.get('/account/clients')
	assert(
		clientsPage.status === 200 && clientsPage.text.includes('Smoke Server Client'),
		'account clients page lists the grant',
	)
	const csrf = hiddenInputs(clientsPage.text).csrf
	const revoked = await browser.post('/account/clients', { action: 'revoke_all', csrf })
	assert(revoked.status === 303, 'user revoked all MCP clients', revoked)
	assert((await mcpStatus(confTokens.json.access_token)).status === 401, 'grant revocation kills live access tokens')
	const deadRefresh = await tokenRequest(
		{ grant_type: 'refresh_token', refresh_token: confTokens.json.refresh_token },
		{ authorization: `Basic ${Buffer.from(`${confidential.id}:${confidential.secret}`).toString('base64')}` },
	)
	assert(deadRefresh.status === 400, 'grant revocation kills refresh tokens')
	const listAfter = await mcp.call('mcpClientList')
	assert(listAfter.clients.length === 0, 'no grants left', listAfter)
	const audit = await admin.audit({ action: 'mcp_client', limit: 50 })
	const actions = new Set(audit.json.entries.map((e) => e.action))
	for (const expected of ['mcp_client.register', 'mcp_client.authorize', 'mcp_client.deny']) {
		assert(actions.has(expected), `audit has ${expected}`, [...actions])
	}
	assert(
		!JSON.stringify(audit.json).includes('mcpat_') && !JSON.stringify(audit.json).includes('mcps_'),
		'audit log has no token or secret material',
	)
	log('grant', 'user-side revocation from /account/clients; audited without material')

	// Sandbox code must not be able to mint credentials.
	const forged = await mcp.execute(
		`import { kody } from 'kody:runtime'\nexport default async function main() { return await kody.apiTokenCreate({ label: 'forged' }) }`,
	)
	assert(!forged.ok, 'apiTokenCreate refused from sandbox code', forged)
	log('invariant', 'credential minting refused inside runs')
}
