import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { jsonSchemaValidator, JsonSchemaValidatorResult } from '@modelcontextprotocol/sdk/validation/types.js'
import { KODY_CELLD_VERSION } from '../env.ts'
import { KodyError } from '../lib/errors.ts'
import { assertMcpUrl, type McpConfig } from './policy.ts'

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

/** The SDK's default validator (Ajv) compiles with `new Function`, which workerd forbids. Results are returned unvalidated. */
export const noOutputValidation: jsonSchemaValidator = {
	getValidator<T>() {
		return (input: unknown): JsonSchemaValidatorResult<T> => ({
			valid: true,
			data: input as T,
			errorMessage: undefined,
		})
	},
}

function bytes(value: unknown) {
	return new TextEncoder().encode(JSON.stringify(value) ?? '').length
}

function stub(size: number) {
	return { type: 'object', description: `(schema too large: ${size} bytes)` }
}

/** Applies the tool-count, per-schema and total-size caps (largest schemas are stubbed first). */
export function capTools(tools: Array<McpTool>): Array<McpTool> {
	const capped = tools.slice(0, mcpLimits.maxTools).map((tool) => {
		const size = bytes(tool.inputSchema)
		return size > mcpLimits.maxSchemaBytes ? { ...tool, inputSchema: stub(size) } : tool
	})
	const bySize = capped.map((tool, index) => ({ index, size: bytes(tool.inputSchema) })).sort((a, b) => b.size - a.size)
	let total = bytes(capped)
	for (const { index, size } of bySize) {
		if (total <= mcpLimits.maxTotalToolBytes) break
		const tool = capped[index]!
		const replacement = { ...tool, inputSchema: stub(size), outputSchema: undefined }
		capped[index] = replacement
		total = bytes(capped)
	}
	return capped
}

function truncateUtf8(text: string, max: number) {
	const encoded = new TextEncoder().encode(text)
	return encoded.length <= max
		? text
		: new TextDecoder().decode(encoded.slice(0, max)).replace(/�$/, '') + ' …[truncated]'
}

/** Fetch that enforces the URL policy on every hop, follows redirects by hand and keeps auth same-origin. */
function policyFetch(
	config: McpConfig,
	authorization: string | null,
	base: typeof fetch,
	onPolicyError: (e: KodyError) => void,
): typeof fetch {
	return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		let url = new URL(input instanceof Request ? input.url : String(input))
		const origin = url.origin
		for (let hop = 0; ; hop++) {
			try {
				url = assertMcpUrl(url.href, config)
			} catch (error) {
				const kody = KodyError.fromUnknown(error)!
				onPolicyError(kody)
				throw kody
			}
			const headers = new Headers(init.headers)
			if (authorization && url.origin === origin) headers.set('authorization', authorization)
			else headers.delete('authorization')
			const response = await base(url.href, { ...init, headers, redirect: 'manual' })
			const location = response.headers.get('location')
			if (response.status < 300 || response.status >= 400 || !location) return response
			if (hop >= mcpLimits.maxRedirects) {
				const kody = new KodyError(
					'mcp_call_failed',
					`MCP server redirected more than ${mcpLimits.maxRedirects} times.`,
					{ status: 502 },
				)
				onPolicyError(kody)
				throw kody
			}
			url = new URL(location, url)
		}
	}) as typeof fetch
}

function toKodyError(error: unknown, phase: string, policyError: KodyError | null, timeoutMs: number) {
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
		`MCP ${phase} failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}: ${truncateUtf8(message.replace(/[?#]\S*/g, ''), 300)}`,
		{ status: 502, details: { phase, ...(httpStatus ? { httpStatus } : {}) } },
	)
}

async function withClient<T>(
	target: McpTarget,
	options: McpClientOptions,
	run: (client: Client, setPhase: (phase: string) => void, timeout: number) => Promise<T>,
): Promise<T> {
	let policyError: KodyError | null = null
	const timeout = options.config.callTimeoutMs
	const transport = new StreamableHTTPClientTransport(new URL(target.url), {
		fetch: policyFetch(options.config, target.authorization, options.fetch ?? fetch, (e) => {
			policyError = e
		}),
	})
	const client = new Client(
		{ name: 'kody-celld', version: KODY_CELLD_VERSION },
		{ capabilities: {}, jsonSchemaValidator: noOutputValidation },
	)
	let phase = 'connect'
	try {
		await client.connect(transport, { timeout })
		return await run(client, (next) => (phase = next), timeout)
	} catch (error) {
		throw toKodyError(error, phase, policyError, timeout)
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

/** True when the remote rejected the call because it does not know `tool` (JSON-RPC -32602 naming the tool). */
export function isUnknownToolError(error: unknown, tool: string) {
	const message = error instanceof Error ? error.message : String(error)
	return /-32602|unknown tool|tool .* not found/i.test(message) && message.includes(tool)
}
