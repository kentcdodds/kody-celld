import { hostMatchesAllowlist, isPrivateHostname, parseHostAllowlist } from '../lib/host-allowlist.ts'
import { KodyError } from '../lib/errors.ts'

export type McpEnv = {
	KODY_MCP_ALLOW_PRIVATE_HOSTS?: string
	KODY_MCP_CALL_TIMEOUT_MS?: string
	KODY_DNS_RESOLVER_URL?: string
}

export type McpConfig = { allowPrivateHosts: Array<string>; callTimeoutMs: number; dnsResolverUrl: string }

export const defaultMcpCallTimeoutMs = 30_000
export const defaultDnsResolverUrl = 'https://cloudflare-dns.com/dns-query'
export const mcpServerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export function mcpConfigFromEnv(env: McpEnv): McpConfig {
	try {
		const allowPrivateHosts = parseHostAllowlist(env.KODY_MCP_ALLOW_PRIVATE_HOSTS, 'KODY_MCP_ALLOW_PRIVATE_HOSTS')
		const raw = env.KODY_MCP_CALL_TIMEOUT_MS?.trim()
		let callTimeoutMs = defaultMcpCallTimeoutMs
		if (raw) {
			callTimeoutMs = Number(raw)
			if (!Number.isInteger(callTimeoutMs) || callTimeoutMs < 1_000 || callTimeoutMs > 600_000) {
				throw new Error(`KODY_MCP_CALL_TIMEOUT_MS: expected an integer between 1000 and 600000, got "${raw}".`)
			}
		}
		const resolverRaw = env.KODY_DNS_RESOLVER_URL?.trim() || defaultDnsResolverUrl
		let dnsResolverUrl: string
		try {
			const parsed = new URL(resolverRaw)
			if (parsed.protocol !== 'https:') throw new Error('not https')
			dnsResolverUrl = parsed.href
		} catch {
			throw new Error(`KODY_DNS_RESOLVER_URL: expected an https URL, got "${resolverRaw}".`)
		}
		return { allowPrivateHosts, callTimeoutMs, dnsResolverUrl }
	} catch (error) {
		throw new KodyError('config_error', error instanceof Error ? error.message : String(error), { status: 500 })
	}
}

/** The URL policy for every hop (first URL and each redirect). */
export function assertMcpUrl(raw: string, config: McpConfig): URL {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new KodyError('invalid_args', `"${raw}" is not a valid URL.`)
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new KodyError('invalid_args', 'MCP server URLs must use http or https.')
	}
	if (url.username || url.password) {
		throw new KodyError('invalid_args', 'MCP server URLs must not contain credentials; pass bearerToken instead.')
	}
	url.hash = ''
	const host = url.hostname.toLowerCase()
	if (hostMatchesAllowlist(host, config.allowPrivateHosts)) return url
	if (isPrivateHostname(host)) {
		throw new KodyError(
			'mcp_host_not_allowed',
			`"${host}" is a loopback/private host. Add it (or its CIDR range) to KODY_MCP_ALLOW_PRIVATE_HOSTS on the server to use it.`,
			{ status: 403 },
		)
	}
	if (url.protocol === 'http:') {
		throw new KodyError(
			'mcp_host_not_allowed',
			`Plain http is only allowed for hosts in KODY_MCP_ALLOW_PRIVATE_HOSTS; use https for "${host}".`,
			{ status: 403 },
		)
	}
	return url
}

export function assertMcpServerName(name: unknown): string {
	if (typeof name !== 'string' || !mcpServerNamePattern.test(name)) {
		throw new KodyError(
			'invalid_args',
			'MCP server name must be 1-64 lowercase letters, digits or "-", starting and ending with a letter or digit.',
		)
	}
	return name
}

/** Bare token → `Bearer <token>`; `Scheme value` kept; a pasted `Authorization:` header name is stripped. */
export function normalizeBearerToken(raw: unknown): string {
	if (typeof raw !== 'string') throw new KodyError('invalid_args', 'bearerToken must be a string.')
	const value = raw.trim().replace(/^authorization:\s*/i, '')
	if (!value || value.length > 8192 || /[\r\n]/.test(value)) {
		throw new KodyError('invalid_args', 'bearerToken must be 1-8192 characters on one line.')
	}
	return /^[A-Za-z][A-Za-z0-9._~+-]*\s+\S/.test(value) ? value : `Bearer ${value}`
}
