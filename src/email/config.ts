/**
 * Operator-level email configuration. celld has no Email Routing / Email
 * Sending binding, so both directions are generic adapters:
 *
 *  - inbound: generic JSON (or the self-hosted mail-bridge) POSTed to
 *    `/email/inbound/<provider>`
 *  - outbound: the mail-bridge sidecar (SMTP relay)
 *
 * Vendor-specific adapters (Resend, Postmark, Mailgun, SendGrid, Cloudflare)
 * were removed — see https://github.com/kentcdodds/kody-celld/issues/63.
 * Provider tokens are deployment settings; they never reach sandbox code and
 * are not stored in any cell.
 */

export const inboundProviders = ['generic', 'bridge'] as const
export type InboundProvider = (typeof inboundProviders)[number]

export const outboundProviders = ['bridge'] as const
export type OutboundProvider = (typeof outboundProviders)[number]

const removedOutboundProviders = ['resend', 'postmark', 'mailgun', 'sendgrid'] as const
const removedInboundProviders = ['postmark', 'mailgun', 'sendgrid', 'cloudflare'] as const
const noticeUrl = 'https://github.com/kentcdodds/kody-celld/issues/63'

export type EmailEnv = {
	/** Domain users receive mail on: `<local>@<domain>`. Unset disables the inbox surface. */
	KODY_EMAIL_DOMAIN?: string
	/** Shared secret every inbound/event adapter must present (bearer, basic password, or `?token=`). */
	KODY_EMAIL_INBOUND_TOKEN?: string
	/** @deprecated Removed — see #63. Presence fails loudly. */
	KODY_EMAIL_MAILGUN_SIGNING_KEY?: string
	KODY_EMAIL_OUTBOUND_PROVIDER?: string
	/** Bridge base URL. */
	KODY_EMAIL_OUTBOUND_URL?: string
	/** Bridge bearer token. */
	KODY_EMAIL_OUTBOUND_TOKEN?: string
	/** @deprecated Removed — see #63. Presence fails loudly. */
	KODY_EMAIL_MAILGUN_DOMAIN?: string
	/** Display name for platform senders, e.g. "Kody". */
	KODY_EMAIL_FROM_NAME?: string
	KODY_EMAIL_TIMEOUT_MS?: string
}

export type OutboundConfig = {
	provider: OutboundProvider
	baseUrl: string
	token: string
	timeoutMs: number
}

export type EmailConfig = {
	domain: string
	inboundToken: string | null
	fromName: string
	outbound: OutboundConfig | null
} | null

export const defaultEmailTimeoutMs = 20_000

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

export const emailDomainPattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

function refuseRemoved(kind: 'outbound' | 'inbound', value: string) {
	if (kind === 'outbound') {
		throw new Error(
			`KODY_EMAIL_OUTBOUND_PROVIDER="${value}" was removed; use bridge (SMTP via mail-bridge) (see ${noticeUrl}).`,
		)
	}
	throw new Error(`Inbound email provider "${value}" was removed; use generic or bridge (see ${noticeUrl}).`)
}

export function emailConfigFromEnv(env: EmailEnv): EmailConfig {
	if (env.KODY_EMAIL_MAILGUN_SIGNING_KEY !== undefined || env.KODY_EMAIL_MAILGUN_DOMAIN !== undefined) {
		throw new Error(`KODY_EMAIL_MAILGUN_* settings were removed with the Mailgun adapter (see ${noticeUrl}).`)
	}
	const domain = trimmed(env.KODY_EMAIL_DOMAIN)?.toLowerCase()
	if (!domain) return null
	if (!emailDomainPattern.test(domain)) throw new Error(`KODY_EMAIL_DOMAIN: "${domain}" is not a bare domain name.`)
	const timeoutRaw = trimmed(env.KODY_EMAIL_TIMEOUT_MS)
	let timeoutMs = defaultEmailTimeoutMs
	if (timeoutRaw !== undefined) {
		if (!/^\d+$/.test(timeoutRaw)) throw new Error(`KODY_EMAIL_TIMEOUT_MS: expected an integer, got "${timeoutRaw}".`)
		timeoutMs = Number(timeoutRaw)
		if (timeoutMs < 1_000 || timeoutMs > 120_000)
			throw new Error('KODY_EMAIL_TIMEOUT_MS: must be between 1000 and 120000.')
	}
	const provider = trimmed(env.KODY_EMAIL_OUTBOUND_PROVIDER)?.toLowerCase() ?? 'none'
	let outbound: OutboundConfig | null = null
	if (provider !== 'none') {
		if ((removedOutboundProviders as ReadonlyArray<string>).includes(provider)) {
			refuseRemoved('outbound', provider)
		}
		if (!(outboundProviders as ReadonlyArray<string>).includes(provider)) {
			throw new Error(
				`KODY_EMAIL_OUTBOUND_PROVIDER: expected none, ${outboundProviders.join(', ')}; got "${env.KODY_EMAIL_OUTBOUND_PROVIDER}".`,
			)
		}
		const kind = provider as OutboundProvider
		const token = trimmed(env.KODY_EMAIL_OUTBOUND_TOKEN)
		if (!token) throw new Error(`KODY_EMAIL_OUTBOUND_TOKEN is required when KODY_EMAIL_OUTBOUND_PROVIDER=${kind}.`)
		const urlRaw = trimmed(env.KODY_EMAIL_OUTBOUND_URL)
		if (!urlRaw)
			throw new Error('KODY_EMAIL_OUTBOUND_URL (the mail-bridge base URL) is required for the bridge provider.')
		outbound = {
			provider: kind,
			baseUrl: httpUrl('KODY_EMAIL_OUTBOUND_URL', urlRaw),
			token,
			timeoutMs,
		}
	}
	return {
		domain,
		inboundToken: trimmed(env.KODY_EMAIL_INBOUND_TOKEN) ?? null,
		fromName: trimmed(env.KODY_EMAIL_FROM_NAME) ?? 'Kody',
		outbound,
	}
}

/** Safe-to-print summary (no tokens). */
export function describeEmailConfig(config: EmailConfig) {
	if (!config) return { configured: false as const, domain: null, inbound: false, outbound: 'none' as const }
	return {
		configured: true as const,
		domain: config.domain,
		inbound: config.inboundToken !== null,
		inboundProviders: [...inboundProviders],
		outbound: config.outbound?.provider ?? ('none' as const),
		outboundBaseUrl: config.outbound?.baseUrl ?? null,
		fromName: config.fromName,
	}
}

export function assertInboundProviderAllowed(provider: string): InboundProvider {
	const value = provider.toLowerCase()
	if ((removedInboundProviders as ReadonlyArray<string>).includes(value)) {
		refuseRemoved('inbound', value)
	}
	if (!(inboundProviders as ReadonlyArray<string>).includes(value)) {
		throw new Error(`Unknown inbound email provider "${provider}". Expected ${inboundProviders.join(', ')}.`)
	}
	return value as InboundProvider
}

export function assertOutboundEventsProviderAllowed(provider: string): OutboundProvider {
	const value = provider.toLowerCase()
	if ((removedOutboundProviders as ReadonlyArray<string>).includes(value)) {
		refuseRemoved('outbound', value)
	}
	if (!(outboundProviders as ReadonlyArray<string>).includes(value)) {
		throw new Error(`Unknown email events provider "${provider}". Expected ${outboundProviders.join(', ')}.`)
	}
	return value as OutboundProvider
}
