import { connectUrl, oauthRedirectUri } from '../integrations/connect.ts'
import { parseIntegrationConfig, parseIntegrationUsage } from '../integrations/oauth.ts'
import type { ConnectRecord, IntegrationRecord } from '../integrations/store.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { defineCapability, defineDomain, type CapabilityContext } from './define.ts'

export const integrationsDomain = defineDomain({
	name: 'integrations',
	description:
		'OAuth connections to third-party APIs (GitHub, Google, Slack, any OAuth 2 provider). You bring your own OAuth app; Kody holds the access/refresh tokens encrypted and injects them only at the network boundary via {{integration-token:<name>}} (or createAuthenticatedFetch from kody:runtime) for the hosts the connection allows. Token values are never returned.',
	guide: `1. integrationSave with your OAuth app's clientId/clientSecret, authorizeUrl/tokenUrl, scopes and allowedHosts — register the returned redirectUri on the provider.
2. integrationConnect returns a one-time link; the user opens it, reviews the hosts, and authorizes at the provider.
3. Call the API with fetch(url, { headers: { authorization: 'Bearer {{integration-token:<name>}}' } }) or createAuthenticatedFetch('<name>'). Kody refreshes expired tokens host-side and retries once on 401.
Client-credentials flows skip step 2: integrationTokenRefresh mints the first token.`,
})

function guardManagement(ctx: CapabilityContext) {
	if (ctx.packageName !== null) {
		throw new KodyError(
			'forbidden_from_package',
			'Integration settings can only be changed from the MCP session or ad hoc execute, not from package code.',
			{ status: 403 },
		)
	}
}

function present(record: IntegrationRecord, ctx: CapabilityContext, connect?: ConnectRecord | null) {
	return {
		...record,
		redirectUri: oauthRedirectUri(ctx.baseUrl),
		...(connect === undefined ? {} : { latestConnect: connect }),
		usageNote: `Use ${record.placeholder} in an Authorization header (or createAuthenticatedFetch('${record.name}')) when calling ${record.allowedHosts.join(', ')}.`,
	}
}

const usageSchema = {
	type: 'object',
	description:
		'{ mode: "any" } (default) lets any code use the token; { mode: "packages", packages: ["name"] } restricts it.',
	properties: {
		mode: { type: 'string', enum: ['any', 'packages'] },
		packages: { type: 'array', items: { type: 'string' } },
	},
	required: ['mode'],
}

export const integrationSave = defineCapability<
	Record<string, unknown> & { name: string; clientSecret?: string | null }
>({
	domain: 'integrations',
	name: 'integrationSave',
	description:
		'Create or update an OAuth integration (BYO OAuth app). Stores clientSecret encrypted; returns metadata plus the redirectUri to register with the provider and the placeholder to use. Re-saving keeps existing tokens unless tokenUrl/clientId change.',
	tags: ['integrations', 'write', 'oauth'],
	keywords: [
		'oauth',
		'connect github',
		'connect google',
		'connect slack',
		'client id',
		'client secret',
		'access token',
		'integration',
	],
	inputSchema: {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'Connection name: letters, digits, ".", "_", "-" (e.g. "github").' },
			provider: { type: 'string', description: 'Human label for the provider (defaults to name).' },
			description: { type: 'string' },
			flow: {
				type: 'string',
				enum: ['authorization_code', 'client_credentials'],
				description: 'Default authorization_code (user consent). client_credentials for machine-to-machine apps.',
			},
			authorizeUrl: { type: 'string', description: 'Provider authorization endpoint (authorization_code only).' },
			tokenUrl: { type: 'string', description: 'Provider token endpoint (https).' },
			clientId: { type: 'string' },
			clientSecret: {
				type: ['string', 'null'],
				description: 'OAuth client secret. Omit to keep the stored one; null clears it (public PKCE clients).',
			},
			tokenAuthStyle: {
				type: 'string',
				enum: ['body', 'basic'],
				description: 'How client credentials are sent to tokenUrl. Default body.',
			},
			scopes: { type: 'array', items: { type: 'string' } },
			scopeSeparator: { type: 'string', enum: [' ', ','] },
			authorizeParams: {
				type: 'object',
				description: 'Extra static authorize query params (e.g. { access_type: "offline", prompt: "consent" }).',
			},
			allowedHosts: {
				type: 'array',
				items: { type: 'string' },
				description: 'API hosts the token may be sent to (e.g. ["api.github.com"]). Required.',
			},
			usage: usageSchema,
		},
		required: ['name', 'tokenUrl', 'clientId', 'allowedHosts'],
	},
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.integrationSave({
    name: 'github', provider: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    clientId: '<your client id>', clientSecret: '<your client secret>',
    scopes: ['repo', 'read:user'], allowedHosts: ['api.github.com'],
  })
}`,
	async handler(args, ctx) {
		guardManagement(ctx)
		const { clientSecret, ...raw } = args
		if (clientSecret !== undefined && clientSecret !== null && typeof clientSecret !== 'string') {
			throw new KodyError('invalid_args', 'clientSecret must be a string or null.')
		}
		const config = parseIntegrationConfig(raw)
		const record = await ctx.userCell.integrationSave({ config, clientSecret })
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'integration.save',
			target: record.name,
			details: { provider: record.provider, flow: record.flow, allowedHosts: record.allowedHosts, usage: record.usage },
		})
		return {
			...present(record, ctx),
			next:
				record.flow === 'authorization_code'
					? `Register the redirectUri on the provider's OAuth app, then call integrationConnect({ name: "${record.name}" }) and send the user the link.`
					: `Call integrationTokenRefresh({ name: "${record.name}" }) to mint the first access token.`,
		}
	},
})

export const integrationList = defineCapability<Record<string, never>>({
	domain: 'integrations',
	name: 'integrationList',
	description:
		'List OAuth integrations with status (pending, connected, auth_failed), expiry, allowed hosts and usage grants. Never returns token values.',
	tags: ['integrations', 'read'],
	keywords: ['list integrations', 'connected accounts', 'which oauth', 'integration status'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		const records = await ctx.userCell.integrationList()
		return { integrations: records.map((r) => present(r, ctx)), redirectUri: oauthRedirectUri(ctx.baseUrl) }
	},
})

export const integrationGet = defineCapability<{ name: string }>({
	domain: 'integrations',
	name: 'integrationGet',
	description:
		'Show one integration, including the latest connect attempt (poll this after sending the user a connect link).',
	tags: ['integrations', 'read'],
	keywords: ['integration status', 'did the user connect', 'connect attempt'],
	inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
	readOnly: true,
	async handler(args, ctx) {
		const record = await ctx.userCell.integrationGet(args.name)
		if (!record)
			throw new KodyError('integration_not_found', `Integration "${args.name}" was not found.`, { status: 404 })
		return present(record, ctx, await ctx.userCell.integrationConnectLatest(args.name))
	},
})

export const integrationConnect = defineCapability<{ name: string }>({
	domain: 'integrations',
	name: 'integrationConnect',
	description:
		'Mint a one-time connect link for an authorization_code integration. Send the url to the user: they review the allowed hosts, authorize at the provider, and Kody stores the tokens. Then poll integrationGet until status is "connected".',
	tags: ['integrations', 'write', 'oauth'],
	keywords: ['connect', 'authorize', 'oauth link', 'sign in with', 'reconnect'],
	inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  const { url } = await kody.integrationConnect({ name: 'github' })
  return 'Open this link to connect GitHub: ' + url
}`,
	async handler(args, ctx) {
		guardManagement(ctx)
		const ticket = await ctx.userCell.integrationConnectStart({
			name: args.name,
			redirectUri: oauthRedirectUri(ctx.baseUrl),
		})
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'integration.connect_start',
			target: args.name,
			details: null,
		})
		return {
			name: args.name,
			url: connectUrl(ctx.baseUrl, ctx.user.id, ticket.connectId, ticket.ticket),
			expiresAt: ticket.expiresAt,
			note: 'The link works once and expires in 15 minutes. The user must open it themselves; token material never appears in this session.',
		}
	},
})

export const integrationTokenRefresh = defineCapability<{ name: string }>({
	domain: 'integrations',
	name: 'integrationTokenRefresh',
	description:
		'Force a host-side token refresh now (or mint the first token for client_credentials integrations). Returns status/expiry only. Refresh also happens automatically when a token expires or a request returns 401.',
	tags: ['integrations', 'write', 'oauth'],
	keywords: ['refresh token', 'token expired', 'client credentials', 'mint token', '401'],
	inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
	async handler(args, ctx) {
		const outcome = await ctx.userCell.integrationRefresh(args.name)
		if (!outcome.ok) {
			throw new KodyError(outcome.code ?? 'integration_refresh_failed', outcome.message ?? 'Token refresh failed.', {
				status: outcome.code === 'integration_not_found' ? 404 : 502,
			})
		}
		return outcome.record ? present(outcome.record, ctx) : { name: args.name, refreshed: true }
	},
})

export const integrationSetUsage = defineCapability<{
	name: string
	usage: { mode: 'any' | 'packages'; packages?: Array<string> }
}>({
	domain: 'integrations',
	name: 'integrationSetUsage',
	description: 'Restrict which code may use an integration token: any code, or only the listed packages.',
	tags: ['integrations', 'write', 'grants'],
	keywords: ['grant integration', 'restrict token', 'which packages can use', 'usage'],
	inputSchema: {
		type: 'object',
		properties: { name: { type: 'string' }, usage: usageSchema },
		required: ['name', 'usage'],
	},
	async handler(args, ctx) {
		guardManagement(ctx)
		const usage = parseIntegrationUsage(args.usage)
		const record = await ctx.userCell.integrationSetUsage({ name: args.name, usage })
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'integration.usage',
			target: args.name,
			details: { usage },
		})
		return present(record, ctx)
	},
})

export const integrationDisconnect = defineCapability<{ name: string }>({
	domain: 'integrations',
	name: 'integrationDisconnect',
	description:
		'Drop the stored access/refresh tokens but keep the OAuth app configuration (status returns to pending).',
	tags: ['integrations', 'write'],
	keywords: ['disconnect', 'revoke tokens', 'sign out of integration'],
	inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
	async handler(args, ctx) {
		guardManagement(ctx)
		const record = await ctx.userCell.integrationDisconnect(args.name)
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'integration.disconnect',
			target: args.name,
			details: null,
		})
		return present(record, ctx)
	},
})

export const integrationDelete = defineCapability<{ name: string }>({
	domain: 'integrations',
	name: 'integrationDelete',
	description: 'Delete an integration and its encrypted tokens and client secret.',
	tags: ['integrations', 'write', 'delete'],
	keywords: ['delete integration', 'remove oauth'],
	inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
	async handler(args, ctx) {
		guardManagement(ctx)
		const result = await ctx.userCell.integrationDelete(args.name)
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'integration.delete',
			target: args.name,
			details: { deleted: result.deleted },
		})
		return { name: args.name, deleted: result.deleted }
	},
})

export const integrationCapabilities = [
	integrationSave,
	integrationList,
	integrationGet,
	integrationConnect,
	integrationTokenRefresh,
	integrationSetUsage,
	integrationDisconnect,
	integrationDelete,
]
