import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { buildMasterKeyring } from '../lib/crypto.ts'
import { McpOAuthStore, mcpOAuthSchema } from './oauth-store.ts'
import { McpServerStore, mcpServerSchema, publicMcpServer } from './store.ts'

/** Just enough of Durable Object `SqlStorage` for the store (same shim as provider-store.test.ts). */
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

async function makeStore(key = 'store-test-master-key', previous?: string) {
	const sql = memorySql()
	sql.exec(mcpServerSchema)
	sql.exec(mcpOAuthSchema)
	let ring = await buildMasterKeyring(key, previous)
	const oauth = new McpOAuthStore({ sql, userId: () => 'user_1', keyring: async () => ring })
	const store = new McpServerStore({ sql, userId: () => 'user_1', keyring: async () => ring, oauth })
	return { store, oauth, sql, setRing: async (k: string, p?: string) => (ring = await buildMasterKeyring(k, p)) }
}

const base = { url: 'http://172.30.1.5/mcp', enabled: true, usage: { mode: 'any' as const }, replace: false }

describe('McpServerStore', () => {
	it('saves, seals the bearer and never exposes it in records', async () => {
		const { store, sql } = await makeStore()
		const saved = await store.save({ ...base, name: 'home', authorization: 'Bearer very-secret-token' })
		assert.equal(saved.auth.kind, 'bearer')
		assert.equal(saved.status, 'error')
		assert.equal(await store.authorization('home'), 'Bearer very-secret-token')
		const rows = sql.exec('SELECT * FROM mcp_servers').toArray()
		assert.doesNotMatch(JSON.stringify(rows), /very-secret-token/)
		assert.doesNotMatch(JSON.stringify(store.list()), /very-secret-token/)
		assert.doesNotMatch(JSON.stringify(publicMcpServer(saved)), /very-secret-token/)
	})

	it('refuses a taken name unless replace, and replace without a token keeps the sealed bearer on the same origin', async () => {
		const { store } = await makeStore()
		await store.save({ ...base, name: 'home', authorization: 'Bearer a' })
		await assert.rejects(store.save({ ...base, name: 'home', authorization: null }), /mcp_server_exists/)
		const replaced = await store.save({ ...base, name: 'home', authorization: null, replace: true })
		assert.equal(replaced.auth.kind, 'bearer')
		assert.equal(await store.authorization('home'), 'Bearer a')
		const rotated = await store.save({
			...base,
			name: 'home',
			authorization: 'Bearer b',
			replace: true,
		})
		assert.equal(rotated.auth.kind, 'bearer')
		assert.equal(await store.authorization('home'), 'Bearer b')
	})

	it('replace to a different origin without a token drops the sealed bearer', async () => {
		const { store } = await makeStore()
		await store.save({ ...base, name: 'home', authorization: 'Bearer a' })
		const moved = await store.save({
			...base,
			name: 'home',
			url: 'http://172.30.9.9/mcp',
			authorization: null,
			replace: true,
		})
		assert.equal(moved.auth.kind, 'none')
		assert.equal(await store.authorization('home'), null)
	})

	it('records discovery results and errors', async () => {
		const { store } = await makeStore()
		await store.save({ ...base, name: 'home', authorization: null })
		const ready = store.setDiscovery('home', {
			serverInfo: { name: 'ha', version: '1', protocolVersion: '2025-11-25', instructions: 'Lights.' },
			tools: [{ name: 'HassTurnOn', description: 'Turn on', inputSchema: { type: 'object' } }],
		})
		assert.equal(ready.status, 'ready')
		assert.equal(ready.lastError, null)
		assert.equal(ready.tools[0]?.name, 'HassTurnOn')
		assert.ok(ready.toolsRefreshedAt)
		const failed = store.setDiscovery('home', { error: { phase: 'connect', message: 'boom', at: 'now' } })
		assert.equal(failed.status, 'error')
		assert.equal(failed.tools.length, 1, 'keeps the last good tool list')
		const pub = publicMcpServer(failed)
		assert.equal(pub.toolCount, 1)
		assert.equal(pub.accessor, 'kody.mcp["home"]')
	})

	it('toggles, sets usage, removes', async () => {
		const { store } = await makeStore()
		await store.save({ ...base, name: 'home', authorization: null })
		assert.equal(store.setEnabled('home', false).enabled, false)
		assert.deepEqual(store.setUsage('home', { mode: 'packages', packages: ['@a/b'] }).usage, {
			mode: 'packages',
			packages: ['@a/b'],
		})
		assert.throws(() => store.setEnabled('nope', true), /mcp_server_not_found/)
		assert.deepEqual(store.remove('home'), { removed: true })
		assert.equal(store.get('home'), null)
	})

	it('rekeys sealed bearers to the current key', async () => {
		const { store, setRing } = await makeStore('old-key')
		await store.save({ ...base, name: 'home', authorization: 'Bearer t' })
		await setRing('new-key', 'old-key')
		assert.deepEqual(await store.rekey(), { resealed: 1, remaining: 0 })
		await setRing('new-key')
		assert.equal(await store.authorization('home'), 'Bearer t')
	})

	it('authenticating state, oauth kind and the oauth summary on records', async () => {
		const { store, oauth } = await makeStore()
		await store.save({ ...base, name: 'home', authorization: null })
		const parked = store.setAuthState('home', 'authenticating', {
			phase: 'authorize',
			message: 'Authorize it.',
			at: 'now',
		})
		assert.equal(parked.status, 'authenticating')
		assert.equal(parked.auth.kind, 'oauth')
		await oauth.saveClient('home', { mode: 'dynamic', information: { client_id: 'cid' } })
		await oauth.saveTokens('home', { access_token: 'at-secret', refresh_token: 'rt-secret', token_type: 'Bearer' })
		const record = store.get('home')!
		assert.equal(record.oauth?.hasRefreshToken, true)
		assert.doesNotMatch(JSON.stringify(publicMcpServer(record)), /at-secret|rt-secret/)
	})

	it('replace to another origin, replace with a bearer, and remove all drop OAuth data', async () => {
		const { store, oauth } = await makeStore()
		await store.save({ ...base, name: 'home', authorization: null })
		store.markOAuth('home')
		await oauth.saveTokens('home', { access_token: 'at-1', token_type: 'Bearer' })
		await store.save({ ...base, url: 'http://172.30.1.5/other', name: 'home', authorization: null, replace: true })
		assert.equal(store.get('home')!.auth.kind, 'oauth', 'same-origin replace keeps oauth')
		assert.equal((await oauth.tokens('home'))!.accessToken, 'at-1')
		await store.save({
			...base,
			url: 'https://elsewhere.example/mcp',
			name: 'home',
			authorization: null,
			replace: true,
		})
		assert.equal(store.get('home')!.auth.kind, 'none')
		assert.equal(oauth.summary('home'), null)
		store.markOAuth('home')
		await oauth.saveTokens('home', { access_token: 'at-2', token_type: 'Bearer' })
		await store.save({
			...base,
			url: 'https://elsewhere.example/mcp',
			name: 'home',
			authorization: 'Bearer b',
			replace: true,
		})
		assert.equal(oauth.summary('home'), null, 'a bearer replace drops oauth')
		store.markOAuth('home')
		await oauth.saveTokens('home', { access_token: 'at-3', token_type: 'Bearer' })
		store.remove('home')
		assert.equal(oauth.summary('home'), null)
	})

	it('callAuthorization: bearer as before; oauth returns the access token or throws mcp_server_unauthorized and parks the server', async () => {
		const { store, oauth } = await makeStore()
		const refresher = async () => ({ access_token: 'x', token_type: 'Bearer' })
		await store.save({ ...base, name: 'b', authorization: 'Bearer static' })
		assert.equal(await store.callAuthorization('b', { forceRefresh: false, refresher }), 'Bearer static')
		await store.save({ ...base, name: 'o', authorization: null })
		store.markOAuth('o')
		await assert.rejects(store.callAuthorization('o', { forceRefresh: false, refresher }), /mcp_server_unauthorized/)
		assert.equal(store.get('o')!.status, 'authenticating')
		await oauth.saveTokens('o', { access_token: 'at-1', token_type: 'Bearer', expires_in: 3600 })
		assert.equal(await store.callAuthorization('o', { forceRefresh: false, refresher }), 'Bearer at-1')
	})

	it('rekey covers bearer and oauth secrets', async () => {
		const { store, oauth, setRing } = await makeStore('r1')
		await store.save({ ...base, name: 'b', authorization: 'Bearer static' })
		await store.save({ ...base, name: 'o', authorization: null })
		store.markOAuth('o')
		await oauth.saveTokens('o', { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer' })
		await setRing('r2', 'r1')
		assert.deepEqual(await store.rekey(), { resealed: 3, remaining: 0 })
	})

	it('a fresh add drops an OAuth row orphaned under the same name', async () => {
		const { store, oauth } = await makeStore()
		await store.save({ ...base, name: 'o', authorization: null })
		store.remove('o')
		// a token write that lost a race with remove() left a row behind
		await oauth.saveTokens('o', { access_token: 'at-old', refresh_token: 'rt-old', token_type: 'Bearer' })
		const readded = await store.save({ ...base, name: 'o', url: 'http://172.30.1.6/mcp', authorization: null })
		assert.equal(readded.oauth, null)
		assert.equal(await oauth.tokens('o'), null)
	})

	it('a late OAuth state write never relabels a bearer record or a record that moved origin', async () => {
		const { store } = await makeStore()
		await store.save({ ...base, name: 'b', authorization: 'Bearer static' })
		const kept = store.setAuthState('b', 'authenticating', { phase: 'authorize', message: 'late', at: 'now' })
		assert.equal(kept.auth.kind, 'bearer')
		assert.notEqual(kept.status, 'authenticating')
		assert.equal(await store.authorization('b'), 'Bearer static')
		await store.save({ ...base, name: 'm', url: 'https://elsewhere.example/mcp', authorization: null })
		const moved = store.setDiscovery('m', {
			auth: {
				status: 'authenticating',
				error: { phase: 'authorize', message: 'late', at: 'now' },
				origin: 'http://172.30.1.5',
			},
		})
		assert.equal(moved.auth.kind, 'none')
		assert.notEqual(moved.status, 'authenticating')
	})

	it('callAuthorization: a bearer replace during a refresh wins; the bearer is returned and the record stays bearer', async () => {
		const { store, oauth } = await makeStore()
		await store.save({ ...base, name: 'o', authorization: null })
		store.markOAuth('o')
		await oauth.saveClient('o', { mode: 'dynamic', information: { client_id: 'cid' } })
		await oauth.saveTokens('o', { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 1 })
		const authorization = await store.callAuthorization('o', {
			forceRefresh: false,
			refresher: async () => {
				await store.save({ ...base, name: 'o', authorization: 'Bearer newer', replace: true })
				return { access_token: 'at-2', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3600 }
			},
		})
		assert.equal(authorization, 'Bearer newer')
		const record = store.get('o')!
		assert.equal(record.auth.kind, 'bearer')
		assert.notEqual(record.status, 'authenticating')
	})
})
