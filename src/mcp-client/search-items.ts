import { usagePermits } from '../integrations/oauth.ts'
import type { McpServerRecord } from './store.ts'

export type McpSearchItem = {
	id: string
	entity: 'mcp-server' | 'capability'
	title: string
	summary: string
	domain: string
	exactNames: Array<string>
	text: string
	detail: Record<string, unknown>
}

/** Search entries for the servers the caller may use (enabled + usage lock permits). */
export function mcpSearchItems(servers: Array<McpServerRecord>, packageName: string | null): Array<McpSearchItem> {
	const items: Array<McpSearchItem> = []
	for (const server of servers) {
		if (!server.enabled || !usagePermits(server.usage, packageName)) continue
		const host = (() => {
			try {
				return new URL(server.url).host
			} catch {
				return server.url
			}
		})()
		const domain = `mcp:${server.name}`
		const ready = server.status === 'ready'
		items.push({
			id: `mcp-server:${server.name}`,
			entity: 'mcp-server',
			title: server.name,
			summary: `${server.serverInfo?.name ?? 'MCP server'} at ${host}; ${ready ? `${server.tools.length} tools` : `error: ${server.lastError?.message ?? 'unknown'}`}`,
			domain,
			exactNames: [server.name, domain, `mcp-server:${server.name}`],
			text: `${server.name} ${host} ${server.serverInfo?.name ?? ''} ${server.serverInfo?.instructions ?? ''} ${server.tools.map((t) => t.name).join(' ')}`,
			detail: {
				host,
				status: server.status,
				...(server.lastError ? { lastError: server.lastError } : {}),
				tools: server.tools.map((t) => t.name),
				accessor: `kody.mcp[${JSON.stringify(server.name)}]`,
				listTools: `search({ domain: "${domain}" })`,
			},
		})
		if (!ready) continue
		for (const tool of server.tools) {
			const properties = Object.keys((tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {})
			items.push({
				id: `${domain}:${tool.name}`,
				entity: 'capability',
				title: tool.title ?? tool.name,
				summary: tool.description ?? `Tool ${tool.name} on MCP server ${server.name}.`,
				domain,
				exactNames: [tool.name, `${domain}:${tool.name}`],
				text: `${tool.name} ${server.name} ${tool.description ?? ''} ${properties.join(' ')}`,
				detail: {
					accessor: `kody.mcp[${JSON.stringify(server.name)}][${JSON.stringify(tool.name)}](input)`,
					inputSchema: tool.inputSchema,
					...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
					...(tool.annotations ? { annotations: tool.annotations } : {}),
				},
			})
		}
	}
	return items
}
