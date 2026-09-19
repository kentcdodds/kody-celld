import { WorkerEntrypoint } from 'cloudflare:workers'
import type { GatewayEvent, UserCell } from '../cells/user-cell.ts'
import type { Env } from '../env.ts'
import { executeRun } from '../execute/engine.ts'
import type { RuntimeProps } from '../execute/runtime-host.ts'
import { integrationEventPayload, type IntegrationRecord } from '../integrations/store.ts'
import { dispatchTopic } from '../packages/subscriptions.ts'
import { isCredentialTransportAllowed, isHostApproved, parseInsecureHostAllowance, requestHost } from './host-policy.ts'
import {
	collectPlaceholders,
	containsSecretPlaceholder,
	decodeSecretPlaceholderDelimiters,
	replaceSecretPlaceholders,
	type ReferencedProviderSecret,
	type SecretScope,
} from './placeholders.ts'
import { normalizeProviderHosts } from './provider-store.ts'

const RUN_HEADER = 'x-kody-run'
const MAX_INSPECTED_BODY_BYTES = 2 * 1024 * 1024

const textLikeContentType =
	/^(?:text\/|application\/(?:json|x-www-form-urlencoded|xml|graphql|javascript|x-ndjson)|multipart\/form-data)/i

export type GatewaySend = { url: string; method?: string; headers?: Record<string, string>; body?: string | null }
export type GatewayReply = { status: number; ok: boolean; headers: Record<string, string>; body: string }

/**
 * `globalOutbound` for every sandbox isolate. Every `fetch()` from user or
 * package code passes through here:
 *  - requests without placeholders are forwarded untouched
 *  - requests with `{{secret:...}}` placeholders are resolved only when the
 *    destination host was approved by an account admin, over https (or a
 *    configured loopback host), and the referenced secrets exist for this
 *    user/package; otherwise the request never leaves and a 403 explains how
 *    to get approval
 *  - requests to this deployment's own /admin surface are blocked so sandbox
 *    code can never reach the approval boundary
 */
export class FetchGateway extends WorkerEntrypoint<Env, RuntimeProps> {
	/**
	 * Same pipeline as `fetch()` for host-side callers (capabilities) over RPC,
	 * where `fetch` is a reserved name and Request/Response do not serialize.
	 */
	async send(input: GatewaySend): Promise<GatewayReply> {
		const init: RequestInit = { method: input.method ?? 'GET', headers: input.headers ?? {} }
		if (input.body != null && init.method !== 'GET' && init.method !== 'HEAD') init.body = input.body
		const response = await this.fetch(new Request(input.url, init))
		const headers: Record<string, string> = {}
		for (const [name, value] of response.headers) headers[name] = value
		return { status: response.status, ok: response.ok, headers, body: await response.text() }
	}

	override async fetch(request: Request): Promise<Response> {
		const runId = request.headers.get(RUN_HEADER)
		const headers = new Headers(request.headers)
		headers.delete(RUN_HEADER)
		const url = new URL(request.url)
		const host = requestHost(url)
		const record = (event: Omit<GatewayEvent, 'at' | 'method' | 'url' | 'host'>) => {
			if (!runId) return
			this.ctx.waitUntil(
				this.env.USER.getByName(this.ctx.props.userId).runRecordGatewayEvent({
					runId,
					event: {
						at: new Date().toISOString(),
						method: request.method,
						url: redactUrl(url),
						host,
						...event,
					},
				}),
			)
		}

		if (this.isOwnAdminSurface(url)) {
			record({ outcome: 'denied', status: 403, secrets: [], reason: 'admin_surface_blocked' })
			return deny(403, 'admin_surface_blocked', 'Sandbox code cannot call the Kody admin API.', {})
		}

		const urlText = decodeSecretPlaceholderDelimiters(url.toString())
		let headerText = ''
		for (const [name, value] of headers) headerText += `${name}: ${value}\n`
		let bodyText: string | null = null
		let bodyBytes: ArrayBuffer | null = null
		if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
			bodyBytes = await request.arrayBuffer()
			const contentType = headers.get('content-type') ?? ''
			if (bodyBytes.byteLength <= MAX_INSPECTED_BODY_BYTES && (!contentType || textLikeContentType.test(contentType))) {
				bodyText = new TextDecoder().decode(bodyBytes)
			}
		}

		const hasPlaceholders =
			containsSecretPlaceholder(urlText) ||
			containsSecretPlaceholder(headerText) ||
			(bodyText !== null && containsSecretPlaceholder(bodyText))

		if (!hasPlaceholders) {
			const response = await forward(request, url, headers, bodyBytes)
			record({ outcome: 'forwarded', status: response.status, secrets: [] })
			return response
		}

		const combined = `${urlText}\n${headerText}\n${bodyText ?? ''}`
		const placeholders = collectPlaceholders(combined)
		const secretNames = new Set<string>()
		for (const s of placeholders.secrets) secretNames.add(s.name)
		for (const b of placeholders.basic) {
			secretNames.add(b.username)
			secretNames.add(b.password)
		}
		const integrationNames = [...new Set(placeholders.integrationTokens.map((t) => t.name))]
		const providerRefs = dedupeProviderRefs(placeholders.providerSecrets)
		// Run history names what was injected, never the values.
		const secrets = [
			...secretNames,
			...integrationNames.map((name) => `integration-token:${name}`),
			...providerRefs.map((p) => `secret/${p.provider}:${p.ref}`),
		]

		const allowInsecure = parseInsecureHostAllowance(this.env.KODY_ALLOW_INSECURE_SECRET_HOSTS)
		if (!isCredentialTransportAllowed(url, allowInsecure)) {
			record({ outcome: 'denied', status: 403, secrets, reason: 'insecure_scheme' })
			return deny(
				403,
				'secret_requires_https',
				`Secrets are only injected over https. Request to ${url.protocol}//${host} was blocked.`,
				{ host },
			)
		}

		const userCell = this.env.USER.getByName(this.ctx.props.userId)
		const packageName = this.ctx.props.packageName
		const approvedHosts = (await userCell.secretHostList()).map((h) => h.host)
		const hostApproved = isHostApproved(host, approvedHosts)
		const replacements = new Map<string, string>()

		// --- {{secret:name}} / {{secret-basic:...}}: admin-approved hosts only.
		if (secretNames.size > 0) {
			if (!hostApproved) {
				const approvalUrl = `${this.env.KODY_PUBLIC_URL}/admin/users/${this.ctx.props.userId}/secret-hosts`
				record({ outcome: 'denied', status: 403, secrets, reason: 'secret_host_not_approved' })
				return deny(
					403,
					'secret_host_not_approved',
					`Host "${host}" is not approved for secret injection. Stop retrying; ask an account admin to approve it (POST ${approvalUrl} {"host":"${host}"}) and retry only after approval.`,
					{ host, secrets: [...secretNames], approvalUrl },
				)
			}
			const refs: Array<{ name: string; scope: SecretScope | null }> = [
				...placeholders.secrets.map((s) => ({ name: s.name, scope: s.scope })),
				...placeholders.basic.flatMap((b) => [
					{ name: b.username, scope: b.scope },
					{ name: b.password, scope: b.scope },
				]),
			]
			const resolved = await userCell.secretResolveValues({ names: refs, packageName })
			if (resolved.missing.length > 0) {
				record({ outcome: 'denied', status: 404, secrets, reason: 'secret_not_found' })
				return deny(
					404,
					'secret_not_found',
					`Unknown secret(s): ${resolved.missing.join(', ')}. Save them with secretSave first.`,
					{ host, missing: resolved.missing },
				)
			}
			for (const s of placeholders.secrets) replacements.set(s.placeholder, resolved.values[s.name] ?? '')
			for (const b of placeholders.basic) {
				const credentials = `${resolved.values[b.username] ?? ''}:${resolved.values[b.password] ?? ''}`
				const header = `Basic ${btoa(credentials)}`
				// Callers may write either the bare placeholder or `Basic {{...}}`;
				// both become a single well-formed header value.
				for (const scheme of ['Basic ', 'basic ', 'BASIC ', '']) replacements.set(`${scheme}${b.placeholder}`, header)
			}
		}

		// --- {{integration-token:name}}: the connection's own allowedHosts govern.
		const injectIntegrations = async (forceRefresh: boolean) => {
			for (const name of integrationNames) {
				const outcome = await userCell.integrationTokenResolve({ name, packageName, host, forceRefresh })
				if (!outcome.ok) {
					if (outcome.record && forceRefresh)
						this.notifyAuth('integration.auth.failed', outcome.record, outcome.message)
					return outcome
				}
				if (outcome.refreshed) this.notifyAuth('integration.auth.succeeded', outcome.record, null)
				for (const t of placeholders.integrationTokens) {
					if (t.name === name) replacements.set(t.placeholder, outcome.token)
				}
			}
			return null
		}
		if (integrationNames.length > 0) {
			const denied = await injectIntegrations(false)
			if (denied) {
				record({ outcome: 'denied', status: denied.status, secrets, reason: denied.code })
				return deny(denied.status, denied.code, denied.message, {
					host,
					integration: denied.record ? { name: denied.record.name, status: denied.record.status } : null,
				})
			}
		}

		// --- {{secret/provider:ref}}: resolved by the bound provider package in a sealed run.
		if (providerRefs.length > 0) {
			const denied = await this.injectProviderSecrets({
				userCell,
				providerRefs,
				placeholders: placeholders.providerSecrets,
				host,
				hostApproved,
				replacements,
			})
			if (denied) {
				record({ outcome: 'denied', status: denied.status, secrets, reason: denied.code })
				return deny(denied.status, denied.code, denied.message, { host, ...denied.details })
			}
		}

		const inject = () => {
			const injectedUrl = new URL(replaceSecretPlaceholders(urlText, replacements))
			const injectedHeaders = new Headers()
			for (const [name, value] of headers) injectedHeaders.set(name, replaceSecretPlaceholders(value, replacements))
			let injectedBody: BodyInit | null = bodyBytes
			if (bodyText !== null) injectedBody = replaceSecretPlaceholders(bodyText, replacements)
			return forward(request, injectedUrl, injectedHeaders, injectedBody)
		}

		try {
			let response = await inject()
			// A 401 with an integration token usually means the provider revoked or
			// expired it early: refresh once host-side and replay the request.
			if (response.status === 401 && integrationNames.length > 0) {
				const denied = await injectIntegrations(true)
				if (!denied) {
					await response.body?.cancel()
					response = await inject()
					record({ outcome: 'injected', status: response.status, secrets, reason: 'integration_refreshed' })
					return response
				}
			}
			record({ outcome: 'injected', status: response.status, secrets })
			return response
		} catch (error) {
			record({
				outcome: 'error',
				status: null,
				secrets,
				reason: error instanceof Error ? error.message : String(error),
			})
			throw error
		}
	}

	private notifyAuth(
		topic: 'integration.auth.succeeded' | 'integration.auth.failed',
		record: IntegrationRecord,
		reason: string | null,
	) {
		this.ctx.waitUntil(
			dispatchTopic(this.env, this.ctx.exports, { id: this.ctx.props.userId, email: this.ctx.props.email }, topic, {
				integration: integrationEventPayload(record),
				source: 'refresh',
				...(reason ? { reason } : {}),
			}),
		)
	}

	/**
	 * Provider-backed secrets: for each `{{secret/<provider>:<ref>}}` the bound
	 * provider package runs sealed (no persisted result/logs) and returns
	 * `{ value, hosts, canonicalRef }`. The value is injected only when the
	 * destination host is one of the item's hosts or an admin-approved secret
	 * host, and the caller holds a grant when the binding is locked.
	 */
	private async injectProviderSecrets(input: {
		userCell: DurableObjectStub<UserCell>
		providerRefs: Array<{ provider: string; ref: string }>
		placeholders: Array<ReferencedProviderSecret>
		host: string
		hostApproved: boolean
		replacements: Map<string, string>
	}): Promise<{ status: number; code: string; message: string; details: Record<string, unknown> } | null> {
		const { userCell, host } = input
		const packageName = this.ctx.props.packageName
		const bindings = await userCell.secretProviderList()
		if (packageName !== null && bindings.some((b) => b.packageName === packageName)) {
			return {
				status: 403,
				code: 'secret_provider_recursion',
				message: `Package "${packageName}" is a bound secret provider and may not use {{secret/...}} placeholders itself; use {{secret:name}} for its door secret.`,
				details: {},
			}
		}
		const cacheTtlMs = providerCacheTtlMs(this.env)
		for (const { provider, ref } of input.providerRefs) {
			const auth = await userCell.secretProviderAuthorize({ providerId: provider, ref, packageName })
			if (!auth.ok) return { status: auth.status, code: auth.code, message: auth.message, details: { provider, ref } }
			let resolved = auth.cached
			if (!resolved) {
				const pkg = await userCell.packageGet(auth.binding.packageName)
				if (!pkg?.manifest.secretProvider) {
					return {
						status: 404,
						code: 'secret_provider_package_missing',
						message: `Provider "${provider}" is bound to package "${auth.binding.packageName}", which no longer declares kody.secretProvider.`,
						details: { provider },
					}
				}
				const run = await executeRun(this.env, this.ctx.exports, {
					kind: 'secret-provider',
					user: { id: this.ctx.props.userId, email: this.ctx.props.email },
					entry: {
						kind: 'package',
						packageName: auth.binding.packageName,
						entryPath: pkg.manifest.secretProvider.entry,
					},
					params: {
						providerId: provider,
						ref,
						config: auth.binding.config,
						doorSecretName: auth.binding.doorSecretName,
					},
					trigger: `secret-provider:${provider}`,
					sealed: true,
					timeoutMs: providerTimeoutMs(this.env),
				})
				if (!run.ok) {
					return {
						status: 502,
						code: 'secret_provider_failed',
						message: `Provider "${provider}" could not resolve ref "${ref}": ${run.error?.name ?? 'error'}: ${run.error?.message ?? 'unknown error'}`,
						details: { provider, ref, runId: run.runId },
					}
				}
				const parsed = parseProviderResult(run.result)
				if (!parsed) {
					return {
						status: 502,
						code: 'secret_provider_invalid_result',
						message: `Provider "${provider}" returned something other than { value: string, hosts?: string[], canonicalRef?: string } for ref "${ref}".`,
						details: { provider, ref, runId: run.runId },
					}
				}
				resolved = { ...parsed, canonicalRef: parsed.canonicalRef ?? ref, expiresAt: 0 }
				// Cached before the grant re-check so the alias -> canonical mapping is known next time.
				await userCell.secretProviderCachePut({
					providerId: provider,
					ref,
					entry: { value: resolved.value, hosts: resolved.hosts, canonicalRef: resolved.canonicalRef },
					ttlMs: cacheTtlMs,
				})
				if (auth.provisional || resolved.canonicalRef !== ref) {
					// Grants are held on canonical refs: re-check now that the provider told us which item this is.
					const recheck = await userCell.secretProviderAuthorize({
						providerId: provider,
						ref: resolved.canonicalRef,
						packageName,
						strict: true,
					})
					if (!recheck.ok)
						return { status: recheck.status, code: recheck.code, message: recheck.message, details: { provider, ref } }
				}
			}
			if (!isHostApproved(host, resolved.hosts) && !input.hostApproved) {
				return {
					status: 403,
					code: 'secret_provider_host_not_allowed',
					message: `Host "${host}" is not among the hosts of ${provider} item "${ref}" (${resolved.hosts.length ? resolved.hosts.join(', ') : 'none listed'}) and is not an admin-approved secret host.`,
					details: { provider, ref, itemHosts: resolved.hosts },
				}
			}
			for (const p of input.placeholders) {
				if (p.provider === provider && p.ref === ref) input.replacements.set(p.placeholder, resolved.value)
			}
		}
		return null
	}

	private isOwnAdminSurface(url: URL) {
		let publicUrl: URL
		try {
			publicUrl = new URL(this.env.KODY_PUBLIC_URL)
		} catch {
			return false
		}
		const sameHost = url.hostname.toLowerCase() === publicUrl.hostname.toLowerCase()
		return sameHost && (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
	}
}

async function forward(original: Request, url: URL, headers: Headers, body: BodyInit | null) {
	const init: RequestInit = {
		method: original.method,
		headers,
		redirect: original.redirect,
	}
	if (body !== null && original.method !== 'GET' && original.method !== 'HEAD') init.body = body
	return fetch(url, init)
}

function deny(status: number, code: string, message: string, details: Record<string, unknown>) {
	return Response.json({ error: code, message, ...details }, { status, headers: { 'x-kody-gateway': code } })
}

function dedupeProviderRefs(list: Array<ReferencedProviderSecret>) {
	const seen = new Set<string>()
	const out: Array<{ provider: string; ref: string }> = []
	for (const p of list) {
		const key = `${p.provider}\u0000${p.ref}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({ provider: p.provider, ref: p.ref })
	}
	return out
}

function parseProviderResult(
	result: unknown,
): { value: string; hosts: Array<string>; canonicalRef: string | null } | null {
	if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
	const record = result as Record<string, unknown>
	if (typeof record.value !== 'string') return null
	const canonicalRef =
		typeof record.canonicalRef === 'string' && record.canonicalRef.trim() && !/[\s{}]/.test(record.canonicalRef)
			? record.canonicalRef.trim()
			: null
	return { value: record.value, hosts: normalizeProviderHosts(record.hosts), canonicalRef }
}

function positiveInt(raw: string | undefined, fallback: number) {
	const value = Number(raw)
	return raw !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback
}

function providerCacheTtlMs(env: Env) {
	return positiveInt(env.KODY_SECRET_PROVIDER_CACHE_SECONDS, 300) * 1000
}

function providerTimeoutMs(env: Env) {
	return Math.max(1000, positiveInt(env.KODY_SECRET_PROVIDER_TIMEOUT_MS, 20_000))
}

function redactUrl(url: URL) {
	const copy = new URL(url.toString())
	for (const [key] of copy.searchParams) copy.searchParams.set(key, '…')
	return `${copy.origin}${copy.pathname}${copy.search ? '?…' : ''}`
}
