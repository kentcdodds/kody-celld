// A real MCP server (SDK, stateless Streamable HTTP) for smoke/mcp-servers.mjs.
import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export async function startMockMcpServer({ port, bearer }) {
	const host = process.env.SMOKE_ECHO_HOST ?? '127.0.0.1'
	const bind = process.env.SMOKE_ECHO_BIND ?? (host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')
	const hits = []
	const tools = [
		{
			name: 'echo',
			description: 'Echo text back',
			inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
			run: (a) => ({ content: [{ type: 'text', text: String(a.text ?? '') }] }),
		},
		{
			name: 'add',
			description: 'Add two numbers',
			inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
			run: (a) => ({ content: [{ type: 'text', text: String(a.a + a.b) }], structuredContent: { sum: a.a + a.b } }),
		},
		{
			name: 'image',
			description: 'A 1x1 PNG',
			inputSchema: { type: 'object' },
			run: () => ({ content: [{ type: 'image', data: png1x1, mimeType: 'image/png' }] }),
		},
	]
	const http = createServer(async (req, res) => {
		hits.push({ authorization: req.headers.authorization ?? null })
		if (req.headers.authorization !== `Bearer ${bearer}`) {
			res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
			return
		}
		let body = ''
		for await (const chunk of req) body += chunk
		const request = new Request(`http://${host}:${port}${req.url}`, {
			method: req.method,
			headers: req.headers,
			body: req.method === 'POST' ? body : undefined,
		})
		const server = new Server(
			{ name: 'smoke-mcp', version: '1.0.0' },
			{ capabilities: { tools: {} }, instructions: 'Smoke test tools: echo, add, image.' },
		)
		server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ run: _r, ...t }) => t) }))
		server.setRequestHandler(CallToolRequestSchema, async (r) => {
			const tool = tools.find((t) => t.name === r.params.name)
			if (!tool) throw new Error(`Unknown tool: ${r.params.name}`)
			return tool.run(r.params.arguments ?? {})
		})
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		})
		await server.connect(transport)
		const response = await transport.handleRequest(request)
		res.writeHead(response.status, Object.fromEntries(response.headers))
		res.end(Buffer.from(await response.arrayBuffer()))
	})
	await new Promise((resolve) => http.listen(port, bind, resolve))
	return {
		url: `http://${host}:${port}/mcp`,
		hits,
		addTool: (name) =>
			tools.push({
				name,
				description: `Late tool ${name}`,
				inputSchema: { type: 'object' },
				run: () => ({ content: [{ type: 'text', text: `${name} ok` }] }),
			}),
		close: () => new Promise((resolve) => http.close(resolve)),
	}
}
