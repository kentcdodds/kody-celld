/**
 * Operator allowlists for private/LAN hosts (KODY_BROWSER_ALLOW_PRIVATE_HOSTS,
 * KODY_MCP_ALLOW_PRIVATE_HOSTS). An entry is an exact hostname, `*.suffix`
 * (subdomains only), an IPv4/IPv6 literal, or a CIDR range. IP and CIDR entries
 * match IP-literal hosts only: names are never DNS-resolved here.
 */

// `_` is allowed in labels: compose service names (`my_service`) are valid Docker DNS names.
const hostnamePattern =
	/^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/

function parseIpv4(text: string): bigint | null {
	const parts = text.split('.')
	if (parts.length !== 4) return null
	let value = 0n
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const n = Number(part)
		if (n > 255) return null
		value = (value << 8n) | BigInt(n)
	}
	return value
}

function parseIpv6(text: string): bigint | null {
	if (!/^[0-9a-f:.]+$/.test(text) || !text.includes(':')) return null
	const halves = text.split('::')
	if (halves.length > 2) return null
	const groups = (half: string) => (half === '' ? [] : half.split(':'))
	const head = groups(halves[0] ?? '')
	const tail = halves.length === 2 ? groups(halves[1] ?? '') : []
	const words: Array<number> = []
	const pushGroups = (list: Array<string>) => {
		for (const [i, group] of list.entries()) {
			if (group.includes('.')) {
				if (i !== list.length - 1) return false
				const v4 = parseIpv4(group)
				if (v4 === null) return false
				words.push(Number(v4 >> 16n), Number(v4 & 0xffffn))
				continue
			}
			if (!/^[0-9a-f]{1,4}$/.test(group)) return false
			words.push(parseInt(group, 16))
		}
		return true
	}
	if (!pushGroups(head)) return null
	const headWords = words.length
	if (!pushGroups(tail)) return null
	const tailWords = words.splice(headWords)
	const missing = 8 - words.length - tailWords.length
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null
	const all = [...words, ...new Array<number>(Math.max(missing, 0)).fill(0), ...tailWords]
	return all.reduce((acc, word) => (acc << 16n) | BigInt(word), 0n)
}

const mappedPrefix = 0xffffn << 32n

/** Parses an IP literal (optionally bracketed). IPv4-mapped IPv6 comes back as version 4. */
export function parseIpLiteral(host: string): { version: 4 | 6; value: bigint } | null {
	const text = host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
	const v4 = parseIpv4(text)
	if (v4 !== null) return { version: 4, value: v4 }
	const v6 = parseIpv6(text)
	if (v6 === null) return null
	if (v6 >> 32n === 0xffffn && (v6 & mappedPrefix) === mappedPrefix) return { version: 4, value: v6 & 0xffffffffn }
	return { version: 6, value: v6 }
}

function formatIpv4(value: bigint): string {
	return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.')
}

function cidrMask(prefix: number, width: number): bigint {
	return prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix)
}

function inCidr(value: bigint, network: bigint, prefix: number, width: number) {
	const mask = cidrMask(prefix, width)
	return (value & mask) === (network & mask)
}

const privateV4: ReadonlyArray<readonly [bigint, number]> = (
	[
		['0.0.0.0', 8],
		['10.0.0.0', 8],
		['100.64.0.0', 10],
		['127.0.0.0', 8],
		['169.254.0.0', 16],
		['172.16.0.0', 12],
		['192.0.0.0', 24],
		['192.168.0.0', 16],
		['198.18.0.0', 15],
		['224.0.0.0', 4],
		['240.0.0.0', 4],
		['255.255.255.255', 32],
	] as const
).map(([address, prefix]) => [parseIpv4(address)!, prefix] as const)

const privateV6: ReadonlyArray<readonly [bigint, number]> = (
	[
		['64:ff9b:1::', 48], // local-use NAT64
		['fc00::', 7], // unique local
		['fe80::', 10], // link-local
		['fec0::', 10], // site-local (deprecated)
		['ff00::', 8], // multicast
		['100::', 64], // discard-only
	] as const
).map(([address, prefix]) => [parseIpv6(address)!, prefix] as const)

function isPrivateV4(value: bigint): boolean {
	return privateV4.some(([network, prefix]) => inCidr(value, network, prefix, 32))
}

function isPrivateV6(value: bigint): boolean {
	const low32 = value & 0xffffffffn
	// ::/96 IPv4-compatible (covers :: and ::1), ::ffff:0:0:0/96 IPv4-translated, 64:ff9b::/96 NAT64: embedded IPv4.
	const top96 = value >> 32n
	if (top96 === 0n || top96 === 0xffff0000n || top96 === 0x64ff9bn << 64n) return isPrivateV4(low32)
	// 2002::/16 6to4: the IPv4 address is the next 32 bits.
	if (value >> 112n === 0x2002n) return isPrivateV4((value >> 80n) & 0xffffffffn)
	return privateV6.some(([network, prefix]) => inCidr(value, network, prefix, 128))
}

/**
 * True when `host` is an IP literal (brackets and non-canonical v6 forms allowed) in loopback,
 * private, link-local, CGNAT, multicast, reserved or translation space, including v6 forms that
 * embed a private IPv4 address (mapped, compatible, translated, NAT64, 6to4). Names return false.
 */
export function isPrivateIp(host: string): boolean {
	const ip = parseIpLiteral(host)
	if (!ip) return false
	return ip.version === 4 ? isPrivateV4(ip.value) : isPrivateV6(ip.value)
}

/**
 * True for hostnames that are private by name (localhost, `.local` / `.internal`, single-label)
 * or by literal address (the union of every range `isPrivateIp` covers). Names that merely
 * *resolve* to private space cannot be checked here.
 */
export function isPrivateHostname(hostname: string): boolean {
	const host = hostname.toLowerCase()
	if (isPrivateIp(host)) return true
	if (host.includes(':')) return false
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.internal') ||
		host.endsWith('.local') ||
		!host.includes('.')
	)
}

/** An entry that is well-formed but can never match; its message is shown as is. */
class UnmatchableEntryError extends Error {}

type Entry =
	| { kind: 'host'; host: string }
	| { kind: 'suffix'; suffix: string }
	| { kind: 'cidr'; version: 4 | 6; network: bigint; prefix: number }

function parseEntry(raw: string): Entry {
	const entry = raw.trim().toLowerCase()
	if (!entry) throw new Error('empty entry')
	if (entry.includes('/')) {
		const [address = '', prefixText = '', ...rest] = entry.split('/')
		if (rest.length > 0 || !/^\d{1,3}$/.test(prefixText)) throw new Error(`"${raw.trim()}" has an invalid prefix`)
		const ip = parseIpLiteral(address)
		const isV4Text = parseIpv4(address) !== null
		if (!ip) throw new Error(`"${raw.trim()}" is not an IP range`)
		if (!isV4Text && ip.version === 4) {
			const prefix = Number(prefixText)
			const hint =
				prefix >= 96 && prefix <= 128
					? `write it as ${formatIpv4(ip.value & cidrMask(prefix - 96, 32))}/${prefix - 96}`
					: 'write the IPv4 range instead'
			throw new UnmatchableEntryError(
				`"${raw.trim()}" is an IPv4-mapped IPv6 range, which never matches: mapped addresses are compared as IPv4, so ${hint}.`,
			)
		}
		const version: 4 | 6 = isV4Text ? 4 : 6
		const width = version === 4 ? 32 : 128
		const prefix = Number(prefixText)
		if (prefix > width) throw new Error(`"${raw.trim()}" has a prefix above /${width}`)
		const value = version === 4 ? ip.value : (parseIpv6(address.replace(/^\[|\]$/g, '')) ?? 0n)
		return { kind: 'cidr', version, network: value & cidrMask(prefix, width), prefix }
	}
	const ip = parseIpLiteral(entry)
	if (ip) {
		const width = ip.version === 4 ? 32 : 128
		return { kind: 'cidr', version: ip.version, network: ip.value, prefix: width }
	}
	if (entry.startsWith('*.')) {
		const suffix = entry.slice(2)
		if (!hostnamePattern.test(suffix)) throw new Error(`"${raw.trim()}" is not a valid *.suffix`)
		return { kind: 'suffix', suffix: `.${suffix}` }
	}
	if (!hostnamePattern.test(entry)) throw new Error(`"${raw.trim()}" is not a hostname, *.suffix, IP or CIDR range`)
	return { kind: 'host', host: entry }
}

/** Validates one entry and returns its normalized text (lowercase, brackets removed). */
export function normalizeAllowlistEntry(entry: string): string {
	parseEntry(entry)
	return entry
		.trim()
		.toLowerCase()
		.replace(/^\[|\](?=\/|$)/g, '')
}

/** Comma-separated env value → normalized entries. Errors name the variable and the entry. */
export function parseHostAllowlist(raw: string | undefined, variable: string): Array<string> {
	const out: Array<string> = []
	for (const part of (raw ?? '').split(',')) {
		if (!part.trim()) continue
		try {
			out.push(normalizeAllowlistEntry(part))
		} catch (error) {
			if (error instanceof UnmatchableEntryError) throw new Error(`${variable}: ${error.message}`)
			throw new Error(`${variable}: "${part.trim()}" is not a hostname, *.suffix, IP or CIDR range.`)
		}
	}
	return out
}

function inRange(ip: { version: 4 | 6; value: bigint }, entry: Extract<Entry, { kind: 'cidr' }>) {
	if (ip.version !== entry.version) return false
	return inCidr(ip.value, entry.network, entry.prefix, entry.version === 4 ? 32 : 128)
}

/** True when `hostname` (a URL hostname, brackets allowed) matches any entry. */
export function hostMatchesAllowlist(hostname: string, entries: ReadonlyArray<string>): boolean {
	const host = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
	const ip = parseIpLiteral(host)
	for (const raw of entries) {
		let entry: Entry
		try {
			entry = parseEntry(raw)
		} catch {
			continue
		}
		if (entry.kind === 'cidr') {
			if (ip && inRange(ip, entry)) return true
		} else if (ip) {
			continue
		} else if (entry.kind === 'suffix') {
			if (host.endsWith(entry.suffix) && host.length > entry.suffix.length) return true
		} else if (host === entry.host) {
			return true
		}
	}
	return false
}
