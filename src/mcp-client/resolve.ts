import { KodyError } from '../lib/errors.ts'
import { hostMatchesAllowlist, isPrivateHostname, parseIpLiteral } from '../lib/host-allowlist.ts'
import type { McpConfig } from './policy.ts'

type DnsJson = { Status?: number; Answer?: Array<{ type: number; data: string }> }

async function lookup(host: string, type: 'A' | 'AAAA', config: McpConfig, fetchImpl: typeof fetch) {
	const url = new URL(config.dnsResolverUrl)
	url.searchParams.set('name', host)
	url.searchParams.set('type', type)
	const response = await fetchImpl(url.href, {
		headers: { accept: 'application/dns-json' },
		signal: AbortSignal.timeout(5_000),
	})
	if (!response.ok) throw new Error(`resolver HTTP ${response.status}`)
	const body = (await response.json()) as DnsJson
	if (body.Status !== 0 && body.Status !== undefined) throw new Error(`resolver status ${body.Status}`)
	const wanted = type === 'A' ? 1 : 28
	return (body.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data.toLowerCase())
}

function refuse(message: string) {
	return new KodyError('mcp_host_not_allowed', message, { status: 403 })
}

/**
 * DoH answers for one MCP call (one connect / tools/list / tools/call, or one OAuth flow), keyed by host (#47).
 * Never shared across calls: that would widen the rebinding gap until #45 replaces this pre-check.
 */
export type DnsMemo = Map<string, Promise<Array<string>>>

async function resolveAddresses(host: string, config: McpConfig, fetchImpl: typeof fetch) {
	const [a, aaaa] = await Promise.all([lookup(host, 'A', config, fetchImpl), lookup(host, 'AAAA', config, fetchImpl)])
	const addresses = [...a, ...aaaa]
	// An empty answer is a failed lookup too: refused, and (like any failure) not kept in the call's memo.
	if (addresses.length === 0) throw new Error('no A/AAAA records')
	return addresses
}

/** Best-effort resolved-IP check before a hop (see docs/mcp-servers.md for the rebinding limit; tracked in #45). */
export async function assertResolvedHostAllowed(
	url: URL,
	config: McpConfig,
	fetchImpl: typeof fetch,
	memo?: DnsMemo,
): Promise<void> {
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
	if (parseIpLiteral(host)) return
	if (hostMatchesAllowlist(host, config.allowPrivateHosts)) return
	let addresses: Array<string>
	try {
		let pending = memo?.get(host)
		if (!pending) {
			pending = resolveAddresses(host, config, fetchImpl)
			// Concurrent hops share the lookup; a failure is not remembered, so the next hop asks again.
			if (memo) {
				memo.set(host, pending)
				pending.catch(() => {
					if (memo.get(host) === pending) memo.delete(host)
				})
			}
		}
		addresses = await pending
	} catch (error) {
		throw refuse(
			`Could not resolve "${host}" through KODY_DNS_RESOLVER_URL (${error instanceof Error ? error.message : String(error)}).`,
		)
	}
	for (const address of addresses) {
		const literal = address.includes(':') ? `[${address}]` : address
		if (isPrivateHostname(literal) && !hostMatchesAllowlist(address, config.allowPrivateHosts)) {
			throw refuse(
				`"${host}" resolves to private address ${address}. Add the address or its range to KODY_PRIVATE_HOSTS to allow it.`,
			)
		}
	}
}
