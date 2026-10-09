import { parseIntegrationUsage, usagePermits, type IntegrationUsage } from '../integrations/oauth.ts'
import { KodyError } from '../lib/errors.ts'
import { callServerTool, discoverServer, isUnknownToolError, type McpToolResult } from './client.ts'
import { assertMcpServerName, assertMcpUrl, normalizeBearerToken, type McpConfig } from './policy.ts'
import { assertResolvedHostAllowed } from './resolve.ts'
import type { McpDiscoveryOutcome, McpServerRecord, McpServerStore } from './store.ts'

export type McpServerCell = {
	mcpServerGet(name: string): Promise<McpServerRecord | null>
	mcpServerSave(input: Parameters<McpServerStore['save']>[0]): Promise<McpServerRecord>
	mcpServerSetDiscovery(input: { name: string; outcome: McpDiscoveryOutcome }): Promise<McpServerRecord>
	mcpServerAuthorization(name: string): Promise<string | null>
}

/** Every `mcpServer*` UserCell RPC with its real record type (the generated RPC stub types collapse `unknown` fields to `never`). */
export type McpAdminCell = McpServerCell & {
	mcpServerList(): Promise<Array<McpServerRecord>>
	mcpServerSetEnabled(input: { name: string; enabled: boolean }): Promise<McpServerRecord>
	mcpServerSetUsage(input: { name: string; usage: IntegrationUsage }): Promise<McpServerRecord>
	mcpServerRemove(name: string): Promise<{ removed: boolean }>
}

export type McpDeps = { cell: McpServerCell; config: McpConfig; maxResultBytes: number; fetch?: typeof fetch }

async function discover(deps: McpDeps, record: McpServerRecord): Promise<McpServerRecord> {
	const authorization = await deps.cell.mcpServerAuthorization(record.name)
	let outcome: McpDiscoveryOutcome
	try {
		outcome = await discoverServer({ url: record.url, authorization }, { config: deps.config, fetch: deps.fetch })
	} catch (error) {
		const kody = KodyError.fromUnknown(error)
		const phase = /tools\/list/.test(kody?.message ?? '') ? 'tools/list' : 'connect'
		outcome = { error: { phase, message: kody?.message ?? String(error), at: new Date().toISOString() } }
	}
	return deps.cell.mcpServerSetDiscovery({ name: record.name, outcome })
}

/** An explicit usage on replace may keep or widen the stored grant list; unlocking or removing grants is UI-only. */
function assertUsageNotLooser(name: string, stored: IntegrationUsage, next: IntegrationUsage) {
	if (stored.mode === 'any') return
	const dropped = next.mode === 'any' ? [] : stored.packages.filter((p) => !next.packages.includes(p))
	if (next.mode === 'packages' && dropped.length === 0) return
	throw new KodyError(
		'mcp_server_locked',
		next.mode === 'any'
			? `MCP server "${name}" is locked to package(s) ${stored.packages.join(', ')}; unlocking it is done on /account/mcp-servers.`
			: `MCP server "${name}" grants package(s) ${dropped.join(', ')}; removing a grant is done on /account/mcp-servers.`,
		{ status: 403 },
	)
}

export async function addMcpServer(
	deps: McpDeps,
	input: { name: unknown; url: unknown; bearerToken?: unknown; enabled?: boolean; usage?: unknown; replace?: boolean },
): Promise<McpServerRecord> {
	const name = assertMcpServerName(input.name)
	if (typeof input.url !== 'string') throw new KodyError('invalid_args', 'url must be a string.')
	const url = assertMcpUrl(input.url, deps.config)
	const authorization =
		input.bearerToken === undefined || input.bearerToken === null ? null : normalizeBearerToken(input.bearerToken)
	const requested = input.usage === undefined ? null : parseIntegrationUsage(input.usage)
	const existing = input.replace === true ? await deps.cell.mcpServerGet(name) : null
	if (existing && requested) assertUsageNotLooser(name, existing.usage, requested)
	const usage: IntegrationUsage = requested ?? existing?.usage ?? { mode: 'any' }
	await assertResolvedHostAllowed(url, deps.config, deps.fetch ?? fetch)
	const saved = await deps.cell.mcpServerSave({
		name,
		url: url.href,
		enabled: input.enabled ?? existing?.enabled ?? true,
		usage,
		authorization,
		replace: input.replace === true,
	})
	return discover(deps, saved)
}

export async function refreshMcpServer(deps: McpDeps, name: string): Promise<McpServerRecord> {
	const record = await deps.cell.mcpServerGet(assertMcpServerName(name))
	if (!record) throw new KodyError('mcp_server_not_found', `MCP server "${name}" was not found.`, { status: 404 })
	assertMcpUrl(record.url, deps.config)
	return discover(deps, record)
}

function assertResultSize(result: McpToolResult, max: number, server: string, tool: string) {
	const size = new TextEncoder().encode(JSON.stringify(result)).length
	if (size > max) {
		throw new KodyError(
			'mcp_result_too_large',
			`${server}.${tool} returned ${size} bytes; the limit is ${max} (KODY_MCP_CONTENT_LIMIT_BYTES).`,
			{ status: 413 },
		)
	}
}

export async function callMcpTool(
	deps: McpDeps,
	input: { server: string; tool: string; args: unknown; packageName: string | null },
): Promise<McpToolResult & { authKind: 'none' | 'bearer'; url: string }> {
	if (
		input.args !== undefined &&
		(typeof input.args !== 'object' || input.args === null || Array.isArray(input.args))
	) {
		throw new KodyError('invalid_args', `kody.mcp["${input.server}"].${input.tool}(input) takes one object argument.`)
	}
	const args = (input.args ?? {}) as Record<string, unknown>
	let record = await deps.cell.mcpServerGet(input.server)
	if (!record)
		throw new KodyError(
			'mcp_server_not_found',
			`MCP server "${input.server}" was not found. List servers with mcpServerList.`,
			{ status: 404 },
		)
	if (!record.enabled)
		throw new KodyError('mcp_server_disabled', `MCP server "${input.server}" is disabled.`, { status: 409 })
	if (!usagePermits(record.usage, input.packageName)) {
		const allowed = record.usage.mode === 'packages' ? record.usage.packages.join(', ') : ''
		throw new KodyError(
			'mcp_server_locked',
			`MCP server "${input.server}" is locked to package(s) ${allowed}; ${input.packageName ? `package "${input.packageName}"` : 'ad hoc execute'} may not use it.`,
			{ status: 403 },
		)
	}
	assertMcpUrl(record.url, deps.config)
	if (!record.tools.some((t) => t.name === input.tool)) {
		record = await discover(deps, record)
		if (!record.tools.some((t) => t.name === input.tool)) {
			const known = record.tools
				.slice(0, 20)
				.map((t) => t.name)
				.join(', ')
			throw new KodyError(
				'mcp_tool_not_found',
				`MCP server "${input.server}" has no tool "${input.tool}". Known tools: ${known || '(none)'}.`,
				{ status: 404 },
			)
		}
	}
	const authorization = await deps.cell.mcpServerAuthorization(record.name)
	const target = { url: record.url, authorization }
	const call = () => callServerTool(target, input.tool, args, { config: deps.config, fetch: deps.fetch })
	let result: McpToolResult
	try {
		result = await call()
	} catch (error) {
		if (!isUnknownToolError(error, input.tool)) throw error
		record = await discover(deps, record)
		result = await call()
	}
	assertResultSize(result, deps.maxResultBytes, input.server, input.tool)
	return { ...result, authKind: record.auth.kind, url: record.url }
}
