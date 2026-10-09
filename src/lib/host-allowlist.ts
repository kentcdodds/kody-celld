/**
 * Operator allowlists for private/LAN hosts (KODY_BROWSER_ALLOW_PRIVATE_HOSTS,
 * KODY_MCP_ALLOW_PRIVATE_HOSTS). An entry is an exact hostname, `*.suffix`
 * (subdomains only), an IPv4/IPv6 literal, or a CIDR range. IP and CIDR entries
 * match IP-literal hosts only: names are never DNS-resolved here.
 */

const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

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
		const version: 4 | 6 = isV4Text ? 4 : 6
		const width = version === 4 ? 32 : 128
		const prefix = Number(prefixText)
		if (prefix > width) throw new Error(`"${raw.trim()}" has a prefix above /${width}`)
		const value = version === 4 ? ip.value : (parseIpv6(address.replace(/^\[|\]$/g, '')) ?? 0n)
		const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix)
		return { kind: 'cidr', version, network: value & mask, prefix }
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
		} catch {
			throw new Error(`${variable}: "${part.trim()}" is not a hostname, *.suffix, IP or CIDR range.`)
		}
	}
	return out
}

function inRange(ip: { version: 4 | 6; value: bigint }, entry: Extract<Entry, { kind: 'cidr' }>) {
	if (ip.version !== entry.version) return false
	const width = entry.version === 4 ? 32 : 128
	const mask = entry.prefix === 0 ? 0n : ((1n << BigInt(entry.prefix)) - 1n) << BigInt(width - entry.prefix)
	return (ip.value & mask) === entry.network
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
