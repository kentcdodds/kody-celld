import { KodyError } from '../lib/errors.ts'
import { defineCapability, defineDomain, type CapabilityContext } from './define.ts'

export const accountDomain = defineDomain({
	name: 'account',
	description:
		'Your sign-in surface: MCP clients connected through OAuth, long-lived API tokens, and browser sessions. Revoking here takes effect immediately.',
	guide: `Kody is an OAuth 2.1 authorization server for MCP clients: point a client at <baseUrl>/mcp and it discovers
<baseUrl>/.well-known/oauth-protected-resource, registers itself, and sends you to the consent page. One approval grants
the full assistant (there is no per-capability scope menu). Use mcpClientList / mcpClientRevoke to review or cut off a
client, apiTokenCreate for clients that cannot do OAuth, and sessionRevoke to sign out browsers. The web UI at
<baseUrl>/account offers the same controls.`,
})

function registryOf(ctx: CapabilityContext) {
	return ctx.env.REGISTRY.getByName('registry')
}

/** Credential management stays with the human's client; package code may read but never mint or revoke. */
function notFromRuntime(ctx: CapabilityContext, name: string) {
	if (ctx.fromRuntime) {
		throw new KodyError(
			'forbidden_in_runtime',
			`${name} is only available to a directly connected MCP client, not to package code.`,
			{
				status: 403,
			},
		)
	}
}

export const mcpClientList = defineCapability<Record<string, never>>({
	domain: 'account',
	name: 'mcpClientList',
	description:
		'List MCP clients (OAuth grants) connected to your account: client name, when approved, last use, live devices.',
	tags: ['account', 'read', 'oauth', 'mcp'],
	keywords: ['connected clients', 'oauth grants', 'mcp clients', 'authorized apps', 'claude', 'cursor'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.mcpClientList()
}`,
	async handler(_args, ctx) {
		return { clients: await registryOf(ctx).oauthGrantList(ctx.user.id) }
	},
})

export const mcpClientRevoke = defineCapability<{ grantId?: string; all?: boolean }>({
	domain: 'account',
	name: 'mcpClientRevoke',
	description:
		'Disconnect one MCP client (by grant id from mcpClientList) or every client. Their tokens stop working at once.',
	tags: ['account', 'write', 'oauth', 'mcp', 'revoke'],
	keywords: ['disconnect client', 'revoke oauth', 'remove app access', 'sign out mcp client'],
	inputSchema: {
		type: 'object',
		properties: {
			grantId: { type: 'string', description: 'Grant id to revoke.' },
			all: { type: 'boolean', description: 'Revoke every connected client (including the one making this call).' },
		},
	},
	async handler(args, ctx) {
		notFromRuntime(ctx, 'mcpClientRevoke')
		if (args.all) {
			await registryOf(ctx).oauthGrantRevokeAll(ctx.user.id)
			return { revoked: 'all' }
		}
		if (!args.grantId) throw new KodyError('invalid_args', 'Provide grantId or all: true.')
		await registryOf(ctx).oauthGrantRevoke(ctx.user.id, args.grantId)
		return { revoked: args.grantId }
	},
})

export const apiTokenList = defineCapability<Record<string, never>>({
	domain: 'account',
	name: 'apiTokenList',
	description: 'List your long-lived API tokens (label, short id, created, last used). Token values are never shown.',
	tags: ['account', 'read', 'token'],
	keywords: ['api tokens', 'bearer tokens', 'my tokens', 'kc_ token'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		return { tokens: await registryOf(ctx).tokenList(ctx.user.id) }
	},
})

export const apiTokenCreate = defineCapability<{ label: string }>({
	domain: 'account',
	name: 'apiTokenCreate',
	description:
		'Create a new API token for a script or an MCP client that cannot use OAuth. The value is returned once; store it as a secret, never in code.',
	tags: ['account', 'write', 'token'],
	keywords: ['new api token', 'create token', 'bearer token for script', 'ci token'],
	inputSchema: {
		type: 'object',
		properties: { label: { type: 'string', description: 'What the token is for, e.g. "ci" or "laptop".' } },
		required: ['label'],
	},
	async handler(args, ctx) {
		notFromRuntime(ctx, 'apiTokenCreate')
		const label = args.label.trim().slice(0, 80) || 'mcp'
		const token = await registryOf(ctx).issueToken(ctx.user.id, label)
		return { token, label, note: 'Shown once. Use as Authorization: Bearer <token>.' }
	},
})

export const apiTokenRevoke = defineCapability<{ tokenId: string }>({
	domain: 'account',
	name: 'apiTokenRevoke',
	description: 'Revoke one of your API tokens by its short id (from apiTokenList).',
	tags: ['account', 'write', 'token', 'revoke'],
	keywords: ['revoke token', 'delete api token', 'rotate token'],
	inputSchema: { type: 'object', properties: { tokenId: { type: 'string' } }, required: ['tokenId'] },
	async handler(args, ctx) {
		notFromRuntime(ctx, 'apiTokenRevoke')
		const revoked = await registryOf(ctx).tokenRevoke(ctx.user.id, args.tokenId)
		if (!revoked) throw new KodyError('token_not_found', `No API token "${args.tokenId}".`, { status: 404 })
		return { revoked: args.tokenId }
	},
})

export const sessionList = defineCapability<Record<string, never>>({
	domain: 'account',
	name: 'sessionList',
	description: 'List browser sessions signed in to the web UI (device, signed in, last seen, expires).',
	tags: ['account', 'read', 'session'],
	keywords: ['browser sessions', 'where am i signed in', 'devices'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		return { sessions: await registryOf(ctx).sessionList(ctx.user.id) }
	},
})

export const sessionRevoke = defineCapability<{ sessionId?: string; all?: boolean }>({
	domain: 'account',
	name: 'sessionRevoke',
	description: 'Sign a browser session out (by id from sessionList) or sign out every browser.',
	tags: ['account', 'write', 'session', 'revoke'],
	keywords: ['sign out browser', 'revoke session', 'log out everywhere'],
	inputSchema: {
		type: 'object',
		properties: { sessionId: { type: 'string' }, all: { type: 'boolean' } },
	},
	async handler(args, ctx) {
		notFromRuntime(ctx, 'sessionRevoke')
		if (!args.all && !args.sessionId) throw new KodyError('invalid_args', 'Provide sessionId or all: true.')
		const count = await registryOf(ctx).sessionRevoke(ctx.user.id, args.all ? null : (args.sessionId ?? null))
		return { revoked: count }
	},
})

export const accountCapabilities = [
	mcpClientList,
	mcpClientRevoke,
	apiTokenList,
	apiTokenCreate,
	apiTokenRevoke,
	sessionList,
	sessionRevoke,
]
