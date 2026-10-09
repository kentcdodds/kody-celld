// Unit-test helper (not a test file): a real SDK MCP server behind a fetch function.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpToolResult } from './client.ts'

export type TestTool = {
	name: string
	description?: string
	inputSchema?: Record<string, unknown>
	handler: (args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>
}

/** Fake DoH answers for `fetch` in tests: `*.example.com` resolves to a public address unless `dns` says otherwise. */
function answerDns(url: URL, dns: Record<string, string>) {
	const name = url.searchParams.get('name') ?? ''
	const type = url.searchParams.get('type')
	const address = dns[name] ?? (name.endsWith('.example.com') ? '93.184.216.34' : undefined)
	const wanted = type === 'AAAA' ? address?.includes(':') : address && !address.includes(':')
	return Response.json({
		Status: 0,
		Answer: wanted ? [{ name, type: type === 'AAAA' ? 28 : 1, TTL: 60, data: address }] : [],
	})
}

export function startTestMcpServer(
	options: {
		bearer?: string
		pageSize?: number
		tools?: Array<TestTool>
		instructions?: string
		/** hostname → address returned by the fake resolver */
		dns?: Record<string, string>
	} = {},
) {
	const dns = options.dns ?? {}
	const tools: Array<TestTool> = [...(options.tools ?? [])]
	const requests: Array<{ url: string; authorization: string | null }> = []
	const state: { respond: ((url: URL) => Response | null) | null } = { respond: null }
	const pageSize = options.pageSize ?? 100

	function buildServer() {
		const server = new Server(
			{ name: 'test-mcp', version: '1.0.0' },
			{ capabilities: { tools: {} }, instructions: options.instructions ?? 'Test server instructions.' },
		)
		server.setRequestHandler(ListToolsRequestSchema, async (request) => {
			const start = Number(request.params?.cursor ?? 0)
			const page = tools.slice(start, start + pageSize).map((t) => ({
				name: t.name,
				description: t.description ?? '',
				inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
			}))
			const next = start + pageSize
			return next < tools.length ? { tools: page, nextCursor: String(next) } : { tools: page }
		})
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const tool = tools.find((t) => t.name === request.params.name)
			if (!tool) throw Object.assign(new Error(`Unknown tool: ${request.params.name}`), { code: -32602 })
			return (await tool.handler(request.params.arguments ?? {})) as never
		})
		return server
	}

	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		const url = new URL(request.url)
		if (url.hostname === 'cloudflare-dns.com') return answerDns(url, dns)
		requests.push({ url: request.url, authorization: request.headers.get('authorization') })
		const custom = state.respond?.(url)
		if (custom) return custom
		if (options.bearer && request.headers.get('authorization') !== `Bearer ${options.bearer}`) {
			return new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' },
			})
		}
		const server = buildServer()
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		})
		await server.connect(transport)
		return transport.handleRequest(request)
	}

	return {
		fetch: fetchImpl as typeof fetch,
		requests,
		addTool: (tool: TestTool) => tools.push(tool),
		setRespond: (fn: ((url: URL) => Response | null) | null) => {
			state.respond = fn
		},
	}
}
