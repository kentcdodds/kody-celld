/**
 * Operator-level email configuration. celld has no Email Routing / Email
 * Sending binding, so both directions are adapters:
 *
 *  - inbound: any provider that can POST a message to
 *    `/email/inbound/<provider>` (generic JSON, Postmark, Mailgun, SendGrid,
 *    a Cloudflare Email Worker forwarder, or the self-hosted mail-bridge)
 *  - outbound: the mail-bridge sidecar (SMTP relay), Resend, Postmark,
 *    Mailgun or SendGrid
 *
 * Provider tokens are deployment settings; they never reach sandbox code and
 * are not stored in any cell.
 */

export const inboundProviders = ['generic', 'postmark', 'mailgun', 'sendgrid', 'cloudflare', 'bridge'] as const
export type InboundProvider = (typeof inboundProviders)[number]

export const outboundProviders = ['bridge', 'resend', 'postmark', 'mailgun', 'sendgrid'] as const
export type OutboundProvider = (typeof outboundProviders)[number]

export type EmailEnv = {
	/** Domain users receive mail on: `<local>@<domain>`. Unset disables the inbox surface. */
	KODY_EMAIL_DOMAIN?: string
	/** Shared secret every inbound/event adapter must present (bearer, basic password, or `?token=`). */
	KODY_EMAIL_INBOUND_TOKEN?: string
	/** Mailgun webhook signing key; when set, Mailgun deliveries must also carry a valid signature. */
	KODY_EMAIL_MAILGUN_SIGNING_KEY?: string
	KODY_EMAIL_OUTBOUND_PROVIDER?: string
	/** Bridge base URL, or an API base override (Mailgun EU, self-hosted Postmark-compatible, ...). */
	KODY_EMAIL_OUTBOUND_URL?: string
	/** API key / server token / bridge bearer token. */
	KODY_EMAIL_OUTBOUND_TOKEN?: string
	/** Mailgun sending domain (defaults to KODY_EMAIL_DOMAIN). */
	KODY_EMAIL_MAILGUN_DOMAIN?: string
	/** Display name for platform senders, e.g. "Kody". */
	KODY_EMAIL_FROM_NAME?: string
	KODY_EMAIL_TIMEOUT_MS?: string
}

export type OutboundConfig = {
	provider: OutboundProvider
	baseUrl: string
	token: string
	mailgunDomain: string | null
	timeoutMs: number
}

export type EmailConfig = {
	domain: string
	inboundToken: string | null
	mailgunSigningKey: string | null
	fromName: string
	outbound: OutboundConfig | null
} | null

export const defaultEmailTimeoutMs = 20_000

export const providerDefaultUrls: Record<OutboundProvider, string | null> = {
	bridge: null,
	resend: 'https://api.resend.com',
	postmark: 'https://api.postmarkapp.com',
	mailgun: 'https://api.mailgun.net',
	sendgrid: 'https://api.sendgrid.com',
}

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

export function emailConfigFromEnv(env: EmailEnv): EmailConfig {
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
		if (!(outboundProviders as ReadonlyArray<string>).includes(provider)) {
			throw new Error(
				`KODY_EMAIL_OUTBOUND_PROVIDER: expected none, ${outboundProviders.join(', ')}; got "${env.KODY_EMAIL_OUTBOUND_PROVIDER}".`,
			)
		}
		const kind = provider as OutboundProvider
		const token = trimmed(env.KODY_EMAIL_OUTBOUND_TOKEN)
		if (!token) throw new Error(`KODY_EMAIL_OUTBOUND_TOKEN is required when KODY_EMAIL_OUTBOUND_PROVIDER=${kind}.`)
		const urlRaw = trimmed(env.KODY_EMAIL_OUTBOUND_URL) ?? providerDefaultUrls[kind]
		if (!urlRaw)
			throw new Error('KODY_EMAIL_OUTBOUND_URL (the mail-bridge base URL) is required for the bridge provider.')
		outbound = {
			provider: kind,
			baseUrl: httpUrl('KODY_EMAIL_OUTBOUND_URL', urlRaw),
			token,
			mailgunDomain: kind === 'mailgun' ? (trimmed(env.KODY_EMAIL_MAILGUN_DOMAIN)?.toLowerCase() ?? domain) : null,
			timeoutMs,
		}
	}
	return {
		domain,
		inboundToken: trimmed(env.KODY_EMAIL_INBOUND_TOKEN) ?? null,
		mailgunSigningKey: trimmed(env.KODY_EMAIL_MAILGUN_SIGNING_KEY) ?? null,
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
		mailgunSignatureRequired: config.mailgunSigningKey !== null,
		outbound: config.outbound?.provider ?? ('none' as const),
		outboundBaseUrl: config.outbound?.baseUrl ?? null,
		fromName: config.fromName,
	}
}
