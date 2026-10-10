import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { buildMasterKeyring } from '../lib/crypto.ts'
import { oauthPolicyFetch } from './client.ts'
import { refreshMcpTokens } from './oauth.ts'
import { mcpConfigFromEnv } from './policy.ts'
import {
	addMcpServer,
	callMcpTool,
	describeMcpOAuth,
	finishMcpOAuth,
	mcpServerResult,
	reconnectMcpServer,
	removeMcpOAuthClient,
	refreshMcpServer,
	setMcpOAuthClient,
	startMcpOAuth,
	type McpDeps,
	type McpServerCell,
} from './service.ts'
import { McpOAuthStore, mcpOAuthSchema } from './oauth-store.ts'
import { McpServerStore, mcpServerSchema } from './store.ts'
import { startTestMcpServer } from './test-server.ts'

function memorySql() {
	const db = new DatabaseSync(':memory:')
	return {
		exec(query: string, ...params: Array<string | number | null>) {
			const statements = query.split(';').filter((s) => s.trim())
			if (statements.length > 1) {
				for (const statement of statements) db.exec(statement)
				return { toArray: () => [], rowsWritten: 0 }
			}
			const statement = db.prepare(query)
			if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...params), rowsWritten: 0 }
			const result = statement.run(...params)
			return { toArray: () => [], rowsWritten: Number(result.changes) }
		},
	} as unknown as SqlStorage
}

async function setup(serverOptions: Parameters<typeof startTestMcpServer>[0] = {}) {
	const sql = memorySql()
	sql.exec(mcpServerSchema)
	sql.exec(mcpOAuthSchema)
	const ring = await buildMasterKeyring('service-test-key')
	const oauth = new McpOAuthStore({ sql, userId: () => 'user_1', keyring: async () => ring })
	const store = new McpServerStore({ sql, userId: () => 'user_1', keyring: async () => ring, oauth })
	const config = mcpConfigFromEnv({ KODY_MCP_ALLOW_PRIVATE_HOSTS: '172.30.0.0/16' })
	// Mirrors the UserCell RPCs (src/cells/user-cell.ts); keep both in sync.
	const cell: McpServerCell = {
		mcpServerGet: async (name: string) => store.get(name),
		mcpServerSave: async (input: Parameters<McpServerStore['save']>[0]) => store.save(input),
		mcpServerSetDiscovery: async (input: { name: string; outcome: Parameters<McpServerStore['setDiscovery']>[1] }) =>
			store.setDiscovery(input.name, input.outcome),
		mcpServerAuthorization: async (name: string, options: { forceRefresh?: boolean; staleAccessToken?: string } = {}) =>
			store.callAuthorization(name, {
				forceRefresh: options.forceRefresh === true,
				staleAccessToken: options.staleAccessToken,
				refresher: (input) => refreshMcpTokens({ ...input, fetchFn: oauthPolicyFetch(config, server.fetch) }),
			}),
		mcpServerOAuthLoad: async (name: string) => ({
			client: await oauth.client(name),
			discovery: oauth.discovery(name),
		}),
		mcpServerOAuthBegin: async (input) => {
			if (input.client) await oauth.saveClient(input.name, input.client)
			if (input.discovery) oauth.saveDiscovery(input.name, input.discovery)
			return oauth.createPending({
				state: input.state,
				serverName: input.name,
				serverOrigin: input.serverOrigin,
				serverUrl: input.serverUrl,
				verifier: input.verifier,
				redirectUri: input.redirectUri,
			})
		},
		mcpServerOAuthClaim: async (state: string) => {
			const claimed = await oauth.claimPending(state)
			if (!claimed) return null
			const name = claimed.pending.serverName
			return { ...claimed, client: await oauth.client(name), discovery: oauth.discovery(name) }
		},
		mcpServerOAuthComplete: async (input) => store.completeOAuth(input),
		mcpServerOAuthSetClient: async (input) => {
			if (!store.get(input.name)) throw new Error('mcp_server_not_found')
			await oauth.setPreregisteredClient(input.name, { clientId: input.clientId, clientSecret: input.clientSecret })
		},
		mcpServerOAuthClearClient: async (name: string) => oauth.clearClient(name),
	}
	const server = startTestMcpServer({
		// an OAuth test server checks only its own access tokens
		bearer: serverOptions.oauth ? undefined : 'tok',
		tools: [
			{
				name: 'add',
				handler: (a) => ({ content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }], isError: false }),
			},
		],
		...serverOptions,
	})
	const deps: McpDeps = {
		cell,
		config,
		maxResultBytes: 10_000,
		fetch: server.fetch,
		publicUrl: 'http://localhost:8080',
	}
	return { deps, store, server, oauth, sql }
}

const url = 'http://172.30.1.5/mcp'

describe('addMcpServer', () => {
	it('saves and discovers; a discovery failure still saves with status error', async () => {
		const { deps } = await setup()
		const ready = await addMcpServer(deps, { name: 'home', url, bearerToken: 'tok' })
		assert.equal(ready.status, 'ready')
		assert.deepEqual(
			ready.tools.map((t) => t.name),
			['add'],
		)
		const failed = await addMcpServer(deps, { name: 'nokey', url })
		assert.equal(failed.status, 'error')
		assert.match(failed.lastError?.message ?? '', /401/)
		assert.equal(failed.lastError?.phase, 'connect')
	})

	it('refuses a disallowed host without saving anything', async () => {
		const { deps, store } = await setup()
		await assert.rejects(
			addMcpServer(deps, { name: 'lan', url: 'http://192.168.1.1/mcp' }),
			/mcp_host_not_allowed|KODY_MCP_ALLOW_PRIVATE_HOSTS/,
		)
		assert.equal(store.get('lan'), null)
	})

	it('validates the bearer token before saving anything', async () => {
		const { deps, store } = await setup()
		await assert.rejects(addMcpServer(deps, { name: 'bad', url, bearerToken: 'a\nb' }), /bearerToken/)
		await assert.rejects(addMcpServer(deps, { name: 'bad', url, bearerToken: '' }), /bearerToken/)
		assert.equal(store.get('bad'), null)
	})

	it('never puts the bearer token in a 401 error message', async () => {
		const { deps, server } = await setup()
		server.setRespond(() => new Response('bad credential Bearer secrettoken123 / secrettoken123', { status: 401 }))
		const record = await addMcpServer(deps, { name: 'leaky', url, bearerToken: 'secrettoken123' })
		assert.equal(record.status, 'error')
		assert.match(record.lastError?.message ?? '', /401/)
		assert.doesNotMatch(JSON.stringify(record), /secrettoken123/)
	})

	it('replace keeps a stored lock, disabled state and bearer unless they are given', async () => {
		const { deps, store } = await setup()
		await addMcpServer(deps, { name: 'home', url, bearerToken: 'tok' })
		store.setUsage('home', { mode: 'packages', packages: ['@me/lights'] })
		store.setEnabled('home', false)
		const keptToken = await addMcpServer(deps, { name: 'home', url, replace: true })
		assert.deepEqual(keptToken.usage, { mode: 'packages', packages: ['@me/lights'] })
		assert.equal(keptToken.enabled, false)
		assert.equal(await store.authorization('home'), 'Bearer tok')
		assert.equal(keptToken.status, 'ready')
		const widened = await addMcpServer(deps, {
			name: 'home',
			url,
			replace: true,
			usage: { mode: 'packages', packages: ['@me/lights', '@me/heating'] },
		})
		assert.deepEqual(widened.usage, { mode: 'packages', packages: ['@me/lights', '@me/heating'] })
		assert.equal(await store.authorization('home'), 'Bearer tok')
	})

	it('replace refuses a usage looser than the stored lock (unlocking is UI-only)', async () => {
		const { deps, store } = await setup()
		await addMcpServer(deps, { name: 'home', url, bearerToken: 'tok' })
		store.setUsage('home', { mode: 'packages', packages: ['@me/lights', '@me/heating'] })
		await assert.rejects(
			addMcpServer(deps, { name: 'home', url, bearerToken: 'tok', replace: true, usage: { mode: 'any' } }),
			/mcp_server_locked|account\/mcp-servers/,
		)
		await assert.rejects(
			addMcpServer(deps, {
				name: 'home',
				url,
				bearerToken: 'tok',
				replace: true,
				usage: { mode: 'packages', packages: ['@me/lights'] },
			}),
			/@me\/heating/,
		)
		assert.deepEqual(store.get('home')?.usage, { mode: 'packages', packages: ['@me/lights', '@me/heating'] })
	})

	it('refuses a name that resolves into unlisted private space without saving anything', async () => {
		const { deps, store } = await setup({ dns: { 'rebind.example.com': '10.0.0.5' } })
		await assert.rejects(
			addMcpServer(deps, { name: 'rebind', url: 'https://rebind.example.com/mcp', bearerToken: 'tok' }),
			(error: Error & { code?: string }) => error.code === 'mcp_host_not_allowed' && /10\.0\.0\.5/.test(error.message),
		)
		assert.equal(store.get('rebind'), null)
	})
})

describe('callMcpTool', () => {
	it('calls a tool and records the auth kind', async () => {
		const { deps } = await setup()
		await addMcpServer(deps, { name: 'home', url, bearerToken: 'tok' })
		const result = await callMcpTool(deps, { server: 'home', tool: 'add', args: { a: 2, b: 3 }, packageName: null })
		assert.equal(result.content[0]?.text, '5')
		assert.equal(result.authKind, 'bearer')
	})

	it('enforces existence, enabled and the package lock (ad hoc refused)', async () => {
		const { deps, store } = await setup()
		await addMcpServer(deps, { name: 'home', url, bearerToken: 'tok' })
		await assert.rejects(
			callMcpTool(deps, { server: 'nope', tool: 'add', args: {}, packageName: null }),
			/mcp_server_not_found/,
		)
		store.setUsage('home', { mode: 'packages', packages: ['@me/lights'] })
		await assert.rejects(
			callMcpTool(deps, { server: 'home', tool: 'add', args: { a: 1, b: 1 }, packageName: null }),
			/mcp_server_locked/,
		)
		await assert.rejects(
			callMcpTool(deps, { server: 'home', tool: 'add', args: { a: 1, b: 1 }, packageName: '@me/other' }),
			/mcp_server_locked/,
		)
		const ok = await callMcpTool(deps, { server: 'home', tool: 'add', args: { a: 1, b: 1 }, packageName: '@me/lights' })
		assert.equal(ok.content[0]?.text, '2')
		store.setEnabled('home', false)
		await assert.rejects(
			callMcpTool(deps, { server: 'home', tool: 'add', args: {}, packageName: '@me/lights' }),
			/mcp_server_disabled/,
		)
	})

	it('refreshes once for a tool the cache does not know, then reports mcp_tool_not_found', async () => {
		const { deps, server } = await setup()
		await addMcpServer(deps, { name: 'home', url, bearerToken: 'tok' })
		server.addTool({ name: 'late', handler: () => ({ content: [{ type: 'text', text: 'late ok' }], isError: false }) })
		const late = await callMcpTool(deps, { server: 'home', tool: 'late', args: {}, packageName: null })
		assert.equal(late.content[0]?.text, 'late ok')
		await assert.rejects(
			callMcpTool(deps, { server: 'home', tool: 'missing', args: {}, packageName: null }),
			/mcp_tool_not_found[\s\S]*add/,
		)
	})

	it('does not treat an unrelated remote error for a one-letter tool as an unknown tool', async () => {
		let calls = 0
		const { deps } = await setup({
			bearer: undefined,
			tools: [
				{
					name: 'a',
					handler: () => {
						calls++
						throw Object.assign(new Error("Invalid params: field 'a' is required"), { code: -32602 })
					},
				},
			],
		})
		await addMcpServer(deps, { name: 's', url })
		await assert.rejects(callMcpTool(deps, { server: 's', tool: 'a', args: {}, packageName: null }), (error) => {
			assert.doesNotMatch(String(error), /mcp_tool_not_found/)
			assert.match(String(error), /mcp_call_failed/)
			return true
		})
		assert.equal(calls, 1, 'an unrelated error must not trigger a refresh-and-retry')
	})

	it('caps oversized results and validates args', async () => {
		const { deps } = await setup({
			tools: [
				{ name: 'big', handler: () => ({ content: [{ type: 'text', text: 'x'.repeat(20_000) }], isError: false }) },
			],
			bearer: undefined,
		})
		await addMcpServer(deps, { name: 'b', url })
		await assert.rejects(
			callMcpTool(deps, { server: 'b', tool: 'big', args: {}, packageName: null }),
			/mcp_result_too_large/,
		)
		await assert.rejects(callMcpTool(deps, { server: 'b', tool: 'big', args: [1], packageName: null }), /invalid_args/)
	})
})

describe('refreshMcpServer', () => {
	it('re-runs discovery and keeps the last good tool list on failure', async () => {
		const { deps, server } = await setup()
		await addMcpServer(deps, { name: 'home', url, bearerToken: 'tok' })
		server.setRespond(() => new Response('down', { status: 503 }))
		const failed = await refreshMcpServer(deps, 'home')
		assert.equal(failed.status, 'error')
		assert.equal(failed.tools.length, 1)
	})
})

async function authorizeThroughBrowser(deps: McpDeps, server: ReturnType<typeof startTestMcpServer>, name: string) {
	const { authorizationUrl } = await startMcpOAuth(deps, name)
	const back = await server.fetch(authorizationUrl)
	const location = new URL(back.headers.get('location')!)
	return finishMcpOAuth(deps, {
		state: location.searchParams.get('state')!,
		code: location.searchParams.get('code'),
		error: null,
		errorDescription: null,
	})
}

/** Consent, then a callback whose token request is held until release(): lets a test change the server mid-exchange. */
async function consentAndHoldExchange(deps: McpDeps, server: ReturnType<typeof startTestMcpServer>, name: string) {
	const { authorizationUrl } = await startMcpOAuth(deps, name)
	const location = new URL((await server.fetch(authorizationUrl)).headers.get('location')!)
	const inner = deps.fetch!
	let reached!: () => void
	let release!: () => void
	const atTokenEndpoint = new Promise<void>((resolve) => (reached = resolve))
	const gate = new Promise<void>((resolve) => (release = resolve))
	deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		if (new URL(request.url).pathname === '/token') {
			reached()
			await gate
		}
		return inner(request)
	}) as typeof fetch
	const finished = finishMcpOAuth(deps, {
		state: location.searchParams.get('state')!,
		code: location.searchParams.get('code'),
		error: null,
		errorDescription: null,
	})
	await atTokenEndpoint
	deps.fetch = inner
	return { finished, release }
}

describe('OAuth servers', () => {
	it('add without a bearer against an OAuth server parks it as authenticating with an authUrl', async () => {
		const { deps } = await setup({ oauth: { mode: 'dynamic' } })
		const record = await addMcpServer(deps, { name: 'oa', url })
		assert.equal(record.status, 'authenticating')
		assert.equal(record.auth.kind, 'oauth')
		const result = mcpServerResult(record, deps.publicUrl)
		assert.equal(result.authUrl, 'http://localhost:8080/account/mcp-servers/oa/authorize')
		assert.equal(result.oauthCallbackUrl, 'http://localhost:8080/account/mcp-servers/oauth/callback')
		assert.equal(result.oauthClientMetadataUrl, null)
		assert.match(result.nextStep, /authorize/i)
		await assert.rejects(
			callMcpTool(deps, { server: 'oa', tool: 'add', args: { a: 1, b: 2 }, packageName: null }),
			/mcp_server_unauthorized[\s\S]*\/account\/mcp-servers\/oa\/authorize/,
		)
	})

	it('no usable client mode: status error with the pre-registered-client message', async () => {
		const { deps } = await setup({ oauth: { mode: 'none' } })
		const record = await addMcpServer(deps, { name: 'gh', url })
		assert.equal(record.status, 'error')
		assert.match(record.lastError!.message, /pre-registered OAuth client/)
		// authUrl matches hosted: only while status is authenticating.
		assert.equal(mcpServerResult(record, deps.publicUrl).authUrl, null)
		await assert.rejects(startMcpOAuth(deps, 'gh'), /mcp_oauth_client_required/)
	})

	it('pre-registered client: a server without DCR/CIMD becomes authorizable and exchanges with client_secret_basic', async () => {
		const { deps, server } = await setup({
			oauth: { mode: 'preregistered', clients: { 'Iv1.abc': { secret: 'gh-secret' } } },
		})
		const parked = await addMcpServer(deps, { name: 'gh', url })
		assert.equal(parked.status, 'error')
		const ready = await setMcpOAuthClient(deps, 'gh', { clientId: 'Iv1.abc', clientSecret: 'gh-secret' })
		assert.equal(ready.status, 'authenticating')
		const finished = await authorizeThroughBrowser(deps, server, 'gh')
		assert.equal(finished.ok, true)
		assert.deepEqual(
			server.oauth!.tokenRequests.map((r) => r.clientId),
			['Iv1.abc'],
		)
		const removed = await removeMcpOAuthClient(deps, 'gh')
		assert.equal(removed.status, 'error')
	})

	it('consent → callback → ready; calls work; an expired access token is refreshed once and the call retried', async () => {
		const { deps, server } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		const described = await describeMcpOAuth(deps, 'oa')
		assert.equal(
			described.formActionOrigin,
			'http://172.30.1.5',
			'the consent page must allow the LAN authorize origin in form-action',
		)
		assert.equal(described.clientMode, 'dynamic')
		assert.equal(described.authorizationServerHost, '172.30.1.5')
		assert.equal(described.canContinue, true)
		const { authorizationUrl } = await startMcpOAuth(deps, 'oa')
		assert.equal(
			described.formActionOrigin,
			new URL(authorizationUrl).origin,
			'form-action origin must match the Continue redirect origin',
		)
		const back = await server.fetch(authorizationUrl)
		const location = new URL(back.headers.get('location')!)
		const finished = await finishMcpOAuth(deps, {
			state: location.searchParams.get('state')!,
			code: location.searchParams.get('code'),
			error: null,
			errorDescription: null,
		})
		assert.deepEqual({ ok: finished.ok, name: finished.name }, { ok: true, name: 'oa' })
		const sum = await callMcpTool(deps, { server: 'oa', tool: 'add', args: { a: 1, b: 2 }, packageName: null })
		assert.equal(sum.content[0]!.text, '3')
		assert.equal(sum.authKind, 'oauth')
		server.oauth!.expireAccessTokens()
		const again = await callMcpTool(deps, { server: 'oa', tool: 'add', args: { a: 2, b: 2 }, packageName: null })
		assert.equal(again.content[0]!.text, '4')
		assert.equal(server.oauth!.tokenRequests.filter((r) => r.grantType === 'refresh_token').length, 1)
	})

	it('a revoked refresh token parks the server; reconnect returns authenticating', async () => {
		const { deps, server, store } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		await authorizeThroughBrowser(deps, server, 'oa')
		server.oauth!.expireAccessTokens()
		server.oauth!.revokeRefreshTokens()
		await assert.rejects(
			callMcpTool(deps, { server: 'oa', tool: 'add', args: { a: 1, b: 1 }, packageName: null }),
			/mcp_server_unauthorized/,
		)
		assert.equal(store.get('oa')!.status, 'authenticating')
		const reconnected = await reconnectMcpServer(deps, 'oa')
		assert.equal(reconnected.status, 'authenticating')
	})

	it('callback replay and a double callback do not exchange twice or overwrite a ready status', async () => {
		const { deps, server, store } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		const { authorizationUrl } = await startMcpOAuth(deps, 'oa')
		const location = new URL((await server.fetch(authorizationUrl)).headers.get('location')!)
		const input = {
			state: location.searchParams.get('state')!,
			code: location.searchParams.get('code'),
			error: null,
			errorDescription: null,
		}
		const [a, b] = await Promise.all([finishMcpOAuth(deps, input), finishMcpOAuth(deps, input)])
		assert.equal([a, b].filter((r) => r.replay).length, 1)
		assert.equal(server.oauth!.tokenRequests.filter((r) => r.grantType === 'authorization_code').length, 1)
		const replay = await finishMcpOAuth(deps, input)
		assert.equal(replay.replay, true)
		assert.equal(store.get('oa')!.status, 'ready')
	})

	it('unknown or expired state is refused; a provider error parks the server', async () => {
		const { deps, store } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		await assert.rejects(
			finishMcpOAuth(deps, { state: 'nope', code: 'x', error: null, errorDescription: null }),
			/mcp_oauth_state_invalid/,
		)
		const { authorizationUrl } = await startMcpOAuth(deps, 'oa')
		const state = new URL(authorizationUrl).searchParams.get('state')!
		const denied = await finishMcpOAuth(deps, {
			state,
			code: null,
			error: 'access_denied',
			errorDescription: 'User said no',
		})
		assert.equal(denied.ok, false)
		assert.match(store.get('oa')!.lastError!.message, /access_denied: User said no/)
	})

	it('a cancelled re-authorization leaves a still-valid grant ready', async () => {
		const { deps, server, store } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		await authorizeThroughBrowser(deps, server, 'oa')
		assert.equal(store.get('oa')!.status, 'ready')
		const { authorizationUrl } = await startMcpOAuth(deps, 'oa')
		const state = new URL(authorizationUrl).searchParams.get('state')!
		const denied = await finishMcpOAuth(deps, {
			state,
			code: null,
			error: 'access_denied',
			errorDescription: 'User said no',
		})
		assert.equal(denied.ok, false)
		assert.match(denied.message ?? '', /access_denied/)
		const record = store.get('oa')!
		assert.equal(record.status, 'ready')
		assert.equal(record.oauth!.hasAccessToken, true)
		const sum = await callMcpTool(deps, { server: 'oa', tool: 'add', args: { a: 1, b: 2 }, packageName: null })
		assert.equal(sum.content[0]!.text, '3')
	})

	it('a replace to another origin drops the grant: the old access token never reaches the new origin', async () => {
		const { deps, server } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		await authorizeThroughBrowser(deps, server, 'oa')
		const issued = [...server.oauth!.issued]
		await addMcpServer(deps, { name: 'oa', url: 'http://172.30.1.6/mcp', replace: true })
		const sentToNew = server.requests.filter((r) => r.url.startsWith('http://172.30.1.6') && r.authorization)
		assert.ok(sentToNew.every((r) => !issued.some((t) => r.authorization!.includes(t))))
	})

	it('startMcpOAuth refuses an unsafe authorize URL before storing a pending attempt', async () => {
		const { deps, server, sql } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		server.setRespond((u) =>
			u.pathname === '/.well-known/oauth-authorization-server'
				? Response.json({
						issuer: 'http://172.30.1.5',
						// a valid URL the SDK accepts, but http to a host outside KODY_MCP_ALLOW_PRIVATE_HOSTS
						authorization_endpoint: 'http://203.0.113.9/authorize',
						token_endpoint: 'http://172.30.1.5/token',
						registration_endpoint: 'http://172.30.1.5/register',
						response_types_supported: ['code'],
						code_challenge_methods_supported: ['S256'],
					})
				: null,
		)
		await assert.rejects(startMcpOAuth(deps, 'oa'), /mcp_oauth_failed[\s\S]*Refusing to send the browser/)
		assert.deepEqual(sql.exec('SELECT state FROM mcp_server_oauth_pending').toArray(), [])
	})

	it('a cross-origin replace while the code exchange runs: no tokens saved, the new record untouched', async () => {
		const { deps, server, store, oauth } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		const callback = await consentAndHoldExchange(deps, server, 'oa')
		server.setRespond((u) => (u.hostname === '172.30.1.6' ? new Response('down', { status: 503 }) : null))
		await addMcpServer(deps, { name: 'oa', url: 'http://172.30.1.6/mcp', replace: true })
		callback.release()
		const finished = await callback.finished
		assert.equal(finished.ok, false)
		assert.match(finished.message ?? '', /removed or changed while authorizing/)
		assert.equal(await oauth.tokens('oa'), null)
		const record = store.get('oa')!
		assert.deepEqual({ url: record.url, kind: record.auth.kind }, { url: 'http://172.30.1.6/mcp', kind: 'none' })
		const issued = server.oauth!.issued
		const sentToNew = server.requests.filter((r) => r.url.startsWith('http://172.30.1.6') && r.authorization)
		assert.ok(sentToNew.every((r) => !issued.some((t) => r.authorization!.includes(t))))
	})

	it('a same-origin replace with a bearer while the code exchange runs keeps the bearer', async () => {
		const { deps, server, store, oauth } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		const callback = await consentAndHoldExchange(deps, server, 'oa')
		await addMcpServer(deps, { name: 'oa', url, bearerToken: 'tok', replace: true })
		callback.release()
		const finished = await callback.finished
		assert.equal(finished.ok, false)
		assert.equal(await oauth.tokens('oa'), null)
		assert.equal(store.get('oa')!.auth.kind, 'bearer')
		assert.equal(await store.authorization('oa'), 'Bearer tok')
	})

	it('reconnect on a grant without a refresh token keeps the grant', async () => {
		const { deps, server, store } = await setup({ oauth: { mode: 'dynamic', issueRefreshToken: false } })
		await addMcpServer(deps, { name: 'oa', url })
		await authorizeThroughBrowser(deps, server, 'oa')
		assert.equal(store.get('oa')!.oauth!.hasRefreshToken, false)
		const reconnected = await reconnectMcpServer(deps, 'oa')
		assert.equal(reconnected.status, 'ready')
		assert.equal(reconnected.oauth!.hasAccessToken, true)
		const sum = await callMcpTool(deps, { server: 'oa', tool: 'add', args: { a: 1, b: 2 }, packageName: null })
		assert.equal(sum.content[0]!.text, '3')
	})

	it('a call on an OAuth server in error without a grant is refused with mcp_server_unauthorized and no network probe', async () => {
		const { deps, server } = await setup({ oauth: { mode: 'none' } })
		await addMcpServer(deps, { name: 'gh', url })
		const before = server.requests.length
		await assert.rejects(
			callMcpTool(deps, { server: 'gh', tool: 'add', args: { a: 1, b: 2 }, packageName: null }),
			(error: Error & { code?: string }) => {
				assert.equal(error.code, 'mcp_server_unauthorized')
				assert.match(error.message, /pre-registered OAuth client/)
				assert.match(error.message, /\/account\/mcp-servers\/gh\/authorize/)
				return true
			},
		)
		assert.equal(server.requests.length, before)
	})

	it('results carry top-level hasRefreshToken and omit oauthClientMode / oauth', async () => {
		const { deps, server } = await setup({ oauth: { mode: 'dynamic' } })
		const parked = mcpServerResult(await addMcpServer(deps, { name: 'oa', url }), deps.publicUrl)
		assert.equal(parked.hasRefreshToken, false)
		assert.equal('oauthClientMode' in parked, false)
		assert.equal('oauth' in parked, false)
		await authorizeThroughBrowser(deps, server, 'oa')
		const ready = mcpServerResult((await deps.cell.mcpServerGet('oa'))!, deps.publicUrl)
		assert.equal(ready.hasRefreshToken, true)
		assert.equal('oauthClientMode' in ready, false)
		assert.equal('oauth' in ready, false)
	})

	it('a same-origin path replace during code exchange saves nothing', async () => {
		const { deps, server, store, oauth } = await setup({ oauth: { mode: 'dynamic' } })
		await addMcpServer(deps, { name: 'oa', url })
		const callback = await consentAndHoldExchange(deps, server, 'oa')
		await addMcpServer(deps, { name: 'oa', url: `${url}/other`, replace: true })
		callback.release()
		const finished = await callback.finished
		assert.equal(finished.ok, false)
		assert.match(finished.message ?? '', /removed or changed while authorizing/)
		assert.equal(await oauth.tokens('oa'), null)
		assert.notEqual(store.get('oa')!.url, url)
	})

	it('a client metadata document start is labelled metadata even when an old dynamic client is stored', async () => {
		const { deps, oauth } = await setup({ oauth: { mode: 'metadata' } })
		deps.publicUrl = 'https://kody.example.com'
		await addMcpServer(deps, { name: 'ha', url })
		await oauth.saveClient('ha', { mode: 'dynamic', information: { client_id: 'dyn-old' } })
		const started = await startMcpOAuth(deps, 'ha')
		assert.equal(started.clientMode, 'metadata')
		assert.deepEqual(
			{ mode: oauth.summary('ha')!.clientMode, id: oauth.summary('ha')!.clientId },
			{ mode: 'metadata', id: 'https://kody.example.com/oauth/client-metadata.json' },
		)
	})

	it('the consent page and start refuse a server that is not OAuth; a pre-registered client can still be set', async () => {
		const { deps } = await setup({ bearer: undefined })
		const open = await addMcpServer(deps, { name: 'open', url })
		assert.deepEqual({ status: open.status, kind: open.auth.kind }, { status: 'ready', kind: 'none' })
		await assert.rejects(describeMcpOAuth(deps, 'open'), /mcp_server_not_found/)
		await assert.rejects(startMcpOAuth(deps, 'open'), /mcp_server_not_found/)
		const withClient = await setMcpOAuthClient(deps, 'open', { clientId: 'cid', clientSecret: null })
		assert.equal(withClient.oauth?.clientMode, 'preregistered')
	})
})
