import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { KODY_CELLD_VERSION } from '../env.ts'
import { KodyError } from '../lib/errors.ts'
import { assertMcpUrl, type McpConfig } from './policy.ts'
import { assertResolvedHostAllowed } from './resolve.ts'

export type McpTool = {
	name: string
	title?: string
	description?: string
	inputSchema: Record<string, unknown>
	outputSchema?: Record<string, unknown>
	annotations?: Record<string, unknown>
}
export type McpServerInfo = {
	name: string
	version: string
	protocolVersion: string | null
	instructions: string | null
}
export type McpTarget = { url: string; authorization: string | null }
export type McpClientOptions = { config: McpConfig; fetch?: typeof fetch }
export type McpToolResult = { content: Array<Record<string, unknown>>; structuredContent?: unknown; isError: boolean }

export const mcpLimits = {
	maxTools: 200,
	maxPages: 20,
	maxSchemaBytes: 65_536,
	maxTotalToolBytes: 1_000_000,
	maxInstructionsBytes: 8_192,
	maxRedirects: 5,
}

/**
 * Ajv (the SDK default) compiles with `new Function`, which workerd forbids.
 * Use the SDK's Cloudflare Workers provider (`@cfworker/json-schema`), the same
 * path hosted Kody takes via the Agents SDK's MCP client.
 */
export const mcpJsonSchemaValidator = new CfWorkerJsonSchemaValidator()

function bytes(value: unknown) {
	return new TextEncoder().encode(JSON.stringify(value) ?? '').length
}

function stub(size: number) {
	return { type: 'object', description: `(schema too large: ${size} bytes)` }
}

/** Applies the tool-count, per-schema and total-size caps (largest tools are degraded first, then the tail is dropped). */
export function capTools(tools: Array<McpTool>): Array<McpTool> {
	const capped: Array<McpTool> = tools.slice(0, mcpLimits.maxTools).map((tool) => {
		const next: McpTool = { ...tool }
		if (next.title) next.title = truncateUtf8(next.title, 500)
		if (next.description) next.description = truncateUtf8(next.description, 4_000)
		const inputSize = bytes(next.inputSchema)
		if (inputSize > mcpLimits.maxSchemaBytes) next.inputSchema = stub(inputSize)
		if (next.outputSchema) {
			const outputSize = bytes(next.outputSchema)
			if (outputSize > mcpLimits.maxSchemaBytes) next.outputSchema = stub(outputSize)
		}
		return next
	})
	const sizes = capped.map((tool) => bytes(tool))
	// "[" + "]" + one comma between tools
	let total = 2 + Math.max(0, capped.length - 1) + sizes.reduce((a, b) => a + b, 0)
	const order = sizes.map((size, index) => ({ index, size })).sort((a, b) => b.size - a.size)
	for (const { index } of order) {
		if (total <= mcpLimits.maxTotalToolBytes) break
		const { annotations: _a, outputSchema: _o, ...rest } = capped[index]!
		const degraded: McpTool = { ...rest, inputSchema: stub(bytes(rest.inputSchema)) }
		const size = bytes(degraded)
		if (size >= sizes[index]!) continue
		total -= sizes[index]! - size
		sizes[index] = size
		capped[index] = degraded
	}
	while (capped.length > 0 && total > mcpLimits.maxTotalToolBytes) {
		total -= sizes.pop()! + (capped.length > 1 ? 1 : 0)
		capped.pop()
	}
	return capped
}

function truncateUtf8(text: string, max: number) {
	const encoded = new TextEncoder().encode(text)
	return encoded.length <= max
		? text
		: new TextDecoder().decode(encoded.slice(0, max)).replace(/�$/, '') + ' …[truncated]'
}

export type PolicyFetchOptions = {
	/** A static credential (bearer server or OAuth access token). null: keep the caller's own Authorization header. */
	authorization: string | null
	base?: typeof fetch
	onPolicyError?: (e: KodyError) => void
	onChallenge?: (wwwAuthenticate: string) => void
	/** OAuth requests: a non-GET/HEAD request only follows a same-origin 307/308. */
	strictRedirects?: boolean
}

/** Fetch that enforces the URL policy on every hop, follows redirects by hand and keeps Authorization on the first origin. */
export function createPolicyFetch(config: McpConfig, options: PolicyFetchOptions): typeof fetch {
	const base = options.base ?? fetch
	const fail = (kody: KodyError) => {
		options.onPolicyError?.(kody)
		return kody
	}
	return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		let url = new URL(input instanceof Request ? input.url : String(input))
		const origin = url.origin
		const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
		const authorization = options.authorization ?? new Headers(init.headers).get('authorization')
		for (let hop = 0; ; hop++) {
			try {
				url = assertMcpUrl(url.href, config)
				await assertResolvedHostAllowed(url, config, base)
			} catch (error) {
				throw fail(KodyError.fromUnknown(error)!)
			}
			const headers = new Headers(init.headers)
			if (authorization && url.origin === origin) headers.set('authorization', authorization)
			else headers.delete('authorization')
			const response = await base(url.href, { ...init, headers, redirect: 'manual' })
			if (response.status === 401) {
				const challenge = response.headers.get('www-authenticate')
				if (challenge) options.onChallenge?.(challenge)
			}
			const location = response.headers.get('location')
			if (response.status < 300 || response.status >= 400 || !location) return response
			await response.body?.cancel().catch(() => {})
			if (hop >= mcpLimits.maxRedirects) {
				throw fail(
					new KodyError('mcp_call_failed', `MCP server redirected more than ${mcpLimits.maxRedirects} times.`, {
						status: 502,
					}),
				)
			}
			const next = new URL(location, url)
			if (
				options.strictRedirects &&
				method !== 'GET' &&
				method !== 'HEAD' &&
				(next.origin !== url.origin || (response.status !== 307 && response.status !== 308))
			) {
				throw fail(
					new KodyError(
						'mcp_call_failed',
						`OAuth ${method} to ${url.origin} was redirected (${response.status}) to ${next.origin}; only same-origin 307/308 redirects are followed.`,
						{ status: 502 },
					),
				)
			}
			url = next
		}
	}) as typeof fetch
}

/** The fetch every OAuth request (discovery, registration, token, refresh) goes through. */
export function oauthPolicyFetch(config: McpConfig, base?: typeof fetch): typeof fetch {
	return createPolicyFetch(config, { authorization: null, base, strictRedirects: true })
}

/** Removes each secret (and, for `Scheme value` secrets, the bare value) from remote-supplied text. */
export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
	const all = new Set<string>()
	for (const secret of secrets) {
		if (!secret) continue
		all.add(secret)
		const credential = secret.replace(/^\S+\s+/, '')
		if (credential) all.add(credential)
	}
	let out = text
	for (const secret of [...all].sort((a, b) => b.length - a.length)) out = out.split(secret).join('[redacted]')
	return out
}

export function httpStatusOf(error: unknown): number | undefined {
	const status = KodyError.fromUnknown(error)?.details?.httpStatus
	return typeof status === 'number' ? status : undefined
}

function toKodyError(
	error: unknown,
	phase: string,
	policyError: KodyError | null,
	timeoutMs: number,
	authorization: string | null,
	challenge: string | null,
) {
	if (policyError) return policyError
	const known = KodyError.fromUnknown(error)
	if (known) return known
	const code = (error as { code?: unknown } | null)?.code
	const httpStatus = typeof code === 'number' && code >= 100 && code < 600 ? code : undefined
	const message = error instanceof Error ? error.message : String(error)
	if (code === -32001 || /timed out|timeout/i.test(message)) {
		return new KodyError('mcp_call_failed', `MCP ${phase} timed out after ${timeoutMs} ms.`, {
			status: 502,
			details: { phase },
		})
	}
	return new KodyError(
		'mcp_call_failed',
		`MCP ${phase} failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}: ${truncateUtf8(redactSecrets(message, [authorization]).replace(/[?#]\S*/g, ''), 300)}`,
		{ status: 502, details: { phase, ...(httpStatus ? { httpStatus } : {}), ...(challenge ? { challenge } : {}) } },
	)
}

async function withClient<T>(
	target: McpTarget,
	options: McpClientOptions,
	run: (client: Client, setPhase: (phase: string) => void, timeout: number) => Promise<T>,
): Promise<T> {
	let policyError: KodyError | null = null
	const timeout = options.config.callTimeoutMs
	let challenge: string | null = null
	const transport = new StreamableHTTPClientTransport(new URL(target.url), {
		fetch: createPolicyFetch(options.config, {
			authorization: target.authorization,
			base: options.fetch ?? fetch,
			onPolicyError: (e) => {
				policyError = e
			},
			onChallenge: (c) => {
				challenge = c
			},
		}),
	})
	const client = new Client(
		{ name: 'kody-celld', version: KODY_CELLD_VERSION },
		{ capabilities: {}, jsonSchemaValidator: mcpJsonSchemaValidator },
	)
	let phase = 'connect'
	try {
		await client.connect(transport, { timeout })
		return await run(client, (next) => (phase = next), timeout)
	} catch (error) {
		throw toKodyError(error, phase, policyError, timeout, target.authorization, challenge)
	} finally {
		await client.close().catch(() => {})
	}
}

export async function discoverServer(target: McpTarget, options: McpClientOptions) {
	return withClient(target, options, async (client, setPhase, timeout) => {
		const version = client.getServerVersion()
		const instructions = client.getInstructions() ?? null
		setPhase('tools/list')
		const tools: Array<McpTool> = []
		let cursor: string | undefined
		for (let page = 0; page < mcpLimits.maxPages && tools.length < mcpLimits.maxTools; page++) {
			const result = await client.listTools(cursor ? { cursor } : {}, { timeout })
			for (const tool of result.tools) {
				tools.push({
					name: tool.name,
					...(tool.title ? { title: tool.title } : {}),
					...(tool.description ? { description: truncateUtf8(tool.description, 4_000) } : {}),
					inputSchema: tool.inputSchema as Record<string, unknown>,
					...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
					...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
				})
			}
			cursor = result.nextCursor
			if (!cursor) break
		}
		return {
			serverInfo: {
				name: version?.name ?? 'unknown',
				version: version?.version ?? 'unknown',
				protocolVersion: transportProtocol(client),
				instructions: instructions ? truncateUtf8(instructions, mcpLimits.maxInstructionsBytes) : null,
			},
			tools: capTools(tools),
		}
	})
}

function transportProtocol(client: Client) {
	const transport = client.transport as { protocolVersion?: string } | undefined
	return transport?.protocolVersion ?? null
}

export async function callServerTool(
	target: McpTarget,
	tool: string,
	args: Record<string, unknown>,
	options: McpClientOptions,
): Promise<McpToolResult> {
	return withClient(target, options, async (client, setPhase, timeout) => {
		setPhase('tools/call')
		const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout })
		return {
			content: (result.content ?? []) as Array<Record<string, unknown>>,
			...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
			isError: result.isError === true,
		}
	})
}

/** True when the remote rejected the call because it does not know `tool` ("Unknown tool: x", "Tool 'x' not found"). */
export function isUnknownToolError(error: unknown, tool: string) {
	const message = error instanceof Error ? error.message : String(error)
	const name = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const pattern = new RegExp(`\\btool\\s*:?\\s*["'\`]?${name}["'\`]?(?![\\w.-])`, 'i')
	return /-32602|unknown tool|not found/i.test(message) && pattern.test(message)
}
