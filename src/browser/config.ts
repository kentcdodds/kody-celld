/**
 * Operator-level browser rendering configuration. celld has no Browser
 * Rendering binding, so Kody talks to a headless-Chrome HTTP service: a
 * self-hosted browserless / CDP container (compose.browser.yaml). Tokens are
 * deployment settings and never reach sandbox code.
 *
 * The Cloudflare Browser Rendering adapter was removed — see
 * https://github.com/kentcdodds/kody-celld/issues/63.
 */

import { privateHostsFromEnv, type PrivateHostsEnv } from '../lib/private-hosts-env.ts'

export type BrowserProviderKind = 'browserless'

const noticeUrl = 'https://github.com/kentcdodds/kody-celld/issues/63'

export type BrowserEnv = PrivateHostsEnv & {
	KODY_BROWSER_PROVIDER?: string
	KODY_BROWSER_URL?: string
	KODY_BROWSER_TOKEN?: string
	/** @deprecated Removed — see #63. Presence fails loudly. */
	KODY_BROWSER_CF_ACCOUNT_ID?: string
	KODY_BROWSER_TIMEOUT_MS?: string
}

export type BrowserConfig = {
	provider: BrowserProviderKind
	/** Base URL of the rendering service (browserless / CDP HTTP API). */
	baseUrl: string
	token: string | null
	timeoutMs: number
	/** Exact hosts, `*.suffix`, IPs or CIDR ranges that may be rendered although they are private/loopback. */
	allowPrivateHosts: Array<string>
} | null

export const defaultBrowserTimeoutMs = 30_000

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
	if (env.KODY_BROWSER_CF_ACCOUNT_ID !== undefined) {
		throw new Error(
			`KODY_BROWSER_CF_ACCOUNT_ID was removed with the Cloudflare browser adapter; use KODY_BROWSER_PROVIDER=browserless (see ${noticeUrl}).`,
		)
	}
	const provider = trimmed(env.KODY_BROWSER_PROVIDER)?.toLowerCase() ?? 'none'
	if (provider === 'none') return null
	if (provider === 'cloudflare') {
		throw new Error(`KODY_BROWSER_PROVIDER=cloudflare was removed; use browserless (see ${noticeUrl}).`)
	}
	if (provider !== 'browserless') {
		throw new Error(`KODY_BROWSER_PROVIDER: expected none or browserless, got "${env.KODY_BROWSER_PROVIDER}".`)
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
	const allowPrivateHosts = privateHostsFromEnv(env)
	const url = trimmed(env.KODY_BROWSER_URL)
	if (!url) throw new Error('KODY_BROWSER_URL is required when KODY_BROWSER_PROVIDER=browserless.')
	return { provider, baseUrl: httpUrl('KODY_BROWSER_URL', url), token, timeoutMs, allowPrivateHosts }
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
