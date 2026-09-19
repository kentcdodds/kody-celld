import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import type { GatewaySend } from '../secrets/fetch-gateway.ts'
import { webhookUrl } from '../webhooks/urls.ts'
import { defineCapability, defineDomain, type CapabilityContext } from './define.ts'

export const webhooksDomain = defineDomain({
	name: 'webhooks',
	description:
		'Package-owned inbound webhooks. A package declares webhooks in package.json#kody.webhooks (name, export, responseMode ack|sync, inputMode params|request, optional HMAC-SHA256 verification + replay window). Mint an opaque URL per declaration, hand it to the provider, and each delivery runs the declared export with package provenance.',
	guide: `Flow: save the package → secretSave the HMAC secret named in verification.secretName (if declared) → webhookUrlMint({ packageName, webhookName }) → webhookUrlApply({ handle, target }) to register the URL with a provider API without ever seeing it, or read it once via the authenticated route GET <baseUrl>/api/webhooks/<handle>/url (never via execute). Deliveries answer 202 (ack) or the export's return value (sync); metadata lands in webhookDeliveryList. Capabilities never return the credential URL.`,
})

function requireDirect(ctx: CapabilityContext, what: string) {
	if (ctx.fromRuntime) {
		throw new KodyError(
			'forbidden_from_runtime',
			`${what} is only available from MCP execute or the API, not from package code.`,
			{
				status: 403,
			},
		)
	}
}

export const webhookList = defineCapability<{ packageName?: string }>({
	domain: 'webhooks',
	name: 'webhookList',
	description: 'List declared webhooks joined with their minted handle, enabled state, and delivery counters.',
	tags: ['webhooks', 'read'],
	keywords: ['webhooks', 'inbound webhook', 'list webhooks', 'webhook handle', 'webhook status'],
	inputSchema: { type: 'object', properties: { packageName: { type: 'string' } } },
	readOnly: true,
	async handler(args, ctx) {
		return { webhooks: await ctx.userCell.webhookList({ packageName: args.packageName }) }
	},
})

export const webhookUrlMint = defineCapability<{ packageName: string; webhookName: string }>({
	domain: 'webhooks',
	name: 'webhookUrlMint',
	description:
		'Mint (or return the existing) opaque webhook URL credential for a declared webhook. Returns the handle and a reveal route, never the URL itself.',
	tags: ['webhooks', 'write'],
	keywords: ['mint webhook url', 'create webhook', 'webhook credential', 'webhook handle'],
	inputSchema: {
		type: 'object',
		properties: { packageName: { type: 'string' }, webhookName: { type: 'string' } },
		required: ['packageName', 'webhookName'],
	},
	example: `const { handle, revealRoute } = await kody.webhooks.webhookUrlMint({ packageName: 'my-hooks', webhookName: 'github' })`,
	async handler(args, ctx) {
		requireDirect(ctx, 'webhookUrlMint')
		const webhook = await ctx.userCell.webhookMint(args)
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'webhook.mint',
			target: webhook.handle,
			details: { packageName: webhook.packageName, webhookName: webhook.webhookName },
		})
		return { ...webhook, ...revealHints(ctx, webhook.handle) }
	},
})

export const webhookUrlRotate = defineCapability<{ handle: string }>({
	domain: 'webhooks',
	name: 'webhookUrlRotate',
	description:
		'Replace the URL secret. The previous URL keeps working for 24h or until the first accepted delivery on the new one. Re-apply / re-paste the URL afterwards.',
	tags: ['webhooks', 'write'],
	keywords: ['rotate webhook', 'leaked webhook url', 'new webhook secret'],
	inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
	async handler(args, ctx) {
		requireDirect(ctx, 'webhookUrlRotate')
		const webhook = await ctx.userCell.webhookRotate(args.handle)
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'webhook.rotate',
			target: webhook.handle,
			details: null,
		})
		return { ...webhook, ...revealHints(ctx, webhook.handle) }
	},
})

export const webhookEnable = defineCapability<{ handle: string }>({
	domain: 'webhooks',
	name: 'webhookEnable',
	description: 'Re-enable ingress for a disabled webhook.',
	tags: ['webhooks', 'write'],
	keywords: ['enable webhook', 'resume webhook'],
	inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
	async handler(args, ctx) {
		return ctx.userCell.webhookSetEnabled({ handle: args.handle, enabled: true })
	},
})

export const webhookDisable = defineCapability<{ handle: string }>({
	domain: 'webhooks',
	name: 'webhookDisable',
	description: 'Disable ingress without deleting the mint; providers get 404 until re-enabled.',
	tags: ['webhooks', 'write'],
	keywords: ['disable webhook', 'pause webhook', 'stop webhook'],
	inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
	async handler(args, ctx) {
		return ctx.userCell.webhookSetEnabled({ handle: args.handle, enabled: false })
	},
})

export const webhookDelete = defineCapability<{ handle: string }>({
	domain: 'webhooks',
	name: 'webhookDelete',
	description:
		'Delete a mint and its delivery history. The declaration stays in the package; mint again to get a fresh URL.',
	tags: ['webhooks', 'write'],
	keywords: ['delete webhook', 'remove webhook url'],
	inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
	async handler(args, ctx) {
		requireDirect(ctx, 'webhookDelete')
		const result = await ctx.userCell.webhookDelete(args.handle)
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'webhook.delete',
			target: args.handle,
			details: null,
		})
		return result
	},
})

export const webhookDeliveryList = defineCapability<{ handle?: string; limit?: number }>({
	domain: 'webhooks',
	name: 'webhookDeliveryList',
	description:
		'Recent deliveries (metadata only — bodies are never stored): status, HTTP status answered, rejection reason, run id, idempotency key.',
	tags: ['webhooks', 'read'],
	keywords: ['webhook deliveries', 'webhook history', 'why was webhook rejected', 'webhook 401', 'webhook runs'],
	inputSchema: {
		type: 'object',
		properties: { handle: { type: 'string' }, limit: { type: 'integer', description: 'Default 20, max 200.' } },
	},
	readOnly: true,
	async handler(args, ctx) {
		return { deliveries: await ctx.userCell.webhookDeliveryList({ handle: args.handle, limit: args.limit }) }
	},
})

type ApplyTarget =
	| { type: 'github'; repo: string; events?: Array<string>; tokenSecret?: string; contentType?: 'json' | 'form' }
	| {
			type: 'http'
			url: string
			method?: string
			headers?: Record<string, string>
			body?: unknown
	  }

/**
 * Registers the credential URL with a provider *from the server side*: the
 * URL is decrypted here, substituted into the provider request, and the
 * request goes through the FetchGateway so `{{secret:...}}` placeholders for
 * the provider's API token resolve at the network boundary. Neither the
 * webhook URL nor the token is returned.
 */
export const webhookUrlApply = defineCapability<{ handle: string; target: ApplyTarget }>({
	domain: 'webhooks',
	name: 'webhookUrlApply',
	description:
		'Register a minted webhook URL with a provider without revealing it. Targets: { type: "github", repo: "owner/name", events?, tokenSecret? (default "githubToken", used as {{secret:<name>}}) } creates/updates a repository hook via api.github.com; { type: "http", url, method?, headers?, body? } sends any request where the string "{{webhookUrl}}" is replaced by the URL (headers/body may carry {{secret:...}} placeholders; the host must be admin-approved).',
	tags: ['webhooks', 'write', 'network'],
	keywords: ['apply webhook', 'register webhook with github', 'configure provider webhook', 'github repository hook'],
	inputSchema: {
		type: 'object',
		properties: {
			handle: { type: 'string' },
			target: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ['github', 'http'] },
					repo: { type: 'string' },
					events: { type: 'array', items: { type: 'string' } },
					tokenSecret: { type: 'string' },
					contentType: { type: 'string', enum: ['json', 'form'] },
					url: { type: 'string' },
					method: { type: 'string' },
					headers: { type: 'object', additionalProperties: { type: 'string' } },
					body: {},
				},
				required: ['type'],
			},
		},
		required: ['handle', 'target'],
	},
	example: `await kody.webhooks.webhookUrlApply({ handle, target: { type: 'github', repo: 'me/repo', events: ['push'] } })`,
	async handler(args, ctx) {
		requireDirect(ctx, 'webhookUrlApply')
		const webhook = await ctx.userCell.webhookGet(args.handle)
		if (!webhook) throw new KodyError('webhook_not_found', `Webhook "${args.handle}" was not found.`, { status: 404 })
		const revealed = await ctx.userCell.webhookReveal(args.handle)
		const url = webhookUrl(ctx.baseUrl, ctx.user.id, revealed.handle, revealed.secret)
		// Placeholders in the provider request resolve at the gateway with this
		// package's scope, so package-scoped HMAC secrets work too.
		const gateway = ctx.exports.FetchGateway({
			props: { userId: ctx.user.id, email: ctx.user.email, packageName: webhook.packageName },
		})
		let request: GatewaySend
		let summary: Record<string, unknown>
		if (args.target.type === 'github') {
			const repo = args.target.repo
			if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
				throw new KodyError('invalid_args', 'target.repo must be "owner/name".')
			}
			const tokenSecret = args.target.tokenSecret ?? 'githubToken'
			if (!/^[A-Za-z0-9_.-]+$/.test(tokenSecret))
				throw new KodyError('invalid_args', 'target.tokenSecret is not a valid secret name.')
			const events = args.target.events ?? ['push']
			const hooksUrl = `https://api.github.com/repos/${repo}/hooks`
			const headers = {
				accept: 'application/vnd.github+json',
				authorization: `Bearer {{secret:${tokenSecret}}}`,
				'content-type': 'application/json',
				'user-agent': 'kody-celld',
			}
			// Update in place when a hook already points at this handle (rotation), else create.
			const existingResponse = await gateway.send({ url: hooksUrl, headers })
			let existingId: number | null = null
			if (existingResponse.ok) {
				const hooks = JSON.parse(existingResponse.body) as Array<{ id: number; config?: { url?: string } }>
				const marker = `/webhooks/${ctx.user.id}/${revealed.handle}/`
				existingId =
					hooks.find((hook) => typeof hook.config?.url === 'string' && hook.config.url.includes(marker))?.id ?? null
			} else if (existingResponse.status === 403 || existingResponse.status === 401) {
				throw new KodyError(
					'provider_rejected',
					`GitHub answered ${existingResponse.status} listing hooks for ${repo}: ${existingResponse.body.slice(0, 300)}`,
					{ status: 502 },
				)
			}
			const config: Record<string, string> = {
				url,
				content_type: args.target.contentType ?? 'json',
				insecure_ssl: '0',
			}
			if (webhook.definition?.verification) {
				// GitHub signs with the same secret the package verifies; the gateway fills it in.
				config.secret = `{{secret:${webhook.definition.verification.secretName}}}`
			}
			request = {
				url: existingId === null ? hooksUrl : `${hooksUrl}/${existingId}`,
				method: existingId === null ? 'POST' : 'PATCH',
				headers,
				body: JSON.stringify({ name: 'web', active: true, events, config }),
			}
			summary = { provider: 'github', repo, events, updated: existingId !== null }
		} else if (args.target.type === 'http') {
			const target = args.target
			let parsed: URL
			try {
				parsed = new URL(String(target.url))
			} catch {
				throw new KodyError('invalid_args', 'target.url must be an absolute URL.')
			}
			if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
				throw new KodyError('invalid_args', 'target.url must be http(s).')
			}
			const substitute = (value: string) => value.split('{{webhookUrl}}').join(url)
			const headers: Record<string, string> = {}
			for (const [key, value] of Object.entries(target.headers ?? {}))
				headers[key.toLowerCase()] = substitute(String(value))
			let body: string | null = null
			if (target.body !== undefined) {
				body = substitute(typeof target.body === 'string' ? target.body : JSON.stringify(target.body))
				if (typeof target.body !== 'string' && !headers['content-type']) headers['content-type'] = 'application/json'
			}
			request = { url: substitute(parsed.toString()), method: target.method ?? 'POST', headers, body }
			summary = { provider: 'http', host: parsed.host, method: target.method ?? 'POST' }
		} else {
			throw new KodyError('invalid_args', 'target.type must be "github" or "http".')
		}
		const response = await gateway.send(request)
		const text = response.body
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'webhook.apply',
			target: args.handle,
			details: { ...summary, status: response.status },
		})
		if (!response.ok) {
			throw new KodyError(
				'provider_rejected',
				`Provider answered ${response.status}: ${redactUrl(text, url).slice(0, 500)}`,
				{
					status: 502,
					details: { ...summary, status: response.status },
				},
			)
		}
		return { applied: true, status: response.status, ...summary }
	},
})

function redactUrl(text: string, url: string) {
	return text.split(url).join('<webhook url>')
}

function revealHints(ctx: CapabilityContext, handle: string) {
	return {
		revealRoute: `GET ${ctx.baseUrl}/api/webhooks/${encodeURIComponent(handle)}/url (Authorization: Bearer <user token>)`,
		note: 'Capabilities never return the URL. Use webhookUrlApply to register it with a provider, or the reveal route once and paste it.',
	}
}

export const webhookCapabilities = [
	webhookList,
	webhookUrlMint,
	webhookUrlApply,
	webhookUrlRotate,
	webhookEnable,
	webhookDisable,
	webhookDelete,
	webhookDeliveryList,
]
