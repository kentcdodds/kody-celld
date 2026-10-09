import { parseIntegrationUsage } from '../integrations/oauth.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { limitsFromEnv } from '../lib/limits.ts'
import { mcpConfigFromEnv } from '../mcp-client/policy.ts'
import { addMcpServer, refreshMcpServer, type McpAdminCell, type McpDeps } from '../mcp-client/service.ts'
import { publicMcpServer } from '../mcp-client/store.ts'
import { defineCapability, defineDomain, type CapabilityContext } from './define.ts'

export const mcpServersDomain = defineDomain({
	name: 'mcpServers',
	description:
		'Remote MCP servers whose tools you call from execute and packages as kody.mcp["server-name"].tool_name(input). Kody is the MCP client: Streamable HTTP, optional static bearer token (stored encrypted, never returned). Private/LAN hosts need the operator allowlist KODY_MCP_ALLOW_PRIVATE_HOSTS (hosts, *.suffix, CIDR).',
	guide: `1. mcpServerAdd({ name: 'home', url: 'https://…/mcp', bearerToken? }) connects and lists the server's tools.
2. search({ domain: 'mcp:home' }) lists its tools with input schemas.
3. Call one: const r = await kody.mcp['home'].tool_name({ ... }) → { content, structuredContent?, isError }.
4. mcpServerLock({ name, packageName }) restricts a server to packages (unlocking is done on /account/mcp-servers).`,
})

export function mcpCell(ctx: Pick<CapabilityContext, 'userCell'>) {
	return ctx.userCell as unknown as McpAdminCell
}

export function mcpDeps(ctx: Pick<CapabilityContext, 'env' | 'userCell'>): McpDeps {
	return {
		cell: mcpCell(ctx),
		config: mcpConfigFromEnv(ctx.env),
		maxResultBytes: limitsFromEnv(ctx.env).mcpContentLimitBytes,
	}
}

function guardManagement(ctx: CapabilityContext) {
	if (ctx.packageName !== null) {
		throw new KodyError(
			'forbidden_from_package',
			'MCP servers can only be managed from the MCP session or ad hoc execute, not from package code.',
			{ status: 403 },
		)
	}
}

async function audit(
	ctx: CapabilityContext,
	action: string,
	target: string,
	details: Record<string, unknown> | null = null,
) {
	await recordAudit(ctx.env, { actor: `user:${ctx.user.id}`, action, target, details })
}

async function requireServer(ctx: CapabilityContext, name: string) {
	const record = await mcpCell(ctx).mcpServerGet(name)
	if (!record) throw new KodyError('mcp_server_not_found', `MCP server "${name}" was not found.`, { status: 404 })
	return record
}

const nameSchema = { type: 'string', description: 'Server name: lowercase letters, digits and "-" (1-64).' }

export const mcpServerAdd = defineCapability<{
	name: string
	url: string
	bearerToken?: string
	enabled?: boolean
	usage?: unknown
	replace?: boolean
}>({
	domain: 'mcpServers',
	name: 'mcpServerAdd',
	description:
		'Add a remote MCP server (Streamable HTTP) and discover its tools. bearerToken (optional) is stored encrypted and never returned; a bare token is sent as "Bearer <token>". The server is saved even when discovery fails (status "error" with lastError); fix it and call mcpServerRefresh. Pass replace: true to overwrite an existing name (its lock, enabled state and bearer are kept unless given; a looser usage is refused; unlocking is done on /account/mcp-servers).',
	tags: ['mcp', 'write'],
	keywords: ['add mcp server', 'connect mcp', 'remote mcp', 'home assistant', 'mcp client', 'kody.mcp'],
	inputSchema: {
		type: 'object',
		properties: {
			name: nameSchema,
			url: {
				type: 'string',
				description:
					'https URL of the MCP endpoint (often ending in /mcp). http and private hosts need KODY_MCP_ALLOW_PRIVATE_HOSTS.',
			},
			bearerToken: { type: 'string', description: 'Optional static token or full Authorization value.' },
			enabled: { type: 'boolean' },
			usage: { type: 'object', description: '{ mode: "any" } (default) or { mode: "packages", packages: [...] }.' },
			replace: { type: 'boolean' },
		},
		required: ['name', 'url'],
	},
	example: `await kody.mcpServerAdd({ name: 'home', url: 'http://172.30.1.108:8123/mcp', bearerToken: '<token>' })`,
	async handler(args, ctx) {
		guardManagement(ctx)
		const record = await addMcpServer(mcpDeps(ctx), args)
		await audit(ctx, 'mcp_server.add', record.name, { url: record.url, auth: record.auth.kind, status: record.status })
		return publicMcpServer(record)
	},
})

export const mcpServerList = defineCapability({
	domain: 'mcpServers',
	name: 'mcpServerList',
	description:
		'List your MCP servers with status, last error, tools (names and descriptions) and the kody.mcp accessor. Tokens are never returned.',
	tags: ['mcp', 'read'],
	keywords: ['list mcp servers', 'mcp tools', 'mcp status'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		return { servers: (await mcpCell(ctx).mcpServerList()).map(publicMcpServer) }
	},
})

export const mcpServerRefresh = defineCapability<{ name: string }>({
	domain: 'mcpServers',
	name: 'mcpServerRefresh',
	description: 'Reconnect to an MCP server and re-list its tools; updates status and lastError.',
	tags: ['mcp', 'write'],
	keywords: ['refresh mcp tools', 'retry mcp server'],
	inputSchema: { type: 'object', properties: { name: nameSchema }, required: ['name'] },
	async handler(args, ctx) {
		guardManagement(ctx)
		const record = await refreshMcpServer(mcpDeps(ctx), args.name)
		await audit(ctx, 'mcp_server.refresh', record.name, { status: record.status })
		return publicMcpServer(record)
	},
})

export const mcpServerSetEnabled = defineCapability<{ name: string; enabled: boolean }>({
	domain: 'mcpServers',
	name: 'mcpServerSetEnabled',
	description: 'Enable or disable an MCP server. Calls to a disabled server fail with mcp_server_disabled.',
	tags: ['mcp', 'write'],
	keywords: ['disable mcp server', 'enable mcp server'],
	inputSchema: {
		type: 'object',
		properties: { name: nameSchema, enabled: { type: 'boolean' } },
		required: ['name', 'enabled'],
	},
	async handler(args, ctx) {
		guardManagement(ctx)
		const record = await mcpCell(ctx).mcpServerSetEnabled({ name: args.name, enabled: args.enabled })
		await audit(ctx, 'mcp_server.enabled', record.name, { enabled: record.enabled })
		return publicMcpServer(record)
	},
})

export const mcpServerLock = defineCapability<{ name: string; packageName: string }>({
	domain: 'mcpServers',
	name: 'mcpServerLock',
	description:
		'Grant a saved package use of an MCP server and lock the server to its grant list (ad hoc execute and other packages are refused). Only widens the list; removing a grant or unlocking is done on /account/mcp-servers.',
	tags: ['mcp', 'write', 'grants'],
	keywords: ['lock mcp server', 'restrict mcp server', 'grant package mcp'],
	inputSchema: {
		type: 'object',
		properties: { name: nameSchema, packageName: { type: 'string' } },
		required: ['name', 'packageName'],
	},
	async handler(args, ctx) {
		guardManagement(ctx)
		const record = await requireServer(ctx, args.name)
		if (!(await ctx.userCell.packageGet(args.packageName))) {
			throw new KodyError('invalid_args', `Package "${args.packageName}" is not saved.`)
		}
		const packages = record.usage.mode === 'packages' ? record.usage.packages : []
		const usage = parseIntegrationUsage({ mode: 'packages', packages: [...new Set([...packages, args.packageName])] })
		const updated = await mcpCell(ctx).mcpServerSetUsage({ name: args.name, usage })
		await audit(ctx, 'mcp_server.lock', args.name, { packageName: args.packageName })
		return publicMcpServer(updated)
	},
})

export const mcpServerRemove = defineCapability<{ name: string }>({
	domain: 'mcpServers',
	name: 'mcpServerRemove',
	description: 'Remove an MCP server and its stored token.',
	tags: ['mcp', 'write', 'delete'],
	keywords: ['remove mcp server', 'delete mcp server'],
	inputSchema: { type: 'object', properties: { name: nameSchema }, required: ['name'] },
	async handler(args, ctx) {
		guardManagement(ctx)
		const result = await mcpCell(ctx).mcpServerRemove(args.name)
		await audit(ctx, 'mcp_server.remove', args.name, { removed: result.removed })
		return { name: args.name, removed: result.removed }
	},
})

export const mcpServerCapabilities = [
	mcpServerAdd,
	mcpServerList,
	mcpServerRefresh,
	mcpServerSetEnabled,
	mcpServerLock,
	mcpServerRemove,
]
