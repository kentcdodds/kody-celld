import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { secretProviderIdPattern } from '../packages/manifest.ts'
import { buildProviderSecretPlaceholder } from '../secrets/placeholders.ts'
import { parseProviderConfig, validateProviderRef } from '../secrets/provider-store.ts'
import { defineCapability, defineDomain, type CapabilityContext } from './define.ts'

export const secretProvidersDomain = defineDomain({
	name: 'secret-providers',
	description:
		'Provider-backed secrets: reference items that live in an external vault (1Password Connect, Vault, Bitwarden, your own service) with {{secret/<provider>:<ref>}} placeholders. A saved package that declares kody.secretProvider fetches the value in a sealed run when the gateway needs it; the value is injected into the outbound request only, never stored, logged, or returned.',
	guide: `1. Save a provider package (package.json "kody": { "secretProvider": { "id": "1password" } } plus an "./secretProvider" export).
2. secretSave the vault credential (the "door" secret), then secretProviderBind({ providerId, packageName, doorSecretName, config }).
3. Use {{secret/1password:vaults/<vault>/items/<item>/fields/credential}} in a fetch to one of the item's hosts (or an admin-approved secret host).
Lock a binding to require explicit per-package grants (secretProviderGrant).`,
})

function guardManagement(ctx: CapabilityContext) {
	if (ctx.packageName !== null) {
		throw new KodyError(
			'forbidden_from_package',
			'Secret provider bindings and grants can only be changed from the MCP session or ad hoc execute, not from package code.',
			{ status: 403 },
		)
	}
}

function parseProviderId(raw: string) {
	const providerId = raw.trim().toLowerCase()
	if (!secretProviderIdPattern.test(providerId)) {
		throw new KodyError('invalid_args', 'providerId must be 1-64 chars: lowercase letters, digits, ".", "_", "-".')
	}
	return providerId
}

export const secretProviderBind = defineCapability<{
	providerId: string
	packageName: string
	doorSecretName: string
	config?: Record<string, unknown>
	locked?: boolean
}>({
	domain: 'secret-providers',
	name: 'secretProviderBind',
	description:
		'Bind a provider id to a saved package that declares kody.secretProvider with that id. doorSecretName is the user-scoped secret the package uses to reach the vault (the package references it as {{secret:<doorSecretName>}}); config holds non-secret settings such as the vault base URL.',
	tags: ['secret-providers', 'write'],
	keywords: ['1password', 'vault', 'bitwarden', 'secret provider', 'bind provider', 'external secrets'],
	inputSchema: {
		type: 'object',
		properties: {
			providerId: { type: 'string', description: 'Provider id used in {{secret/<providerId>:...}}.' },
			packageName: { type: 'string', description: 'Saved package declaring kody.secretProvider.id === providerId.' },
			doorSecretName: { type: 'string', description: 'User-scoped secret name holding the vault credential.' },
			config: {
				type: 'object',
				description:
					'Non-secret string settings passed to the provider (e.g. { baseUrl: "https://connect.example.com" }).',
			},
			locked: {
				type: 'boolean',
				description: 'When true only packages with a secretProviderGrant may resolve refs. Default false.',
			},
		},
		required: ['providerId', 'packageName', 'doorSecretName'],
	},
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  await kody.secretSave({ name: 'op-connect-token', value: '<token>' })
  return await kody.secretProviderBind({
    providerId: '1password', packageName: 'onepassword-connect',
    doorSecretName: 'op-connect-token', config: { baseUrl: 'https://connect.example.com' },
  })
}`,
	async handler(args, ctx) {
		guardManagement(ctx)
		const providerId = parseProviderId(args.providerId)
		const binding = await ctx.userCell.secretProviderBind({
			providerId,
			packageName: args.packageName,
			doorSecretName: args.doorSecretName,
			config: parseProviderConfig(args.config),
			locked: args.locked,
		})
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'secret_provider.bind',
			target: providerId,
			details: { packageName: binding.packageName, doorSecretName: binding.doorSecretName, locked: binding.locked },
		})
		return { ...binding, placeholderExample: buildProviderSecretPlaceholder(providerId, '<ref>') }
	},
})

export const secretProviderList = defineCapability<Record<string, never>>({
	domain: 'secret-providers',
	name: 'secretProviderList',
	description:
		'List provider bindings (package, door secret name, config, lock state) and their per-package grants. Never returns values.',
	tags: ['secret-providers', 'read'],
	keywords: ['list providers', 'which vault', 'provider grants'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		const bindings = await ctx.userCell.secretProviderList()
		return {
			providers: bindings.map((b) => ({
				...b,
				placeholderExample: buildProviderSecretPlaceholder(b.providerId, '<ref>'),
			})),
		}
	},
})

export const secretProviderGrant = defineCapability<{ providerId: string; ref: string; packageName: string }>({
	domain: 'secret-providers',
	name: 'secretProviderGrant',
	description:
		'Allow a package to resolve one provider ref (needed when the binding is locked). Grants use the canonical ref the provider reports.',
	tags: ['secret-providers', 'write', 'grants'],
	keywords: ['grant secret', 'allow package', 'provider ref'],
	inputSchema: {
		type: 'object',
		properties: { providerId: { type: 'string' }, ref: { type: 'string' }, packageName: { type: 'string' } },
		required: ['providerId', 'ref', 'packageName'],
	},
	async handler(args, ctx) {
		guardManagement(ctx)
		const providerId = parseProviderId(args.providerId)
		const grant = await ctx.userCell.secretProviderGrant({
			providerId,
			canonicalRef: validateProviderRef(args.ref),
			packageName: args.packageName,
		})
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'secret_provider.grant',
			target: providerId,
			details: { ref: grant.canonicalRef, packageName: grant.packageName },
		})
		return { ...grant, placeholder: buildProviderSecretPlaceholder(providerId, grant.canonicalRef) }
	},
})

export const secretProviderRevoke = defineCapability<{ providerId: string; ref: string; packageName: string }>({
	domain: 'secret-providers',
	name: 'secretProviderRevoke',
	description: 'Remove a package grant for a provider ref. Cached values for that provider are dropped immediately.',
	tags: ['secret-providers', 'write', 'grants'],
	keywords: ['revoke grant', 'remove access', 'provider ref'],
	inputSchema: {
		type: 'object',
		properties: { providerId: { type: 'string' }, ref: { type: 'string' }, packageName: { type: 'string' } },
		required: ['providerId', 'ref', 'packageName'],
	},
	async handler(args, ctx) {
		guardManagement(ctx)
		const providerId = parseProviderId(args.providerId)
		const result = await ctx.userCell.secretProviderRevoke({
			providerId,
			canonicalRef: validateProviderRef(args.ref),
			packageName: args.packageName,
		})
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'secret_provider.revoke',
			target: providerId,
			details: { ref: args.ref, packageName: args.packageName, ...result },
		})
		return { providerId, ref: args.ref, packageName: args.packageName, ...result }
	},
})

export const secretProviderLock = defineCapability<{ providerId: string; locked: boolean }>({
	domain: 'secret-providers',
	name: 'secretProviderLock',
	description:
		'Lock (grants required, ad hoc code denied) or unlock (any caller, host allowlist still applies) a provider binding.',
	tags: ['secret-providers', 'write', 'grants'],
	keywords: ['lock provider', 'unlock provider', 'require grants'],
	inputSchema: {
		type: 'object',
		properties: { providerId: { type: 'string' }, locked: { type: 'boolean' } },
		required: ['providerId', 'locked'],
	},
	async handler(args, ctx) {
		guardManagement(ctx)
		const providerId = parseProviderId(args.providerId)
		const binding = await ctx.userCell.secretProviderSetLocked({ providerId, locked: args.locked })
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'secret_provider.lock',
			target: providerId,
			details: { locked: binding.locked },
		})
		return binding
	},
})

export const secretProviderUnbind = defineCapability<{ providerId: string }>({
	domain: 'secret-providers',
	name: 'secretProviderUnbind',
	description: 'Remove a provider binding and all of its grants. The door secret stays saved.',
	tags: ['secret-providers', 'write', 'delete'],
	keywords: ['unbind provider', 'remove provider'],
	inputSchema: { type: 'object', properties: { providerId: { type: 'string' } }, required: ['providerId'] },
	async handler(args, ctx) {
		guardManagement(ctx)
		const providerId = parseProviderId(args.providerId)
		const result = await ctx.userCell.secretProviderUnbind(providerId)
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'secret_provider.unbind',
			target: providerId,
			details: { deleted: result.deleted },
		})
		return { providerId, deleted: result.deleted }
	},
})

export const secretProviderCapabilities = [
	secretProviderBind,
	secretProviderList,
	secretProviderGrant,
	secretProviderRevoke,
	secretProviderLock,
	secretProviderUnbind,
]
