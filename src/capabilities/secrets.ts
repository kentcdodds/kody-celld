import { buildSecretPlaceholder, type SecretScope } from '../secrets/placeholders.ts'
import { defineCapability, defineDomain } from './define.ts'

export const secretsDomain = defineDomain({
	name: 'secrets',
	description:
		'Save and reference user secrets. Values never come back through MCP; use {{secret:name}} placeholders in fetch requests and Kody injects them at the network boundary for approved hosts only.',
})

const scopeSchema = {
	type: 'string',
	enum: ['user', 'package'],
	description: 'user (default) or package. Package-scoped secrets are visible only to that package.',
}

export const secretSave = defineCapability<{
	name: string
	value: string
	description?: string
	scope?: SecretScope
	packageName?: string
}>({
	domain: 'secrets',
	name: 'secretSave',
	description:
		'Save or rotate a secret by name. Returns metadata and the placeholder to use in requests. Saving a secret does not approve any host: an account admin must approve destination hosts separately.',
	tags: ['secrets', 'write'],
	keywords: ['api key', 'token', 'credential', 'password', 'store secret', 'placeholder'],
	inputSchema: {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'Secret name: letters, digits, ".", "_", "-".' },
			value: { type: 'string', description: 'Secret value. Never echoed back.' },
			description: { type: 'string' },
			scope: scopeSchema,
			packageName: { type: 'string', description: 'Required when scope is "package".' },
		},
		required: ['name', 'value'],
	},
	example: `import { kody } from 'kody:runtime'
export default async function main({ name, value }) {
  return await kody.secretSave({ name, value })
}`,
	async handler(args, ctx) {
		const saved = await ctx.userCell.secretSave({
			name: args.name,
			value: args.value,
			description: args.description,
			scope: args.scope,
			packageName: args.packageName ?? (args.scope === 'package' ? (ctx.packageName ?? undefined) : undefined),
		})
		return { ...saved, placeholder: buildSecretPlaceholder(saved.name, saved.scope === 'user' ? null : saved.scope) }
	},
})

export const secretList = defineCapability<Record<string, never>>({
	domain: 'secrets',
	name: 'secretList',
	description: 'List saved secret names and metadata (never values) plus approved destination hosts.',
	tags: ['secrets', 'read'],
	keywords: ['list secrets', 'which secrets', 'approved hosts'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		const [secrets, hosts] = await Promise.all([ctx.userCell.secretList(), ctx.userCell.secretHostList()])
		return {
			secrets: secrets.map((s) => ({
				...s,
				placeholder: buildSecretPlaceholder(s.name, s.scope === 'user' ? null : s.scope),
			})),
			approvedHosts: hosts,
			approvalNote: `Hosts are approved by an account admin at ${ctx.baseUrl}/admin/users/${ctx.user.id}/secret-hosts, never through MCP or package code.`,
		}
	},
})

export const secretDelete = defineCapability<{ name: string; scope?: SecretScope; packageName?: string }>({
	domain: 'secrets',
	name: 'secretDelete',
	description: 'Delete a saved secret by name.',
	tags: ['secrets', 'write'],
	keywords: ['remove secret', 'delete credential'],
	inputSchema: {
		type: 'object',
		properties: { name: { type: 'string' }, scope: scopeSchema, packageName: { type: 'string' } },
		required: ['name'],
	},
	async handler(args, ctx) {
		return ctx.userCell.secretDelete({
			name: args.name,
			scope: args.scope,
			packageName: args.packageName ?? ctx.packageName ?? undefined,
		})
	},
})

export const secretHostList = defineCapability<Record<string, never>>({
	domain: 'secrets',
	name: 'secretHostList',
	description:
		'List destination hosts an account admin approved for secret injection. Read-only: approvals change only through the admin API.',
	tags: ['secrets', 'read', 'hosts'],
	keywords: ['allowed hosts', 'approved hosts', 'host approval', 'secret_host_not_approved'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		return {
			hosts: await ctx.userCell.secretHostList(),
			approvalUrl: `${ctx.baseUrl}/admin/users/${ctx.user.id}/secret-hosts`,
		}
	},
})

export const secretCapabilities = [secretSave, secretList, secretDelete, secretHostList]
