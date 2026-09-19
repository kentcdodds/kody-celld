/**
 * Operator-level configuration for bare npm imports inside `execute`. Modules
 * are fetched as ES modules from an esm.sh-compatible CDN (the public esm.sh by
 * default, or a self-hosted instance from compose.esm.yaml) and kept in the
 * fleet-wide NpmCacheCell so every node reuses one download.
 */

export type NpmEnv = {
	/** `on` (default) or `off`: disables bare npm specifiers entirely. */
	KODY_NPM_IMPORTS?: string
	/** Origin of an esm.sh-compatible CDN (default https://esm.sh). */
	KODY_ESM_CDN_URL?: string
	/** Durable cache ceiling in MiB (default 256; 0 disables the durable cache). */
	KODY_NPM_CACHE_MAX_MB?: string
	/** Cached module lifetime in days (default 30). */
	KODY_NPM_CACHE_TTL_DAYS?: string
}

export type NpmConfig = {
	enabled: boolean
	cdnOrigin: string
	cacheMaxBytes: number
	cacheTtlMs: number
}

export const defaultEsmCdnOrigin = 'https://esm.sh'
export const defaultNpmCacheMaxMb = 256
export const defaultNpmCacheTtlDays = 30
/** Largest single module the durable cache will hold (Durable Object SQLite values cap near 2 MiB). */
export const npmCacheMaxModuleBytes = 1_800_000

function trimmed(value: string | undefined) {
	const v = value?.trim()
	return v ? v : undefined
}

function nonNegativeNumber(name: string, raw: string | undefined, fallback: number) {
	const value = trimmed(raw)
	if (value === undefined) return fallback
	const n = Number(value)
	if (!Number.isFinite(n) || n < 0) throw new Error(`${name}: expected a non-negative number, got "${raw}".`)
	return n
}

export function npmConfigFromEnv(env: NpmEnv): NpmConfig {
	const mode = trimmed(env.KODY_NPM_IMPORTS)?.toLowerCase() ?? 'on'
	if (mode !== 'on' && mode !== 'off') {
		throw new Error(`KODY_NPM_IMPORTS: expected on or off, got "${env.KODY_NPM_IMPORTS}".`)
	}
	const cdnRaw = trimmed(env.KODY_ESM_CDN_URL) ?? defaultEsmCdnOrigin
	let cdn: URL
	try {
		cdn = new URL(cdnRaw)
	} catch {
		throw new Error(`KODY_ESM_CDN_URL: "${cdnRaw}" is not a valid URL.`)
	}
	if (cdn.protocol !== 'http:' && cdn.protocol !== 'https:') {
		throw new Error('KODY_ESM_CDN_URL: only http(s) URLs are supported.')
	}
	if (cdn.pathname !== '/' || cdn.search || cdn.hash) {
		throw new Error('KODY_ESM_CDN_URL: give the CDN origin only (no path or query).')
	}
	return {
		enabled: mode === 'on',
		cdnOrigin: cdn.origin,
		cacheMaxBytes:
			nonNegativeNumber('KODY_NPM_CACHE_MAX_MB', env.KODY_NPM_CACHE_MAX_MB, defaultNpmCacheMaxMb) * 1024 * 1024,
		cacheTtlMs:
			nonNegativeNumber('KODY_NPM_CACHE_TTL_DAYS', env.KODY_NPM_CACHE_TTL_DAYS, defaultNpmCacheTtlDays) *
			24 *
			60 *
			60 *
			1000,
	}
}

export function describeNpmConfig(config: NpmConfig) {
	return {
		enabled: config.enabled,
		cdnOrigin: config.cdnOrigin,
		durableCache: config.cacheMaxBytes > 0,
		cacheMaxMb: config.cacheMaxBytes / 1024 / 1024,
		cacheTtlDays: config.cacheTtlMs / 24 / 60 / 60 / 1000,
	}
}
