// M6 OAuth integration smoke, against a mock provider hosted by this process:
// BYO app save (client secret never echoed), one-time connect link -> PKCE +
// state -> callback exchange host-side, {{integration-token}} injection through
// createAuthenticatedFetch, allowedHosts + usage grants, automatic refresh on
// expiry and on 401 replay, refresh-token rotation, auth_failed on invalid_grant
// with integration.auth.* subscriptions, client_credentials, and no token
// material anywhere outside the gateway.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { admin, assert, baseUrl, log, readPackageDir, sha256, waitFor } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageName = '@kody-smoke/oauth-client'

function safeEqual(a, b) {
	const x = Buffer.from(String(a ?? ''))
	const y = Buffer.from(String(b ?? ''))
	return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * A minimal OAuth 2.0 authorization server + resource API. Tokens are random,
 * live only in this process, and are compared by digest; nothing is printed.
 */
async function startMockProvider(port) {
	const host = process.env.SMOKE_ECHO_HOST ?? '127.0.0.1'
	const bind = process.env.SMOKE_ECHO_BIND ?? (host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')
	const clientId = `smoke-client-${randomBytes(4).toString('hex')}`
	const clientSecret = `smoke-secret-${randomBytes(16).toString('hex')}`
	const state = {
		clientId,
		clientSecret,
		codes: new Map(), // code -> { challenge, redirectUri, scope }
		accessToken: null,
		refreshToken: null,
		expiresIn: 3600,
		authorizeRequests: [],
		tokenRequests: [],
		apiHits: [],
		hits: [],
	}
	const issue = (scope) => {
		state.accessToken = `at-${randomBytes(24).toString('hex')}`
		state.refreshToken = `rt-${randomBytes(24).toString('hex')}`
		return {
			access_token: state.accessToken,
			refresh_token: state.refreshToken,
			token_type: 'Bearer',
			expires_in: state.expiresIn,
			scope,
		}
	}
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, `http://${host}:${port}`)
		let body = ''
		for await (const chunk of req) body += chunk
		state.hits.push({ method: req.method, path: url.pathname })
		const json = (status, payload) => {
			res.statusCode = status
			res.setHeader('content-type', 'application/json')
			res.end(JSON.stringify(payload))
		}
		if (url.pathname === '/authorize') {
			const params = Object.fromEntries(url.searchParams)
			state.authorizeRequests.push({
				client_id: params.client_id,
				scope: params.scope,
				code_challenge_method: params.code_challenge_method,
				has_state: Boolean(params.state),
				has_challenge: Boolean(params.code_challenge),
				redirect_uri: params.redirect_uri,
				response_type: params.response_type,
				extra: params.prompt,
			})
			if (params.client_id !== clientId) return json(400, { error: 'invalid_client' })
			if (params.response_type !== 'code') return json(400, { error: 'unsupported_response_type' })
			if (params.code_challenge_method !== 'S256') return json(400, { error: 'invalid_request' })
			const code = `code-${randomBytes(12).toString('hex')}`
			state.codes.set(code, { challenge: params.code_challenge, redirectUri: params.redirect_uri, scope: params.scope })
			const redirect = new URL(params.redirect_uri)
			redirect.searchParams.set('code', code)
			redirect.searchParams.set('state', params.state)
			res.statusCode = 302
			res.setHeader('location', redirect.toString())
			return res.end()
		}
		if (url.pathname === '/token' && req.method === 'POST') {
			const form = new URLSearchParams(body)
			let id = form.get('client_id')
			let secret = form.get('client_secret')
			let authStyle = 'body'
			const auth = req.headers.authorization ?? ''
			if (auth.startsWith('Basic ')) {
				const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':')
				id = decodeURIComponent(u ?? '')
				secret = decodeURIComponent(p ?? '')
				authStyle = 'basic'
			}
			const grant = form.get('grant_type')
			state.tokenRequests.push({ grant, authStyle, contentType: req.headers['content-type'] })
			if (!safeEqual(id, clientId) || !safeEqual(secret, clientSecret)) return json(401, { error: 'invalid_client' })
			if (grant === 'authorization_code') {
				const entry = state.codes.get(form.get('code'))
				state.codes.delete(form.get('code'))
				if (!entry) return json(400, { error: 'invalid_grant' })
				const verifier = form.get('code_verifier') ?? ''
				const challenge = createHash('sha256').update(verifier).digest('base64url')
				if (!safeEqual(challenge, entry.challenge)) return json(400, { error: 'invalid_grant', hint: 'pkce' })
				if (form.get('redirect_uri') !== entry.redirectUri)
					return json(400, { error: 'invalid_grant', hint: 'redirect' })
				return json(200, issue(entry.scope))
			}
			if (grant === 'refresh_token') {
				if (!state.refreshToken || !safeEqual(form.get('refresh_token'), state.refreshToken)) {
					return json(400, { error: 'invalid_grant' })
				}
				return json(200, issue('read write'))
			}
			if (grant === 'client_credentials') {
				state.accessToken = `cc-${randomBytes(24).toString('hex')}`
				return json(200, { access_token: state.accessToken, token_type: 'Bearer', expires_in: state.expiresIn })
			}
			return json(400, { error: 'unsupported_grant_type' })
		}
		if (url.pathname === '/api/me') {
			const auth = req.headers.authorization ?? ''
			const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
			const ok = Boolean(state.accessToken) && safeEqual(token, state.accessToken)
			state.apiHits.push({ ok, hadPlaceholder: auth.includes('{{'), authorizationSha256: sha256(auth) })
			if (!ok) return json(401, { error: 'invalid_token' })
			return json(200, { ok: true, user: 'smoke', tokenSha256: sha256(token) })
		}
		json(404, { error: 'not_found' })
	})
	await new Promise((resolve) => server.listen(port, bind, resolve))
	return {
		state,
		host,
		url: `http://${host}:${port}`,
		// Where *this* process reaches the provider (Kody may use a Docker-only host name).
		localUrl: `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	}
}

async function fetchNoRedirect(url, init) {
	return fetch(url, { ...init, redirect: 'manual' })
}

/** Plays the user's browser: confirm page -> provider -> Kody callback. */
async function completeConnect(link, provider, { expectFailure = false } = {}) {
	const page = await fetch(link)
	const html = await page.text()
	assert(page.status === 200, 'connect page should render', { status: page.status, body: html.slice(0, 400) })
	assert(html.includes('Continue to') && html.includes(provider.host), 'connect page should show provider + hosts')
	const ticket = new URL(link).searchParams.get('ticket')
	const start = await fetchNoRedirect(link.split('?')[0], {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ ticket }).toString(),
	})
	assert(start.status === 303, 'POST connect should redirect to the provider', { status: start.status })
	const authorizeUrl = new URL(start.headers.get('location'))
	assert(authorizeUrl.origin === provider.url, 'redirect should target the mock provider', authorizeUrl.origin)
	const providerHop = await fetchNoRedirect(`${provider.localUrl}${authorizeUrl.pathname}${authorizeUrl.search}`)
	assert(providerHop.status === 302, 'provider should redirect back with a code', providerHop.status)
	const callback = new URL(providerHop.headers.get('location'))
	// KODY_PUBLIC_URL may differ from the URL this process reaches Kody on (Docker).
	const callbackHere = `${baseUrl}${callback.pathname}${callback.search}`
	const done = await fetch(callbackHere)
	const doneHtml = await done.text()
	if (expectFailure) return { status: done.status, html: doneHtml, callback, authorizeUrl }
	assert(done.status === 200 && /connected/i.test(doneHtml), 'callback should report success', {
		status: done.status,
		html: doneHtml.slice(0, 400),
	})
	return { status: done.status, html: doneHtml, callback, authorizeUrl }
}

export async function smokeIntegrations({ mcp, user }) {
	const provider = await startMockProvider(Number(process.env.SMOKE_OAUTH_PORT ?? 9796))
	const { state } = provider
	const name = 'smoke-oauth'
	const secretsSeen = () => [state.clientSecret, state.accessToken, state.refreshToken].filter(Boolean)
	const assertClean = (label, value) => {
		const text = JSON.stringify(value)
		for (const s of secretsSeen()) assert(!text.includes(s), `${label} must never contain token/secret material`)
	}
	try {
		const files = await readPackageDir(path.join(here, '..', 'examples', 'packages', 'oauth-client'))
		const saved = await mcp.call('packageSave', { files, source: 'examples/packages/oauth-client' })
		assert(saved.name === packageName, 'packageSave returned the wrong package', saved)
		log('packageSave', { name: saved.name, subscriptions: (saved.manifest.subscriptions ?? []).map((s) => s.topic) })

		const found = await mcp.search({ entity: 'capability', domain: 'integrations' })
		const ids = new Set(found.results.map((hit) => hit.id))
		for (const expected of [
			'integrationSave',
			'integrationList',
			'integrationGet',
			'integrationConnect',
			'integrationTokenRefresh',
			'integrationSetUsage',
			'integrationDisconnect',
			'integrationDelete',
		]) {
			assert(ids.has(expected), `search should surface ${expected}`, [...ids])
		}
		const byQuery = await mcp.search({ query: 'connect github oauth' })
		assert(
			byQuery.results.some((hit) => hit.id === 'integrationSave' || hit.id === 'integrationConnect'),
			'free-text search should find the integration capabilities',
			byQuery.results.map((r) => r.id),
		)
		log('search', 'integration capabilities discoverable')

		await mcp.call('integrationDelete', { name }).catch(() => {})
		const created = await mcp.call('integrationSave', {
			name,
			provider: 'Smoke Provider',
			authorizeUrl: `${provider.url}/authorize`,
			tokenUrl: `${provider.url}/token`,
			clientId: state.clientId,
			clientSecret: state.clientSecret,
			scopes: ['read', 'write'],
			authorizeParams: { prompt: 'consent' },
			allowedHosts: [provider.host],
		})
		assertClean('integrationSave result', created)
		assert(
			created.status === 'pending' && created.hasClientSecret === true,
			'new integration should be pending',
			created,
		)
		assert(created.placeholder === `{{integration-token:${name}}}`, 'placeholder shape', created.placeholder)
		assert(created.redirectUri.endsWith('/connect/oauth/callback'), 'redirectUri', created.redirectUri)
		log('integrationSave', { status: created.status, redirectUri: created.redirectUri })

		// Package code may not manage integrations.
		const fromPackage = await mcp.execute(
			`import { kody } from 'kody:runtime'
export default async function main() { return await kody.integrationList() }`,
		)
		assert(fromPackage.ok, 'ad hoc execute may list integrations', fromPackage)
		assertClean('integrationList', fromPackage.result)

		// --- connect flow
		const link = await mcp.call('integrationConnect', { name })
		assert(link.url.startsWith(`${baseUrl}/connect/oauth/`), 'connect url should be on Kody', link.url)
		const beforeConnect = await mcp.call('integrationGet', { name })
		assert(
			beforeConnect.latestConnect?.startedAt === null,
			'connect attempt should be pending',
			beforeConnect.latestConnect,
		)
		const connected = await completeConnect(link.url, provider)
		assertClean('callback page', connected.html)
		assert(state.authorizeRequests.length === 1, 'exactly one authorize request', state.authorizeRequests)
		const authz = state.authorizeRequests[0]
		assert(
			authz.code_challenge_method === 'S256' && authz.has_state && authz.has_challenge && authz.scope === 'read write',
			'authorize request should carry PKCE S256 + state + scopes',
			authz,
		)
		assert(authz.extra === 'consent', 'authorizeParams should be forwarded', authz)
		assert(
			state.tokenRequests.length === 1 && state.tokenRequests[0].grant === 'authorization_code',
			'one code exchange host-side',
			state.tokenRequests,
		)
		const after = await mcp.call('integrationGet', { name })
		assertClean('integrationGet', after)
		assert(after.status === 'connected' && after.grantedScope === 'read write', 'should be connected', after)
		assert(after.latestConnect?.completedAt, 'connect attempt should be completed', after.latestConnect)
		log('connect', { status: after.status, grantedScope: after.grantedScope, expiresAt: after.expiresAt })

		// One-time link: replaying the confirm POST fails.
		const replay = await fetchNoRedirect(link.url.split('?')[0], {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ ticket: new URL(link.url).searchParams.get('ticket') }).toString(),
		})
		assert(replay.status === 404, 'replaying the connect link must fail', replay.status)
		// Callback replay / forged state fails.
		const forged = await fetch(
			`${baseUrl}${connected.callback.pathname}?code=nope&state=${encodeURIComponent('AAAA.BBBB.CCCC')}`,
		)
		assert(forged.status >= 400, 'forged state must be rejected', forged.status)
		const replayCallback = await fetch(`${baseUrl}${connected.callback.pathname}${connected.callback.search}`)
		assert(replayCallback.status >= 400, 'callback replay must be rejected', replayCallback.status)
		log('connect link', 'one-time; forged/replayed callbacks rejected')

		// --- injection via ad hoc code and via createAuthenticatedFetch in a package
		const apiUrl = `${provider.url}/api/me`
		const adHoc = await mcp.execute(
			`export default async function main({ url }) {
  const res = await fetch(url, { headers: { authorization: 'Bearer {{integration-token:${name}}}' } })
  return { status: res.status, body: await res.json() }
}`,
			{ url: apiUrl },
		)
		assert(adHoc.ok && adHoc.result.status === 200, 'ad hoc call with the placeholder should succeed', adHoc)
		assertClean('ad hoc execute payload', adHoc)
		assert(state.apiHits.at(-1).ok && !state.apiHits.at(-1).hadPlaceholder, 'token injected, placeholder gone')
		assert(
			adHoc.gateway.some((e) => e.outcome === 'injected' && e.secrets.includes(`integration-token:${name}`)),
			'gateway event names the integration token',
			adHoc.gateway,
		)
		const viaPackage = await mcp.callDirect('packageRun', {
			name: packageName,
			export: './call',
			params: { integration: name, url: apiUrl },
		})
		assert(
			viaPackage.ok && viaPackage.result.status === 200,
			'createAuthenticatedFetch call should succeed',
			viaPackage,
		)
		assertClean('packageRun payload', viaPackage)
		log('injection', { adHoc: adHoc.result.status, createAuthenticatedFetch: viaPackage.result.status })

		// --- host allowlist: "localhost" is not in allowedHosts even though it is the same server.
		const otherHost = await mcp.execute(
			`export default async function main({ url }) {
  const res = await fetch(url, { headers: { authorization: 'Bearer {{integration-token:${name}}}' } })
  return { status: res.status, body: await res.json() }
}`,
			{ url: apiUrl.replace(provider.host, 'localhost') },
		)
		assert(
			otherHost.ok && otherHost.result.status === 403 && otherHost.result.body.error === 'integration_host_not_allowed',
			'token must not be sent to a host outside allowedHosts',
			otherHost.result,
		)
		log('allowedHosts', otherHost.result.body.error)

		// --- usage grant: lock to the package, ad hoc code is refused.
		const locked = await mcp.call('integrationSetUsage', { name, usage: { mode: 'packages', packages: [packageName] } })
		assert(locked.usage.mode === 'packages', 'usage should be package-limited', locked.usage)
		const adHocLocked = await mcp.execute(
			`export default async function main({ url }) {
  const res = await fetch(url, { headers: { authorization: 'Bearer {{integration-token:${name}}}' } })
  return { status: res.status, body: await res.json() }
}`,
			{ url: apiUrl },
		)
		assert(
			adHocLocked.ok && adHocLocked.result.status === 403 && adHocLocked.result.body.error === 'integration_locked',
			'ad hoc code must be refused once usage is package-limited',
			adHocLocked.result,
		)
		const pkgStill = await mcp.callDirect('packageRun', {
			name: packageName,
			export: './call',
			params: { integration: name, url: apiUrl },
		})
		assert(pkgStill.ok && pkgStill.result.status === 200, 'granted package still works', pkgStill)
		await mcp.call('integrationSetUsage', { name, usage: { mode: 'any' } })
		log('usage grant', { adHoc: adHocLocked.result.body.error, package: pkgStill.result.status })

		// --- refresh on expiry: reconnect with a short-lived token (inside the 60s skew => expired at once).
		state.expiresIn = 30
		const link2 = await mcp.call('integrationConnect', { name })
		await completeConnect(link2.url, provider)
		state.expiresIn = 3600 // the refreshed token must outlive the skew, or every call would refresh
		const tokenRequestsBefore = state.tokenRequests.length
		const expired = await mcp.callDirect('packageRun', {
			name: packageName,
			export: './call',
			params: { integration: name, url: apiUrl },
		})
		assert(expired.ok && expired.result.status === 200, 'expired token should be refreshed transparently', expired)
		assert(
			state.tokenRequests.length === tokenRequestsBefore + 1 && state.tokenRequests.at(-1).grant === 'refresh_token',
			'a refresh_token grant should have happened host-side',
			state.tokenRequests.slice(tokenRequestsBefore),
		)
		const refreshedMeta = await mcp.call('integrationGet', { name })
		assert(refreshedMeta.refreshedAt, 'refreshedAt should be set', refreshedMeta)
		assertClean('integrationGet after refresh', refreshedMeta)
		log('refresh on expiry', { refreshedAt: refreshedMeta.refreshedAt })

		// integration.auth.succeeded reached the subscribed package (metadata only).
		const events = await waitFor(
			'integration.auth.succeeded subscription',
			async () => {
				const status = await mcp.callDirect('packageRun', { name: packageName, params: {} })
				const hit = status.result.events.find(
					(e) => e.topic === 'integration.auth.succeeded' && e.summary.name === name && e.summary.source === 'refresh',
				)
				return hit ? status.result.events : null
			},
			{ timeoutMs: 20_000, intervalMs: 1_000 },
		)
		assertClean('subscription events', events)
		log('subscription', { topics: [...new Set(events.map((e) => e.topic))] })

		// --- 401 replay: provider revokes the access token; the gateway refreshes once and retries.
		state.accessToken = `revoked-${randomBytes(8).toString('hex')}`
		const before401 = state.tokenRequests.length
		const replayed = await mcp.execute(
			`export default async function main({ url }) {
  const res = await fetch(url, { headers: { authorization: 'Bearer {{integration-token:${name}}}' } })
  return { status: res.status }
}`,
			{ url: apiUrl },
		)
		assert(replayed.ok && replayed.result.status === 200, '401 should be retried after a refresh', replayed)
		assert(state.tokenRequests.length === before401 + 1, 'exactly one refresh for the 401 replay')
		assert(
			replayed.gateway.some((e) => e.reason === 'integration_refreshed'),
			'gateway should record the refresh-and-replay',
			replayed.gateway,
		)
		log('401 replay', 'refreshed once and retried')

		// --- dead refresh token: invalid_grant => auth_failed + integration.auth.failed.
		state.accessToken = `revoked-${randomBytes(8).toString('hex')}`
		state.refreshToken = null
		const dead = await mcp.execute(
			`export default async function main({ url }) {
  const res = await fetch(url, { headers: { authorization: 'Bearer {{integration-token:${name}}}' } })
  return { status: res.status, body: await res.json() }
}`,
			{ url: apiUrl },
		)
		assert(dead.ok && dead.result.status === 401, 'a dead refresh token surfaces as 401', dead.result)
		const failedMeta = await mcp.call('integrationGet', { name })
		assert(
			failedMeta.status === 'auth_failed' && failedMeta.authFailedReason,
			'status should be auth_failed',
			failedMeta,
		)
		const failedEvents = await waitFor(
			'integration.auth.failed subscription',
			async () => {
				const status = await mcp.callDirect('packageRun', { name: packageName, params: {} })
				return status.result.events.some((e) => e.topic === 'integration.auth.failed' && e.summary.name === name)
					? status.result.events
					: null
			},
			{ timeoutMs: 20_000, intervalMs: 1_000 },
		)
		assertClean('failed subscription events', failedEvents)
		const manualRefresh = await mcp.execute(
			`import { kody } from 'kody:runtime'
export default async function main() { return await kody.integrationTokenRefresh({ name: ${JSON.stringify(name)} }) }`,
		)
		assert(
			!manualRefresh.ok && /reconnect/i.test(manualRefresh.error?.message ?? ''),
			'manual refresh should ask to reconnect',
			manualRefresh.error,
		)
		const notConnected = await mcp.execute(
			`export default async function main({ url }) {
  const res = await fetch(url, { headers: { authorization: 'Bearer {{integration-token:${name}}}' } })
  return { status: res.status, body: await res.json() }
}`,
			{ url: apiUrl },
		)
		assert(
			notConnected.result.status === 401 && notConnected.result.body.error === 'integration_not_connected',
			'auth_failed integrations fail closed',
			notConnected.result,
		)
		log('auth_failed', { reason: failedMeta.authFailedReason })

		// Reconnect heals it.
		const link3 = await mcp.call('integrationConnect', { name })
		await completeConnect(link3.url, provider)
		const healed = await mcp.call('integrationGet', { name })
		assert(
			healed.status === 'connected' && healed.authFailedReason === null,
			'reconnect should clear auth_failed',
			healed,
		)
		log('reconnect', healed.status)

		// Provider denial on the callback (user clicked cancel).
		const link4 = await mcp.call('integrationConnect', { name })
		const page4 = await fetchNoRedirect(link4.url.split('?')[0], {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ ticket: new URL(link4.url).searchParams.get('ticket') }).toString(),
		})
		const authorize4 = new URL(page4.headers.get('location'))
		const deniedCallback = await fetch(
			`${baseUrl}/connect/oauth/callback?error=access_denied&state=${encodeURIComponent(authorize4.searchParams.get('state'))}`,
		)
		assert(deniedCallback.status >= 400, 'provider denial should render an error page', deniedCallback.status)
		const stillConnected = await mcp.call('integrationGet', { name })
		assert(
			stillConnected.status === 'connected',
			'a denied re-connect must not disturb the live connection',
			stillConnected,
		)
		log('provider denial', 'error page, existing connection kept')

		// --- client_credentials with basic token auth
		const m2m = 'smoke-m2m'
		await mcp.call('integrationDelete', { name: m2m }).catch(() => {})
		const m2mSaved = await mcp.call('integrationSave', {
			name: m2m,
			flow: 'client_credentials',
			tokenUrl: `${provider.url}/token`,
			clientId: state.clientId,
			clientSecret: state.clientSecret,
			tokenAuthStyle: 'basic',
			allowedHosts: [provider.host],
		})
		assertClean('m2m save', m2mSaved)
		const minted = await mcp.call('integrationTokenRefresh', { name: m2m })
		assertClean('m2m refresh', minted)
		assert(minted.status === 'connected', 'client_credentials should be connected after refresh', minted)
		assert(
			state.tokenRequests.at(-1).grant === 'client_credentials' && state.tokenRequests.at(-1).authStyle === 'basic',
			'client_credentials grant with basic auth',
			state.tokenRequests.at(-1),
		)
		const m2mCall = await mcp.run(
			`import { oauthClientCredentials } from 'kody:runtime'
export default async function main({ url }) {
  const authed = oauthClientCredentials(${JSON.stringify(m2m)})
  const res = await authed(url)
  return { status: res.status }
}`,
			{ url: apiUrl },
		)
		assert(m2mCall.status === 200, 'client_credentials token should be injected', m2mCall)
		log('client_credentials', { status: minted.status })

		// --- nothing leaked: run history, audit log, admin runs.
		const runs = await admin.runs(user.id, 50)
		assertClean('admin runs', runs.json)
		const audit = await admin.audit({ target: name })
		assertClean('audit log', audit.json)
		assert(
			audit.json.entries.some((e) => e.action === 'integration.save') &&
				audit.json.entries.some((e) => e.action === 'integration.connect_start'),
			'audit should record integration actions',
			audit.json.entries.map((e) => e.action),
		)
		const listed = await mcp.call('integrationList')
		assertClean('integrationList', listed)
		assert(
			listed.integrations.some((i) => i.name === name && i.status === 'connected'),
			'list shows connection',
			listed,
		)
		log('no leaks', { runs: runs.json.runs?.length ?? 0, audit: audit.json.entries.length })

		// --- disconnect + delete
		const disconnected = await mcp.call('integrationDisconnect', { name })
		assert(
			disconnected.status === 'pending' && disconnected.expiresAt === null,
			'disconnect drops tokens',
			disconnected,
		)
		const deleted = await mcp.call('integrationDelete', { name })
		assert(deleted.deleted === true, 'delete', deleted)
		await mcp.call('integrationDelete', { name: m2m })
		const gone = await mcp.execute(
			`export default async function main({ url }) {
  const res = await fetch(url, { headers: { authorization: 'Bearer {{integration-token:${name}}}' } })
  return { status: res.status, body: await res.json() }
}`,
			{ url: apiUrl },
		)
		assert(
			gone.result.status === 404 && gone.result.body.error === 'integration_not_found',
			'deleted integration',
			gone.result,
		)
		log('disconnect/delete', 'ok')
	} finally {
		await provider.close()
	}
}
