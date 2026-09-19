/**
 * Operator-level browser rendering configuration. celld has no Browser
 * Rendering binding, so Kody talks to a headless-Chrome HTTP service instead:
 * a self-hosted browserless container (compose.browser.yaml) by default, or
 * Cloudflare's Browser Rendering REST API for operators who prefer it. Tokens
 * are deployment settings and never reach sandbox code.
 */

export type BrowserProviderKind = 'browserless' | 'cloudflare'

export type BrowserEnv = {
	KODY_BROWSER_PROVIDER?: string
	KODY_BROWSER_URL?: string
	KODY_BROWSER_TOKEN?: string
	KODY_BROWSER_CF_ACCOUNT_ID?: string
	KODY_BROWSER_TIMEOUT_MS?: string
	KODY_BROWSER_ALLOW_PRIVATE_HOSTS?: string
}

export type BrowserConfig = {
	provider: BrowserProviderKind
	/** Base URL of the rendering service (browserless) or Cloudflare API root. */
	baseUrl: string
	token: string | null
	timeoutMs: number
	/** Hostnames (or `*.suffix`) that may be rendered even though they resolve to private/loopback space. */
	allowPrivateHosts: Array<string>
} | null

export const defaultBrowserTimeoutMs = 30_000
export const defaultCloudflareApiUrl = 'https://api.cloudflare.com/client/v4'

function trimmed(value: string | undefined) {
	const v = value?.trim()
	return v ? v : undefined
}

function httpUrl(name: string, raw: string) {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		throw new Error(`${name}: "${raw}" is not a valid URL.`)
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`${name}: only http(s) URLs are supported.`)
	}
	return parsed.toString().replace(/\/+$/, '')
}

export function browserConfigFromEnv(env: BrowserEnv): BrowserConfig {
	const provider = trimmed(env.KODY_BROWSER_PROVIDER)?.toLowerCase() ?? 'none'
	if (provider === 'none') return null
	if (provider !== 'browserless' && provider !== 'cloudflare') {
		throw new Error(
			`KODY_BROWSER_PROVIDER: expected none, browserless or cloudflare, got "${env.KODY_BROWSER_PROVIDER}".`,
		)
	}
	const timeoutRaw = trimmed(env.KODY_BROWSER_TIMEOUT_MS)
	let timeoutMs = defaultBrowserTimeoutMs
	if (timeoutRaw !== undefined) {
		if (!/^\d+$/.test(timeoutRaw)) throw new Error(`KODY_BROWSER_TIMEOUT_MS: expected an integer, got "${timeoutRaw}".`)
		timeoutMs = Number(timeoutRaw)
		if (timeoutMs < 1_000 || timeoutMs > 300_000)
			throw new Error('KODY_BROWSER_TIMEOUT_MS: must be between 1000 and 300000.')
	}
	const token = trimmed(env.KODY_BROWSER_TOKEN) ?? null
	const allowPrivateHosts = (trimmed(env.KODY_BROWSER_ALLOW_PRIVATE_HOSTS) ?? '')
		.split(',')
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean)
	if (provider === 'browserless') {
		const url = trimmed(env.KODY_BROWSER_URL)
		if (!url) throw new Error('KODY_BROWSER_URL is required when KODY_BROWSER_PROVIDER=browserless.')
		return { provider, baseUrl: httpUrl('KODY_BROWSER_URL', url), token, timeoutMs, allowPrivateHosts }
	}
	const accountId = trimmed(env.KODY_BROWSER_CF_ACCOUNT_ID)
	if (!accountId) throw new Error('KODY_BROWSER_CF_ACCOUNT_ID is required when KODY_BROWSER_PROVIDER=cloudflare.')
	if (!token)
		throw new Error('KODY_BROWSER_TOKEN (a Cloudflare API token) is required when KODY_BROWSER_PROVIDER=cloudflare.')
	return {
		provider,
		baseUrl: `${httpUrl('KODY_BROWSER_URL', trimmed(env.KODY_BROWSER_URL) ?? defaultCloudflareApiUrl)}/accounts/${encodeURIComponent(accountId)}/browser-rendering`,
		token,
		timeoutMs,
		allowPrivateHosts,
	}
}

/** Safe-to-print summary (no token). */
export function describeBrowserConfig(config: BrowserConfig) {
	if (!config) return { provider: 'none' as const, configured: false }
	return {
		provider: config.provider,
		configured: true,
		baseUrl: config.baseUrl,
		hasToken: config.token !== null,
		timeoutMs: config.timeoutMs,
		allowPrivateHosts: config.allowPrivateHosts,
	}
}
