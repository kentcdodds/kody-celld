import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { buildMasterKeyring } from '../lib/crypto.ts'
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
	let ring = await buildMasterKeyring(key, previous)
	const store = new McpServerStore({ sql, userId: () => 'user_1', keyring: async () => ring })
	return { store, sql, setRing: async (k: string, p?: string) => (ring = await buildMasterKeyring(k, p)) }
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

	it('refuses a taken name unless replace, and replace without a token keeps the sealed bearer', async () => {
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
})
