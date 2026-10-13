import { getDomain } from 'tldts'
import { readAppConfig } from './app-url.ts'

/**
 * Public-Suffix-List registrable domain for a hostname, or null when the host
 * has none (localhost, IPs, bare labels without a known suffix).
 */
export function registrableDomain(hostname: string): string | null {
	const trimmed = hostname.trim().toLowerCase()
	if (!trimmed) return null
	// Private PSL entries (github.io, etc.) must count as public suffixes so
	// sibling labels are distinct registrable domains.
	return getDomain(trimmed, { allowPrivateDomains: true })
}

/** True when both hosts resolve to the same non-null registrable domain. */
export function shareRegistrableDomain(hostnameA: string, hostnameB: string): boolean {
	const a = registrableDomain(hostnameA)
	const b = registrableDomain(hostnameB)
	return a !== null && b !== null && a === b
}

/**
 * Message when Kody and the package-app origin share a registrable domain, or
 * null when apps are off / misconfigured / on distinct domains.
 */
export function sharedRegistrableDomainWarning(env: {
	KODY_PUBLIC_URL: string
	KODY_APP_BASE_URL?: string | undefined
}): string | null {
	const apps = readAppConfig(env)
	if (!apps?.ok) return null
	let publicHostname: string
	try {
		publicHostname = new URL(env.KODY_PUBLIC_URL).hostname
	} catch {
		return null
	}
	const domain = registrableDomain(publicHostname)
	if (!domain || !shareRegistrableDomain(publicHostname, apps.config.hostname)) return null
	return (
		`[kody-celld] KODY_PUBLIC_URL and KODY_APP_BASE_URL share the registrable domain "${domain}". ` +
		`Untrusted package-app JavaScript can plant Domain=${domain} cookies that the Kody origin receives. ` +
		`On http installs that can lock out account pages or (on multi-user installs) sign a browser into ` +
		`another account, because session cookies are unprefixed. On https installs, __Host-kody_session / ` +
		`__Host-kody_console cannot be planted that way, but other non-__Host- cookies still can; prefer a ` +
		`separate registrable domain for apps (e.g. example-apps.net).`
	)
}

let sharedDomainChecked = false

/**
 * Once per isolate: log clearly when the Kody origin and the package-app
 * origin sit on the same registrable domain (cookie-planting risk).
 */
export function warnSharedRegistrableDomainOnce(env: {
	KODY_PUBLIC_URL: string
	KODY_APP_BASE_URL?: string | undefined
}) {
	if (sharedDomainChecked) return
	sharedDomainChecked = true
	const message = sharedRegistrableDomainWarning(env)
	if (message) console.warn(message)
}
