import { parseHostAllowlist } from './host-allowlist.ts'

/** Single operator allowlist for private/LAN hosts (MCP, browser, packages, insecure secret HTTP). */
export const privateHostsEnvKey = 'KODY_PRIVATE_HOSTS'

/**
 * Removed in favour of {@link privateHostsEnvKey}. Presence (even empty) fails at
 * config load — see https://github.com/kentcdodds/kody-celld/issues/62.
 */
export const removedPrivateHostEnvKeys = [
	'KODY_MCP_ALLOW_PRIVATE_HOSTS',
	'KODY_BROWSER_ALLOW_PRIVATE_HOSTS',
	'KODY_PACKAGE_SOURCE_HOSTS',
	'KODY_ALLOW_INSECURE_SECRET_HOSTS',
] as const

export type PrivateHostsEnv = {
	KODY_PRIVATE_HOSTS?: string
	KODY_MCP_ALLOW_PRIVATE_HOSTS?: string
	KODY_BROWSER_ALLOW_PRIVATE_HOSTS?: string
	KODY_PACKAGE_SOURCE_HOSTS?: string
	KODY_ALLOW_INSECURE_SECRET_HOSTS?: string
}

const noticeUrl = 'https://github.com/kentcdodds/kody-celld/issues/62'

/** Fail loudly when any removed allowlist variable is still set. */
export function assertNoRemovedPrivateHostEnv(env: PrivateHostsEnv): void {
	for (const key of removedPrivateHostEnvKeys) {
		if (env[key] !== undefined) {
			throw new Error(`${key} was removed; set ${privateHostsEnvKey} instead (see ${noticeUrl}).`)
		}
	}
}

/** Parse `KODY_PRIVATE_HOSTS`, refusing any of the removed variable names. */
export function privateHostsFromEnv(env: PrivateHostsEnv): Array<string> {
	assertNoRemovedPrivateHostEnv(env)
	return parseHostAllowlist(env.KODY_PRIVATE_HOSTS, privateHostsEnvKey)
}
