import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { callServerTool, capTools, discoverServer, mcpLimits, type McpTool } from './client.ts'
import { mcpConfigFromEnv } from './policy.ts'
import { startTestMcpServer } from './test-server.ts'

const config = mcpConfigFromEnv({ KODY_MCP_ALLOW_PRIVATE_HOSTS: '172.30.0.0/16', KODY_MCP_CALL_TIMEOUT_MS: '2000' })
const url = 'http://172.30.1.5:8123/mcp'
const text = (t: string) => ({ content: [{ type: 'text', text: t }], isError: false })

describe('discoverServer', () => {
	it('initializes and pages through tools/list with the bearer header', async () => {
		const server = startTestMcpServer({
			bearer: 's3cret',
			pageSize: 2,
			tools: ['a', 'b', 'c'].map((name) => ({ name, description: `tool ${name}`, handler: () => text(name) })),
		})
		const result = await discoverServer({ url, authorization: 'Bearer s3cret' }, { config, fetch: server.fetch })
		assert.deepEqual(
			result.tools.map((t) => t.name),
			['a', 'b', 'c'],
		)
		assert.equal(result.serverInfo.name, 'test-mcp')
		assert.equal(result.serverInfo.instructions, 'Test server instructions.')
		assert.ok(server.requests.every((r) => r.authorization === 'Bearer s3cret'))
	})

	it('reports a 401 as mcp_call_failed with the phase and status, never the token', async () => {
		const server = startTestMcpServer({ bearer: 's3cret' })
		await assert.rejects(
			discoverServer({ url, authorization: 'Bearer wrong-token-value' }, { config, fetch: server.fetch }),
			(error: Error) => {
				assert.match(error.name, /mcp_call_failed/)
				assert.match(error.message, /401/)
				assert.match(error.message, /connect|initialize/)
				assert.doesNotMatch(error.message, /wrong-token-value|s3cret/)
				return true
			},
		)
	})
})

describe('token redaction', () => {
	it('does not leak the bearer token when the remote echoes it in an error body', async () => {
		const server = startTestMcpServer({})
		server.setRespond((u) => new Response(`denied for Bearer SECRETTOKEN at ${u.pathname}`, { status: 401 }))
		await assert.rejects(
			discoverServer({ url, authorization: 'Bearer SECRETTOKEN' }, { config, fetch: server.fetch }),
			(error: Error) => {
				assert.match(error.name, /mcp_call_failed/)
				assert.doesNotMatch(error.message, /SECRETTOKEN/)
				return true
			},
		)
	})
})

describe('callServerTool', () => {
	const server = startTestMcpServer({
		tools: [
			{
				name: 'add',
				handler: (args) => ({
					content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }],
					structuredContent: { sum: Number(args.a) + Number(args.b) },
					isError: false,
				}),
			},
			{
				name: 'image',
				handler: () => ({ content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }], isError: false }),
			},
			{ name: 'fails', handler: () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }) },
			{ name: 'hangs', handler: () => new Promise(() => {}) },
		],
	})
	const target = { url, authorization: null }

	it('returns content, structuredContent and isError', async () => {
		const sum = await callServerTool(target, 'add', { a: 2, b: 3 }, { config, fetch: server.fetch })
		assert.deepEqual(sum.structuredContent, { sum: 5 })
		assert.equal(sum.isError, false)
		const image = await callServerTool(target, 'image', {}, { config, fetch: server.fetch })
		assert.equal(image.content[0]?.type, 'image')
		const failed = await callServerTool(target, 'fails', {}, { config, fetch: server.fetch })
		assert.equal(failed.isError, true)
	})

	it('times out with phase tools/call', async () => {
		await assert.rejects(
			callServerTool(target, 'hangs', {}, { config, fetch: server.fetch }),
			/mcp_call_failed[\s\S]*|tools\/call/,
		)
	})
})

describe('redirect policy', () => {
	it('follows a same-origin redirect with auth and drops auth across origins', async () => {
		const server = startTestMcpServer({ tools: [{ name: 'echo', handler: () => ({ content: [], isError: false }) }] })
		server.setRespond((u) =>
			u.pathname === '/old' ? new Response(null, { status: 308, headers: { location: '/mcp' } }) : null,
		)
		await discoverServer(
			{ url: 'http://172.30.1.5:8123/old', authorization: 'Bearer t' },
			{ config, fetch: server.fetch },
		)
		assert.ok(server.requests.filter((r) => r.url.endsWith('/mcp')).every((r) => r.authorization === 'Bearer t'))

		const other = startTestMcpServer({ tools: [] })
		other.setRespond((u) =>
			u.hostname === '172.30.1.5'
				? new Response(null, { status: 307, headers: { location: 'http://172.30.9.9/mcp' } })
				: null,
		)
		await discoverServer({ url: 'http://172.30.1.5/mcp', authorization: 'Bearer t' }, { config, fetch: other.fetch })
		const crossOrigin = other.requests.filter((r) => r.url.startsWith('http://172.30.9.9'))
		assert.ok(crossOrigin.length > 0, 'the redirect target was never requested')
		assert.ok(crossOrigin.every((r) => r.authorization === null))
	})

	it('refuses a redirect to a private host that is not allowlisted', async () => {
		const server = startTestMcpServer({ tools: [] })
		server.setRespond(() => new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/mcp' } }))
		await assert.rejects(
			discoverServer({ url, authorization: null }, { config, fetch: server.fetch }),
			/mcp_host_not_allowed|192\.168\.1\.1/,
		)
		assert.ok(!server.requests.some((r) => r.url.includes('192.168.1.1')))
	})

	it('runs the resolved-IP check before each hop', async () => {
		const server = startTestMcpServer({ tools: [], dns: { 'rebind.example.com': '10.0.0.5' } })
		server.setRespond((u) =>
			u.hostname === 'mcp.example.com'
				? new Response(null, { status: 307, headers: { location: 'https://rebind.example.com/mcp' } })
				: null,
		)
		await assert.rejects(
			discoverServer({ url: 'https://mcp.example.com/mcp', authorization: null }, { config, fetch: server.fetch }),
			/10\.0\.0\.5/,
		)
		assert.ok(server.requests.some((r) => r.url.startsWith('https://mcp.example.com')))
		assert.ok(!server.requests.some((r) => r.url.includes('rebind.example.com')))
	})

	it('stops after the redirect limit', async () => {
		const server = startTestMcpServer({ tools: [] })
		let n = 0
		server.setRespond(() => new Response(null, { status: 307, headers: { location: `/hop${++n}` } }))
		await assert.rejects(discoverServer({ url, authorization: null }, { config, fetch: server.fetch }), /redirect/)
	})
})

describe('capTools', () => {
	it('keeps at most 200 tools, stubs schemas over 64 KB and keeps the total under 1 MB', () => {
		const big = { type: 'object', description: 'x'.repeat(mcpLimits.maxSchemaBytes + 10) }
		const tools: Array<McpTool> = Array.from({ length: 250 }, (_, i) => ({
			name: `t${i}`,
			inputSchema: i < 30 ? { type: 'object', description: 'y'.repeat(40_000) } : { type: 'object' },
		}))
		tools[0] = { name: 'huge', inputSchema: big }
		const capped = capTools(tools)
		assert.equal(capped.length, 200)
		assert.match(String(capped[0]?.inputSchema.description), /schema too large/)
		assert.ok(JSON.stringify(capped).length <= mcpLimits.maxTotalToolBytes)
	})
})

describe('capTools total size', () => {
	it('stays under 1 MB when annotations, outputSchema and titles are huge', () => {
		const tools: Array<McpTool> = Array.from({ length: 200 }, (_, i) => ({
			name: `t${i}`,
			title: 'T'.repeat(5_000),
			description: 'd'.repeat(4_000),
			inputSchema: { type: 'object' },
			outputSchema: { type: 'object', description: 'o'.repeat(mcpLimits.maxSchemaBytes + 10) },
			annotations: { note: 'a'.repeat(10_000) },
		}))
		const capped = capTools(tools)
		assert.ok(JSON.stringify(capped).length <= mcpLimits.maxTotalToolBytes)
		assert.ok(capped.length > 0)
	})
})
