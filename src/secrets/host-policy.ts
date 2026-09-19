import { KodyError } from '../lib/errors.ts'

const hostnameRegex = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ipv4Regex = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/**
 * Normalizes an approved-host entry. Accepts a bare hostname, an IPv4 literal,
 * a bracketed IPv6 literal, or a leading `*.` wildcard for one label depth.
 * Rejects schemes, paths, ports, and anything that is not a plausible host.
 */
export function normalizeSecretHost(input: string) {
	const raw = input.trim().toLowerCase()
	if (!raw) throw new KodyError('invalid_host', 'Host is required.')
	if (raw.includes('/') || raw.includes('?') || raw.includes('#') || raw.includes('@')) {
		throw new KodyError('invalid_host', `Host "${input}" must not contain a scheme or path.`)
	}
	if (raw.startsWith('[') && raw.endsWith(']')) {
		const inner = raw.slice(1, -1)
		if (!/^[0-9a-f:.]+$/.test(inner) || !inner.includes(':')) {
			throw new KodyError('invalid_host', `Host "${input}" is not a valid IPv6 literal.`)
		}
		return raw
	}
	let wildcard = false
	let host = raw
	if (host.startsWith('*.')) {
		wildcard = true
		host = host.slice(2)
	}
	if (host.includes(':')) {
		throw new KodyError('invalid_host', `Host "${input}" must not include a port.`)
	}
	if (ipv4Regex.test(host)) {
		if (wildcard) throw new KodyError('invalid_host', 'Wildcards are not allowed on IP hosts.')
		return host
	}
	if (!hostnameRegex.test(host)) {
		throw new KodyError('invalid_host', `Host "${input}" is not a valid hostname.`)
	}
	if (wildcard && !host.includes('.')) {
		throw new KodyError('invalid_host', 'Wildcard hosts need at least one fixed label.')
	}
	return wildcard ? `*.${host}` : host
}

/** Extracts the comparable host from a request URL (lowercase, no port). */
export function requestHost(url: URL) {
	return url.hostname.toLowerCase()
}

export function hostMatchesApproval(host: string, approved: string) {
	if (approved.startsWith('*.')) {
		const suffix = approved.slice(1)
		return host.endsWith(suffix) && host.length > suffix.length
	}
	return host === approved
}

export function isHostApproved(host: string, approvedHosts: Iterable<string>) {
	for (const approved of approvedHosts) {
		if (hostMatchesApproval(host, approved)) return true
	}
	return false
}

/** Parses `KODY_ALLOW_INSECURE_SECRET_HOSTS` (comma-separated hosts or the `loopback` keyword). */
export function parseInsecureHostAllowance(value: string | undefined) {
	return (value ?? '')
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean)
}

/** Credentials only travel over https unless the operator allowed this host in plain http (dev/loopback). */
export function isCredentialTransportAllowed(url: URL, insecureAllowance: ReadonlyArray<string>) {
	if (url.protocol === 'https:') return true
	if (url.protocol !== 'http:') return false
	const host = requestHost(url)
	return insecureAllowance.includes(host) || (insecureAllowance.includes('loopback') && isLoopbackHost(host))
}

export function isLoopbackHost(host: string) {
	return (
		host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1'
	)
}
