// Kody-compatible secret placeholder syntax. Ported from
// kentcdodds/kody packages/worker/src/mcp/secrets/placeholders.ts so agents can
// reuse the same `{{secret:name}}` strings against this runtime.

export type SecretScope = 'user' | 'package' | 'session'

const secretPlaceholderRegex = /\{\{secret:([a-zA-Z0-9._-]+)(?:\|scope=(session|package|user))?\}\}/g
const basicAuthSecretPlaceholderRegex =
	/\{\{secret-basic:username=([a-zA-Z0-9._-]+),password=([a-zA-Z0-9._-]+)(?:\|scope=(session|package|user))?\}\}/g
const integrationTokenPlaceholderRegex = /\{\{integration-token:([a-zA-Z0-9._-]+)\}\}/g
const providerSecretPlaceholderRegex = /\{\{secret\/([a-zA-Z0-9._-]+):([^}]+)\}\}/g

export type ReferencedSecret = {
	placeholder: string
	name: string
	scope: SecretScope | null
}

export type ReferencedBasicAuthSecret = {
	placeholder: string
	username: string
	password: string
	scope: SecretScope | null
}

/**
 * WHATWG URL serialization percent-encodes `{` and `}` in pathnames, so a
 * placeholder in a URL path arrives as `%7B%7Bsecret:name%7D%7D`.
 */
export function decodeSecretPlaceholderDelimiters(value: string) {
	return value.replaceAll(/%7B/gi, '{').replaceAll(/%7D/gi, '}')
}

function parseScope(scope: string | undefined): SecretScope | null {
	return scope === 'package' || scope === 'session' || scope === 'user' ? scope : null
}

export function parseSecretPlaceholders(value: string) {
	const secrets: Array<ReferencedSecret> = []
	for (const match of value.matchAll(secretPlaceholderRegex)) {
		const name = match[1]?.trim()
		if (!name) continue
		secrets.push({ placeholder: match[0], name, scope: parseScope(match[2]) })
	}
	return secrets
}

export function parseBasicAuthSecretPlaceholders(value: string) {
	const out: Array<ReferencedBasicAuthSecret> = []
	for (const match of value.matchAll(basicAuthSecretPlaceholderRegex)) {
		const username = match[1]?.trim()
		const password = match[2]?.trim()
		if (!username || !password) continue
		out.push({ placeholder: match[0], username, password, scope: parseScope(match[3]) })
	}
	return out
}

export function parseIntegrationTokenPlaceholders(value: string) {
	return Array.from(value.matchAll(integrationTokenPlaceholderRegex), (m) => m[0])
}

export function parseProviderSecretPlaceholders(value: string) {
	return Array.from(value.matchAll(providerSecretPlaceholderRegex), (m) => m[0])
}

export function buildSecretPlaceholder(name: string, scope?: SecretScope | null) {
	return scope ? `{{secret:${name}|scope=${scope}}}` : `{{secret:${name}}}`
}

export function replaceSecretPlaceholders(value: string, replacements: ReadonlyMap<string, string>) {
	let next = value
	for (const [placeholder, secretValue] of replacements) {
		next = next.replaceAll(placeholder, secretValue)
	}
	return next
}

export function containsSecretPlaceholder(value: string) {
	return /\{\{(?:secret(?:\/|:|-basic:)|integration-token:)/.test(value)
}

/** Every placeholder the value references, grouped by kind. */
export function collectPlaceholders(value: string) {
	return {
		secrets: parseSecretPlaceholders(value),
		basic: parseBasicAuthSecretPlaceholders(value),
		integrationTokens: parseIntegrationTokenPlaceholders(value),
		providerSecrets: parseProviderSecretPlaceholders(value),
	}
}
