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

/** Best-effort resolved-IP check before a hop (see docs/mcp-servers.md for the rebinding limit; tracked in #45). */
export async function assertResolvedHostAllowed(url: URL, config: McpConfig, fetchImpl: typeof fetch): Promise<void> {
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
	if (parseIpLiteral(host)) return
	if (hostMatchesAllowlist(host, config.allowPrivateHosts)) return
	let addresses: Array<string>
	try {
		const [a, aaaa] = await Promise.all([lookup(host, 'A', config, fetchImpl), lookup(host, 'AAAA', config, fetchImpl)])
		addresses = [...a, ...aaaa]
	} catch (error) {
		throw refuse(
			`Could not resolve "${host}" through KODY_DNS_RESOLVER_URL (${error instanceof Error ? error.message : String(error)}).`,
		)
	}
	if (addresses.length === 0) {
		throw refuse(`Could not resolve "${host}" through KODY_DNS_RESOLVER_URL (no A/AAAA records).`)
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
