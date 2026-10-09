import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { buildMasterKeyring } from '../lib/crypto.ts'
import { mcpConfigFromEnv } from './policy.ts'
import { addMcpServer, callMcpTool, refreshMcpServer, type McpDeps } from './service.ts'
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
	const ring = await buildMasterKeyring('service-test-key')
	const store = new McpServerStore({ sql, userId: () => 'user_1', keyring: async () => ring })
	const cell = {
		mcpServerGet: async (name: string) => store.get(name),
		mcpServerSave: async (input: Parameters<McpServerStore['save']>[0]) => store.save(input),
		mcpServerSetDiscovery: async (input: { name: string; outcome: Parameters<McpServerStore['setDiscovery']>[1] }) =>
			store.setDiscovery(input.name, input.outcome),
		mcpServerAuthorization: async (name: string) => store.authorization(name),
	}
	const server = startTestMcpServer({
		bearer: 'tok',
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
		config: mcpConfigFromEnv({ KODY_MCP_ALLOW_PRIVATE_HOSTS: '172.30.0.0/16' }),
		maxResultBytes: 10_000,
		fetch: server.fetch,
	}
	return { deps, store, server }
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
