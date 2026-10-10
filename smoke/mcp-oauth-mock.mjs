// A real MCP server (SDK, stateless Streamable HTTP) behind an OAuth authorization server
// (dynamic client registration, PKCE S256, rotating refresh tokens) for smoke/mcp-oauth.mjs.
// The authorization server is a plain-JS port of createTestAuthorizationServer in
// src/mcp-client/test-server.ts, dynamic mode only.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const b64url = (buf) => buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

function createAuthorizationServer(origin) {
	const clients = new Map() // client id → { secret, redirectUris }
	const codes = new Map() // code → { clientId, challenge, redirectUri }
	const access = new Set()
	const refresh = new Map() // refresh token → client id
	const issued = []
	const tokenRequests = []
	let registrations = 0
	let counter = 0
	const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
	const issue = (clientId) => {
		counter++
		const at = `at-${counter}-${b64url(randomBytes(6))}`
		const rt = `rt-${counter}-${b64url(randomBytes(6))}`
		access.add(at)
		refresh.set(rt, clientId)
		issued.push(at, rt)
		return { access_token: at, refresh_token: rt, token_type: 'Bearer', expires_in: 3600 }
	}
	const clientAuth = (request, form) => {
		const basic = request.headers.get('authorization')
		if (basic?.startsWith('Basic ')) {
			const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString().split(':').map(decodeURIComponent)
			return { id: id ?? '', secret }
		}
		return { id: form.get('client_id') ?? '', secret: form.get('client_secret') ?? undefined }
	}
	async function handle(request, url) {
		if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
			return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['mcp'] })
		}
		if (url.pathname === '/.well-known/oauth-authorization-server') {
			return json({
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				response_types_supported: ['code'],
				grant_types_supported: ['authorization_code', 'refresh_token'],
				code_challenge_methods_supported: ['S256'],
				token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
			})
		}
		if (url.pathname === '/register' && request.method === 'POST') {
			const body = await request.json()
			registrations++
			const id = `dyn-${registrations}`
			const secret =
				body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none' ? `sec-${id}` : undefined
			clients.set(id, { secret, redirectUris: body.redirect_uris ?? [] })
			return json(
				{
					client_id: id,
					...(secret ? { client_secret: secret } : {}),
					redirect_uris: body.redirect_uris,
					token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'none',
				},
				201,
			)
		}
		if (url.pathname === '/authorize') {
			const clientId = url.searchParams.get('client_id') ?? ''
			if (!clients.has(clientId)) return json({ error: 'invalid_client' }, 400)
			const code = `code-${b64url(randomBytes(8))}`
			codes.set(code, {
				clientId,
				challenge: url.searchParams.get('code_challenge') ?? '',
				redirectUri: url.searchParams.get('redirect_uri') ?? '',
			})
			const back = new URL(url.searchParams.get('redirect_uri') ?? '')
			back.searchParams.set('code', code)
			back.searchParams.set('state', url.searchParams.get('state') ?? '')
			return new Response(null, { status: 302, headers: { location: back.href } })
		}
		if (url.pathname === '/token' && request.method === 'POST') {
			const form = new URLSearchParams(await request.text())
			const auth = clientAuth(request, form)
			const grantType = form.get('grant_type') ?? ''
			tokenRequests.push({ grantType })
			const registered = clients.get(auth.id)
			if (registered?.secret && registered.secret !== auth.secret) return json({ error: 'invalid_client' }, 401)
			if (grantType === 'authorization_code') {
				const entry = codes.get(form.get('code') ?? '')
				codes.delete(form.get('code') ?? '')
				const challenge = b64url(
					createHash('sha256')
						.update(form.get('code_verifier') ?? '')
						.digest(),
				)
				if (
					!entry ||
					entry.clientId !== auth.id ||
					entry.challenge !== challenge ||
					entry.redirectUri !== form.get('redirect_uri')
				) {
					return json({ error: 'invalid_grant' }, 400)
				}
				return json(issue(auth.id))
			}
			if (grantType === 'refresh_token') {
				const rt = form.get('refresh_token') ?? ''
				if (refresh.get(rt) !== auth.id) return json({ error: 'invalid_grant' }, 400)
				refresh.delete(rt) // rotation: a refresh token is good once
				return json(issue(auth.id))
			}
			return json({ error: 'unsupported_grant_type' }, 400)
		}
		return null
	}
	return {
		handle,
		issued,
		tokenRequests,
		isValidAccess: (header) => header?.startsWith('Bearer ') === true && access.has(header.slice(7)),
		expireAccessTokens: () => access.clear(),
		revokeRefreshTokens: () => refresh.clear(),
	}
}

export async function startMockOAuthMcpServer({ port }) {
	const host = process.env.SMOKE_ECHO_HOST ?? '127.0.0.1'
	const bind = process.env.SMOKE_ECHO_BIND ?? (host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')
	const base = `http://${host}:${port}`
	const as = createAuthorizationServer(base)
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
	]
	async function respond(request) {
		const url = new URL(request.url)
		const fromAs = await as.handle(request, url)
		if (fromAs) return fromAs
		if (url.pathname !== '/mcp') return new Response('not found', { status: 404 })
		if (!as.isValidAccess(request.headers.get('authorization'))) {
			return Response.json(
				{ error: 'invalid_token' },
				{
					status: 401,
					headers: {
						'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
					},
				},
			)
		}
		const server = new Server(
			{ name: 'smoke-oauth-mcp', version: '1.0.0' },
			{ capabilities: { tools: {} }, instructions: 'Smoke OAuth tools: echo, add.' },
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
		return transport.handleRequest(request)
	}
	const http = createServer(async (req, res) => {
		try {
			let body = ''
			for await (const chunk of req) body += chunk
			const request = new Request(`${base}${req.url}`, {
				method: req.method,
				headers: req.headers,
				body: req.method === 'POST' ? body : undefined,
			})
			const response = await respond(request)
			res.writeHead(response.status, Object.fromEntries(response.headers))
			res.end(Buffer.from(await response.arrayBuffer()))
		} catch (error) {
			res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error))
		}
	})
	await new Promise((resolve) => http.listen(port, bind, resolve))
	return {
		url: `${base}/mcp`,
		base,
		issued: as.issued,
		tokenRequests: as.tokenRequests,
		expireAccessTokens: as.expireAccessTokens,
		revokeRefreshTokens: as.revokeRefreshTokens,
		close: () => new Promise((resolve) => http.close(resolve)),
	}
}
