// MCP servers with OAuth (#44 PR B): add → authenticating, consent page, provider redirect, callback,
// calls, refresh on an expired access token, revoked grant → reauthorize, metadata document, remove.
import { randomBytes } from 'node:crypto'
import { admin, assert, Browser, hiddenInputs, log } from './lib.mjs'
import { startMockOAuthMcpServer } from './mcp-oauth-mock.mjs'

export async function smokeMcpOAuth(ctx) {
	const { mcp } = ctx
	const mock = await startMockOAuthMcpServer({ port: Number(process.env.SMOKE_MCP_OAUTH_PORT ?? 9799) })
	const leaks = (value) => mock.issued.some((token) => JSON.stringify(value).includes(token))
	try {
		const added = await mcp.call('mcpServerAdd', { name: 'smoke-oauth', url: mock.url })
		assert(
			added.status === 'authenticating' && /\/account\/mcp-servers\/smoke-oauth\/authorize$/.test(added.authUrl ?? ''),
			'mcpServerAdd parks an OAuth server with an authUrl',
			added,
		)
		assert(added.oauthCallbackUrl.endsWith('/account/mcp-servers/oauth/callback'), 'oauthCallbackUrl', added)
		const blocked = await mcp.execute(
			`import { kody } from 'kody:runtime'\nexport default async () => kody.mcp['smoke-oauth'].echo({ text: 'x' })`,
		)
		assert(
			!blocked.ok && /mcp_server_unauthorized/.test(blocked.error?.message ?? ''),
			'calls before authorization fail with mcp_server_unauthorized',
			blocked.error,
		)
		log('add', 'authenticating, call refused')

		// Sign in like smoke/mcp-servers.mjs.
		const invite = await admin.invite(ctx.user.id)
		assert(invite.status === 201, 'admin invite', invite)
		const browser = new Browser()
		const password = `pw-${randomBytes(12).toString('hex')}`
		await browser.get(invite.json.url)
		const accepted = await browser.post(invite.json.url, { password, confirm: password })
		assert(accepted.status === 303, 'signed in', accepted.status)

		const authorizePath = new URL(added.authUrl).pathname
		const consent = await browser.get(authorizePath)
		assert(
			consent.status === 200 && /dynamic client registration/.test(consent.text),
			'consent page shows the client mode',
			consent.status,
		)
		const continued = await browser.post(authorizePath, hiddenInputs(consent.text))
		assert(continued.status === 303, 'Continue redirects to the provider', continued.status)
		// The mock's base host is what the worker reaches (host.docker.internal in CI); the runner talks to it on 127.0.0.1.
		const providerUrl = new URL(continued.location)
		providerUrl.hostname = '127.0.0.1'
		const provider = await browser.fetch(providerUrl.href)
		assert(provider.status === 302, 'provider redirects back with a code', provider.status)
		const callback = new URL(provider.location)
		const callbackPath = callback.pathname + callback.search
		const done = await browser.get(callbackPath)
		assert(done.status === 303 && /mcp_auth_success/.test(done.location ?? ''), 'callback succeeds', {
			status: done.status,
			location: done.location,
		})
		assert(done.headers.get('referrer-policy') === 'no-referrer', 'callback sends referrer-policy no-referrer')
		const replayed = await browser.get(callbackPath)
		assert(
			replayed.status === 303 && !/mcp_auth_success/.test(replayed.location ?? ''),
			'a replayed callback does not succeed again',
			{ status: replayed.status, location: replayed.location },
		)
		const bogus = await browser.get('/account/mcp-servers/oauth/callback?state=bogus&code=x')
		assert(bogus.status === 400, 'an unknown state is refused', bogus.status)
		log('authorize', 'consent → provider → callback; replay and unknown state refused')

		const listed = await mcp.call('mcpServerList')
		const server = listed.servers.find((s) => s.name === 'smoke-oauth')
		assert(
			server?.status === 'ready' && server.oauth?.hasRefreshToken === true && server.authUrl === null,
			'server is ready with a refresh token',
			server,
		)
		assert(!leaks(listed), 'mcpServerList never contains a token')
		const echoed = await mcp.run(
			`import { kody } from 'kody:runtime'\nexport default async () => kody.mcp['smoke-oauth'].echo({ text: 'hi' })`,
		)
		assert(echoed.content?.[0]?.text === 'hi', 'call works after authorization', echoed)

		mock.expireAccessTokens()
		const after = await mcp.run(
			`import { kody } from 'kody:runtime'\nexport default async () => kody.mcp['smoke-oauth'].echo({ text: 'again' })`,
		)
		assert(after.content?.[0]?.text === 'again', 'an expired access token is refreshed transparently', after)
		assert(
			mock.tokenRequests.filter((r) => r.grantType === 'refresh_token').length === 1,
			'exactly one refresh',
			mock.tokenRequests,
		)
		log('refresh', 'expired access token → one refresh, call ok')

		mock.expireAccessTokens()
		mock.revokeRefreshTokens()
		const revoked = await mcp.execute(
			`import { kody } from 'kody:runtime'\nexport default async () => kody.mcp['smoke-oauth'].echo({ text: 'x' })`,
		)
		assert(
			!revoked.ok && /mcp_server_unauthorized/.test(revoked.error?.message ?? ''),
			'a revoked grant asks for authorization',
			revoked.error,
		)
		const reconnected = await mcp.call('mcpServerReconnect', { server: 'smoke-oauth' })
		assert(
			reconnected.status === 'authenticating' && reconnected.authUrl,
			'mcpServerReconnect returns a fresh authUrl',
			reconnected,
		)
		log('revoke', 'unauthorized → reconnect → authUrl')

		const metadata = await browser.fetch('/oauth/client-metadata.json', { accept: 'application/json' })
		assert(metadata.status === 404, 'no client metadata document on an http origin', metadata.status)

		const page = await browser.get('/account/mcp-servers')
		assert(
			page.status === 200 && page.text.includes('Authorize') && !leaks(page.text),
			'account page shows Authorize, no tokens',
		)
		const removed = await mcp.call('mcpServerRemove', { name: 'smoke-oauth' })
		assert(removed.removed === true, 'remove')
		log('remove', 'done')
	} finally {
		await mock.close()
	}
}
