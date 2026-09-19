import type { CapabilityContext } from '../capabilities/define.ts'
import { KODY_CELLD_VERSION, type Env } from '../env.ts'
import { defaultResponseLimitBytes, executeRun, runRecordMaxIdempotencyKeyLength } from '../execute/engine.ts'
import { errorToJson, KodyError } from '../lib/errors.ts'
import { search, type SearchInput } from './search.ts'

type JsonRpcId = string | number | null
type JsonRpcRequest = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown }

const PROTOCOL_VERSION = '2025-06-18'

const searchToolSchema = {
	type: 'object',
	properties: {
		query: { type: 'string', description: 'Free-text query. Empty lists everything.' },
		entity: {
			type: 'string',
			enum: ['capability', 'domain', 'package', 'job', 'guide'],
			description: 'Restrict to one entity kind.',
		},
		domain: { type: 'string', description: 'Restrict to one domain (system, secrets, packages, jobs, storage, runs).' },
		limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
		maxResponseSize: { type: 'integer', minimum: 1000, default: 20000 },
		conversationId: { type: 'string', description: 'Accepted for Kody compatibility; unused.' },
		memoryContext: { type: 'string', description: 'Accepted for Kody compatibility; unused.' },
		includeHiddenPackages: { type: 'boolean', default: false },
	},
}

const executeToolSchema = {
	type: 'object',
	properties: {
		code: {
			type: 'string',
			description:
				"Single ES module with a default export function. Import { kody, packageStorage } from 'kody:runtime'; import saved package exports from 'kody:<package>/<export>'.",
		},
		params: { type: 'object', description: 'JSON passed as the first argument to the default export.' },
		responseLimit: {
			type: 'integer',
			minimum: 1,
			description: `Max result JSON bytes (default ${defaultResponseLimitBytes}).`,
		},
		conversationId: { type: 'string', description: 'Accepted for Kody compatibility; unused.' },
		memoryContext: { type: 'string', description: 'Accepted for Kody compatibility; unused.' },
		idempotencyKey: {
			type: 'string',
			minLength: 1,
			maxLength: runRecordMaxIdempotencyKeyLength,
			description: 'Replays the recorded result when the same key is seen again.',
		},
	},
	required: ['code'],
}

export const tools = [
	{
		name: 'search',
		title: 'Search Kody capabilities',
		description:
			'Discover capabilities, domains, saved packages, jobs, and guides on this self-hosted Kody. Start here, then call execute with the returned capability ids.',
		inputSchema: searchToolSchema,
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: 'execute',
		title: 'Execute code against Kody',
		description:
			"Run a JavaScript ES module in an isolated Worker. Its default export receives `params` and may call `kody.<capability>(args)` from 'kody:runtime', import saved packages, and fetch the network (secret placeholders are injected only for approved hosts). Returns { ok, result, logs, warnings, gateway }.",
		inputSchema: executeToolSchema,
		annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
	},
]

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
	return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function rpcResult(id: JsonRpcId, result: unknown) {
	return { jsonrpc: '2.0', id, result }
}

function toolResult(payload: unknown, isError = false) {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		structuredContent: typeof payload === 'object' && payload !== null ? payload : { value: payload },
		isError,
	}
}

async function callTool(name: string, args: Record<string, unknown>, ctx: CapabilityContext) {
	if (name === 'search') {
		return toolResult(await search(args as SearchInput, ctx))
	}
	if (name === 'execute') {
		if (typeof args.code !== 'string' || !args.code.trim()) {
			throw new KodyError('invalid_args', 'execute requires a non-empty `code` string.')
		}
		const result = await executeRun(ctx.env, ctx.exports, {
			kind: 'execute',
			user: ctx.user,
			entry: { kind: 'adhoc', code: args.code },
			params: args.params ?? {},
			responseLimit: typeof args.responseLimit === 'number' ? args.responseLimit : undefined,
			idempotencyKey: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
		})
		return toolResult(result, !result.ok)
	}
	throw new KodyError('unknown_tool', `Unknown tool "${name}".`, { status: 404 })
}

async function handleRpc(message: JsonRpcRequest, ctx: CapabilityContext): Promise<unknown | null> {
	const id = message.id ?? null
	const params = (message.params ?? {}) as Record<string, unknown>
	switch (message.method) {
		case 'initialize':
			return rpcResult(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {
					tools: { listChanged: false },
					prompts: { listChanged: false },
					resources: { listChanged: false },
				},
				serverInfo: { name: 'kody-celld', version: KODY_CELLD_VERSION },
				instructions:
					'Self-hosted Kody core on celld. Call `search` to discover capability ids, then `execute` with an ES module whose default export calls kody.<id>(args). Secret values are never returned; use {{secret:name}} placeholders in fetch requests.',
			})
		case 'notifications/initialized':
		case 'notifications/cancelled':
		case 'notifications/roots/list_changed':
			return null
		case 'ping':
			return rpcResult(id, {})
		case 'tools/list':
			return rpcResult(id, { tools })
		case 'prompts/list':
			return rpcResult(id, { prompts: [] })
		case 'resources/list':
			return rpcResult(id, { resources: [] })
		case 'resources/templates/list':
			return rpcResult(id, { resourceTemplates: [] })
		case 'tools/call': {
			const name = typeof params.name === 'string' ? params.name : ''
			const args = (params.arguments ?? {}) as Record<string, unknown>
			try {
				return rpcResult(id, await callTool(name, args, ctx))
			} catch (error) {
				if (error instanceof KodyError && (error.code === 'unknown_tool' || error.code === 'invalid_args')) {
					return rpcError(id, -32602, error.message, error.toJSON())
				}
				return rpcResult(id, toolResult(errorToJson(error), true))
			}
		}
		default:
			return rpcError(id, -32601, `Method not found: ${message.method}`)
	}
}

/** Streamable HTTP transport (stateless JSON responses; no SSE stream). */
export async function handleMcpRequest(request: Request, ctx: CapabilityContext, _env: Env): Promise<Response> {
	if (request.method === 'GET') {
		return Response.json(
			{
				error: 'method_not_allowed',
				message: 'This server answers JSON-RPC over POST only; it does not open SSE streams.',
			},
			{ status: 405, headers: { allow: 'POST, DELETE' } },
		)
	}
	if (request.method === 'DELETE') return new Response(null, { status: 204 })
	if (request.method !== 'POST') {
		return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: 'POST, DELETE' } })
	}
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 })
	}
	const messages = Array.isArray(body) ? body : [body]
	const responses: Array<unknown> = []
	for (const message of messages) {
		if (!message || typeof message !== 'object' || typeof (message as JsonRpcRequest).method !== 'string') {
			responses.push(rpcError(null, -32600, 'Invalid Request'))
			continue
		}
		const response = await handleRpc(message as JsonRpcRequest, ctx)
		if (response !== null) responses.push(response)
	}
	if (responses.length === 0) return new Response(null, { status: 202 })
	const payload = Array.isArray(body) ? responses : responses[0]
	return Response.json(payload, { headers: { 'mcp-protocol-version': PROTOCOL_VERSION } })
}
