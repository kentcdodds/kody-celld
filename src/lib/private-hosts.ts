/**
 * Loopback / link-local / RFC1918 / IPv4-mapped literal detection plus the
 * usual single-label and `.local`/`.internal` names. Used by every feature that
 * makes the server (or a sidecar on its network) fetch a user-supplied URL.
 * Names that merely *resolve* to private space cannot be checked here.
 */

const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isPrivateIpv4(host: string) {
	const match = ipv4Pattern.exec(host)
	if (!match) return false
	const [a = 0, b = 0] = match.slice(1).map(Number)
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		a >= 224
	)
}

function isPrivateIpv6(host: string) {
	const inner = host.replace(/^\[|\]$/g, '').toLowerCase()
	if (inner === '::1' || inner === '::') return true
	if (inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) return true
	// IPv4-mapped: the URL parser normalizes ::ffff:a.b.c.d to ::ffff:hhhh:hhhh.
	const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(inner)
	if (dotted) return isPrivateIpv4(dotted[1] ?? '')
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner)
	if (hex) {
		const hi = parseInt(hex[1] ?? '0', 16)
		const lo = parseInt(hex[2] ?? '0', 16)
		return isPrivateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
	}
	return false
}

/** True for hostnames that are loopback/private by name or literal address. */
export function isPrivateHostname(hostname: string) {
	const host = hostname.toLowerCase()
	if (host.includes(':')) return isPrivateIpv6(host)
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.internal') ||
		host.endsWith('.local') ||
		!host.includes('.') ||
		isPrivateIpv4(host)
	)
}
