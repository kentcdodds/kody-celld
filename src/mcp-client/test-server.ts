// Test-only helper (imported by *.test.ts only; not part of the Worker graph).
// A real SDK MCP server behind a fetch function for unit tests.
import { createHash, randomBytes } from 'node:crypto'
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

export type TestOAuthOptions = {
	mode: 'dynamic' | 'metadata' | 'preregistered' | 'none'
	/** client_id → optional secret (pre-registered clients) */
	clients?: Record<string, { secret?: string }>
	accessTtlSeconds?: number
	rotateRefresh?: boolean
	/** false: token responses carry no refresh_token (like a GitHub OAuth app). Default true. */
	issueRefreshToken?: boolean
	/** Override authorization_servers[0] in the resource metadata (to test the host policy). */
	authorizationServer?: string
	/**
	 * Resource metadata only at the 401 challenge's `resource_metadata` URL (/custom/prm), every well-known path 404,
	 * and an issuer with a path (`<origin>/tenant`), so discovery without the challenge finds nothing (#49).
	 */
	challengeOnly?: boolean
}

function b64url(buf: Buffer) {
	return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function createTestAuthorizationServer(origin: string, options: TestOAuthOptions) {
	const clients = new Map<string, { secret?: string; redirectUris: Array<string> }>(
		Object.entries(options.clients ?? {}).map(([id, c]) => [id, { secret: c.secret, redirectUris: [] }]),
	)
	const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>()
	const access = new Set<string>()
	const refresh = new Map<string, string>() // refresh token → client id
	const state = {
		tokenRequests: [] as Array<{ grantType: string; clientId: string }>,
		registrations: 0,
		issued: [] as Array<string>,
	}
	let counter = 0
	const json = (body: unknown, status = 200) =>
		Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
	const issue = (clientId: string) => {
		counter++
		const at = `at-${counter}-${b64url(randomBytes(6))}`
		access.add(at)
		state.issued.push(at)
		const response = { access_token: at, token_type: 'Bearer', expires_in: options.accessTtlSeconds ?? 3600 }
		if (options.issueRefreshToken === false) return response
		const rt = `rt-${counter}-${b64url(randomBytes(6))}`
		refresh.set(rt, clientId)
		state.issued.push(rt)
		return { ...response, refresh_token: rt }
	}
	const clientAuth = (request: Request, form: URLSearchParams) => {
		const basic = request.headers.get('authorization')
		if (basic?.startsWith('Basic ')) {
			const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString().split(':').map(decodeURIComponent)
			return { id: id ?? '', secret }
		}
		return { id: form.get('client_id') ?? '', secret: form.get('client_secret') ?? undefined }
	}
	async function handle(request: Request, url: URL): Promise<Response | null> {
		if (options.challengeOnly) {
			const issuer = `${origin}/tenant`
			if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ error: 'not_found' }, 404)
			if (url.pathname === '/.well-known/oauth-authorization-server') return json({ error: 'not_found' }, 404)
			if (url.pathname.startsWith('/.well-known/openid-configuration')) return json({ error: 'not_found' }, 404)
			if (url.pathname === '/custom/prm') {
				return json({ resource: `${origin}/mcp`, authorization_servers: [issuer], scopes_supported: ['mcp'] })
			}
			if (url.pathname === '/.well-known/oauth-authorization-server/tenant') {
				return json({
					issuer,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ['code'],
					grant_types_supported: ['authorization_code', 'refresh_token'],
					code_challenge_methods_supported: ['S256'],
					token_endpoint_auth_methods_supported: ['none'],
				})
			}
		}
		if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
			return json({
				resource: `${origin}/mcp`,
				authorization_servers: [options.authorizationServer ?? origin],
				scopes_supported: ['mcp'],
			})
		}
		if (url.pathname === '/.well-known/oauth-authorization-server') {
			if (options.mode === 'none' && options.clients === undefined) {
				return json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ['code'],
					code_challenge_methods_supported: ['S256'],
				})
			}
			return json({
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				...(options.mode === 'dynamic' ? { registration_endpoint: `${origin}/register` } : {}),
				...(options.mode === 'metadata' ? { client_id_metadata_document_supported: true } : {}),
				response_types_supported: ['code'],
				grant_types_supported: ['authorization_code', 'refresh_token'],
				code_challenge_methods_supported: ['S256'],
				token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
			})
		}
		if (url.pathname === '/register' && request.method === 'POST' && options.mode === 'dynamic') {
			const body = (await request.json()) as { redirect_uris?: Array<string>; token_endpoint_auth_method?: string }
			state.registrations++
			const id = `dyn-${state.registrations}`
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
			const known = clients.has(clientId) || (options.mode === 'metadata' && clientId.startsWith('https://'))
			if (!known) return json({ error: 'invalid_client' }, 400)
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
			state.tokenRequests.push({ grantType, clientId: auth.id })
			const registered = clients.get(auth.id)
			if (registered?.secret && registered.secret !== auth.secret) return json({ error: 'invalid_client' }, 401)
			if (grantType === 'authorization_code') {
				const entry = codes.get(form.get('code') ?? '')
				codes.delete(form.get('code') ?? '')
				const verifier = form.get('code_verifier') ?? ''
				const challenge = b64url(createHash('sha256').update(verifier).digest())
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
				if (options.rotateRefresh !== false) refresh.delete(rt)
				return json(issue(auth.id))
			}
			return json({ error: 'unsupported_grant_type' }, 400)
		}
		return null
	}
	return {
		handle,
		state,
		isValidAccess: (header: string | null) => header?.startsWith('Bearer ') === true && access.has(header.slice(7)),
		expireAccessTokens: () => access.clear(),
		revokeRefreshTokens: () => refresh.clear(),
	}
}

export function startTestMcpServer(
	options: {
		bearer?: string
		pageSize?: number
		tools?: Array<TestTool>
		instructions?: string
		/** hostname → address returned by the fake resolver */
		dns?: Record<string, string>
		oauth?: TestOAuthOptions
	} = {},
) {
	const dns = options.dns ?? {}
	const as = options.oauth ? createTestAuthorizationServer('http://172.30.1.5', options.oauth) : null
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
		const asResponse = as ? await as.handle(request, url) : null
		if (asResponse) return asResponse
		if (as && !as.isValidAccess(request.headers.get('authorization'))) {
			return new Response(JSON.stringify({ error: 'invalid_token' }), {
				status: 401,
				headers: {
					'content-type': 'application/json',
					'www-authenticate': options.oauth?.challengeOnly
						? 'Bearer resource_metadata="http://172.30.1.5/custom/prm", scope="mcp tools:read"'
						: 'Bearer resource_metadata="http://172.30.1.5/.well-known/oauth-protected-resource/mcp", scope="mcp"',
				},
			})
		}
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
		oauth: as
			? {
					get tokenRequests() {
						return as.state.tokenRequests
					},
					get registrations() {
						return as.state.registrations
					},
					get issued() {
						return as.state.issued
					},
					expireAccessTokens: as.expireAccessTokens,
					revokeRefreshTokens: as.revokeRefreshTokens,
				}
			: null,
		addTool: (tool: TestTool) => tools.push(tool),
		setRespond: (fn: ((url: URL) => Response | null) | null) => {
			state.respond = fn
		},
	}
}
