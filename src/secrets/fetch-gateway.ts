import { WorkerEntrypoint } from 'cloudflare:workers'
import type { GatewayEvent } from '../cells/user-cell.ts'
import type { Env } from '../env.ts'
import type { RuntimeProps } from '../execute/runtime-host.ts'
import { isHostApproved, isLoopbackHost, requestHost } from './host-policy.ts'
import {
	collectPlaceholders,
	containsSecretPlaceholder,
	decodeSecretPlaceholderDelimiters,
	replaceSecretPlaceholders,
	type SecretScope,
} from './placeholders.ts'

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
		const secrets = [...secretNames]

		if (placeholders.integrationTokens.length > 0 || placeholders.providerSecrets.length > 0) {
			record({ outcome: 'denied', status: 403, secrets, reason: 'placeholder_kind_unsupported' })
			return deny(
				403,
				'placeholder_kind_unsupported',
				'{{integration-token:...}} and {{secret/provider:...}} placeholders are deferred in kody-celld v1. Use {{secret:name}} or {{secret-basic:...}}.',
				{ host },
			)
		}

		const allowInsecure = (this.env.KODY_ALLOW_INSECURE_SECRET_HOSTS ?? '')
			.split(',')
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean)
		if (
			url.protocol !== 'https:' &&
			!(allowInsecure.includes(host) || (allowInsecure.includes('loopback') && isLoopbackHost(host)))
		) {
			record({ outcome: 'denied', status: 403, secrets, reason: 'insecure_scheme' })
			return deny(
				403,
				'secret_requires_https',
				`Secrets are only injected over https. Request to ${url.protocol}//${host} was blocked.`,
				{ host },
			)
		}

		const userCell = this.env.USER.getByName(this.ctx.props.userId)
		const approvedHosts = (await userCell.secretHostList()).map((h) => h.host)
		if (!isHostApproved(host, approvedHosts)) {
			const approvalUrl = `${this.env.KODY_PUBLIC_URL}/admin/users/${this.ctx.props.userId}/secret-hosts`
			record({ outcome: 'denied', status: 403, secrets, reason: 'secret_host_not_approved' })
			return deny(
				403,
				'secret_host_not_approved',
				`Host "${host}" is not approved for secret injection. Stop retrying; ask an account admin to approve it (POST ${approvalUrl} {"host":"${host}"}) and retry only after approval.`,
				{ host, secrets, approvalUrl },
			)
		}

		const refs: Array<{ name: string; scope: SecretScope | null }> = [
			...placeholders.secrets.map((s) => ({ name: s.name, scope: s.scope })),
			...placeholders.basic.flatMap((b) => [
				{ name: b.username, scope: b.scope },
				{ name: b.password, scope: b.scope },
			]),
		]
		const resolved = await userCell.secretResolveValues({ names: refs, packageName: this.ctx.props.packageName })
		if (resolved.missing.length > 0) {
			record({ outcome: 'denied', status: 404, secrets, reason: 'secret_not_found' })
			return deny(
				404,
				'secret_not_found',
				`Unknown secret(s): ${resolved.missing.join(', ')}. Save them with secretSave first.`,
				{
					host,
					missing: resolved.missing,
				},
			)
		}

		const replacements = new Map<string, string>()
		for (const s of placeholders.secrets) replacements.set(s.placeholder, resolved.values[s.name] ?? '')
		for (const b of placeholders.basic) {
			const credentials = `${resolved.values[b.username] ?? ''}:${resolved.values[b.password] ?? ''}`
			const header = `Basic ${btoa(credentials)}`
			// Callers may write either the bare placeholder or `Basic {{...}}`;
			// both become a single well-formed header value.
			for (const scheme of ['Basic ', 'basic ', 'BASIC ', '']) replacements.set(`${scheme}${b.placeholder}`, header)
		}

		const injectedUrl = new URL(replaceSecretPlaceholders(urlText, replacements))
		const injectedHeaders = new Headers()
		for (const [name, value] of headers) injectedHeaders.set(name, replaceSecretPlaceholders(value, replacements))
		let injectedBody: BodyInit | null = bodyBytes
		if (bodyText !== null) injectedBody = replaceSecretPlaceholders(bodyText, replacements)

		try {
			const response = await forward(request, injectedUrl, injectedHeaders, injectedBody)
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

function redactUrl(url: URL) {
	const copy = new URL(url.toString())
	for (const [key] of copy.searchParams) copy.searchParams.set(key, '…')
	return `${copy.origin}${copy.pathname}${copy.search ? '?…' : ''}`
}
