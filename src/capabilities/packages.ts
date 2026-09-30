import { executeRun } from '../execute/engine.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import {
	describePackageSource,
	fetchPackageSource,
	packageSourceHostsFromEnv,
	parsePackageSource,
	previewPackageSource,
} from '../packages/install.ts'
import type { PackageFiles } from '../packages/manifest.ts'
import { parsePackageManifest } from '../packages/manifest.ts'
import type { SavedPackage } from '../cells/user-cell.ts'
import { communitySourcePrefix, renamePackageFiles } from './community.ts'
import { defineCapability, defineDomain, type CapabilityContext } from './define.ts'

export const packagesDomain = defineDomain({
	name: 'packages',
	description:
		'Saved packages: a package.json-rooted set of ES modules with exports, package-owned durable storage (packageStorage()), package-scoped secrets, and package-owned jobs (package.json#kody.jobs). Import a saved export with `import x from "kody:@scope/name/export"` or run it via packageRun.',
	guide: `A package is a record of files keyed by relative path. package.json needs "name" and "exports" (export name -> module path); README.md and AGENTS.md must be non-empty. Each export module has a default export function that receives params. Inside package code, import { packageStorage } from 'kody:runtime' for a per-package SQLite-backed key/value + sql store.`,
})

export const packageSave = defineCapability<{ files: PackageFiles; source?: string }>({
	domain: 'packages',
	name: 'packageSave',
	description:
		'Save (create or replace) a package from an in-memory file map. Validates the manifest, exports, README/AGENTS, and kody.jobs schedules, then reconciles package-owned jobs.',
	tags: ['packages', 'write'],
	keywords: ['save package', 'publish', 'install package', 'create package', 'upload package'],
	inputSchema: {
		type: 'object',
		properties: {
			files: {
				type: 'object',
				description: 'Relative path -> file contents. Must include package.json, README.md, AGENTS.md.',
			},
			source: { type: 'string', description: 'Where the files came from (e.g. "local", "npm:name@1.0.0").' },
		},
		required: ['files'],
	},
	example: `import { kody } from 'kody:runtime'
export default async function main({ files }) {
  return await kody.packageSave({ files })
}`,
	async handler(args, ctx) {
		if (ctx.fromRuntime && ctx.packageName) {
			throw new KodyError('forbidden', 'Package code may not save packages.', { status: 403 })
		}
		const saved = await ctx.userCell.packageSave({ files: args.files, source: args.source })
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'package.save',
			target: saved.name,
			details: { version: saved.version, source: saved.source, jobs: Object.keys(saved.manifest.jobs) },
		})
		return saved
	},
})

export const packageList = defineCapability<Record<string, never>>({
	domain: 'packages',
	name: 'packageList',
	description: 'List saved packages with their exports and jobs.',
	tags: ['packages', 'read'],
	keywords: ['list packages', 'installed packages', 'what packages'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		const packages = await ctx.userCell.packageList()
		return {
			packages: packages.map((p) => ({
				name: p.name,
				version: p.version,
				description: p.manifest.description,
				exports: Object.keys(p.manifest.exports),
				jobs: Object.keys(p.manifest.jobs),
				webhooks: p.manifest.webhooks.map((w) => w.name),
				subscriptions: p.manifest.subscriptions.map((s) => s.topic),
				hidden: p.manifest.hidden,
				source: p.source,
				updatedAt: p.updatedAt,
			})),
		}
	},
})

export const packageGet = defineCapability<{ name: string; includeFiles?: boolean }>({
	domain: 'packages',
	name: 'packageGet',
	description: 'Get one saved package: manifest, README, AGENTS, and optionally every file.',
	tags: ['packages', 'read'],
	keywords: ['package details', 'package readme', 'package source', 'show package'],
	inputSchema: {
		type: 'object',
		properties: { name: { type: 'string' }, includeFiles: { type: 'boolean' } },
		required: ['name'],
	},
	readOnly: true,
	async handler(args, ctx) {
		const pkg = await ctx.userCell.packageGet(args.name)
		if (!pkg) throw new KodyError('package_not_found', `Package "${args.name}" is not saved.`, { status: 404 })
		return {
			name: pkg.name,
			version: pkg.version,
			manifest: pkg.manifest,
			readme: pkg.files['README.md'] ?? '',
			agents: pkg.files['AGENTS.md'] ?? '',
			source: pkg.source,
			createdAt: pkg.createdAt,
			updatedAt: pkg.updatedAt,
			...(args.includeFiles ? { files: pkg.files } : { fileList: Object.keys(pkg.files) }),
		}
	},
})

export const packageDelete = defineCapability<{ name: string }>({
	domain: 'packages',
	name: 'packageDelete',
	description:
		'Delete a saved package, its jobs, and its package-scoped secrets. Package storage is kept until packageStorageClear is called.',
	tags: ['packages', 'write'],
	keywords: ['remove package', 'uninstall'],
	inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
	async handler(args, ctx) {
		if (ctx.fromRuntime && ctx.packageName) {
			throw new KodyError('forbidden', 'Package code may not delete packages.', { status: 403 })
		}
		const result = await ctx.userCell.packageDelete(args.name)
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'package.delete',
			target: args.name,
			details: null,
		})
		return result
	},
})

export const packageRun = defineCapability<{
	name: string
	export?: string
	params?: Record<string, unknown>
	idempotencyKey?: string
}>({
	domain: 'packages',
	name: 'packageRun',
	description:
		'Run a saved package export in its own isolate with package provenance (packageStorage() and package-scoped secrets work). Returns { ok, result, logs, error }.',
	tags: ['packages', 'execute'],
	keywords: ['run package', 'call export', 'invoke package', 'package function'],
	inputSchema: {
		type: 'object',
		properties: {
			name: { type: 'string' },
			export: { type: 'string', description: 'Export name (default ".").' },
			params: { type: 'object' },
			idempotencyKey: { type: 'string' },
		},
		required: ['name'],
	},
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.packageRun({ name: '@kody/counter', export: 'increment', params: { by: 2 } })
}`,
	async handler(args, ctx) {
		if (ctx.fromRuntime) {
			throw new KodyError(
				'forbidden',
				'packageRun is not available from inside a run; import the export with kody:<package>/<export> instead.',
				{ status: 403 },
			)
		}
		return executeRun(ctx.env, ctx.exports, {
			kind: 'package',
			user: ctx.user,
			entry: { kind: 'package', packageName: args.name, exportName: args.export ?? '.' },
			params: args.params ?? {},
			idempotencyKey: args.idempotencyKey,
		})
	},
})

export const packageInstall = defineCapability<{ source: string; subdir?: string; as?: string }>({
	domain: 'packages',
	name: 'packageInstall',
	description:
		'Install (or update) a package from a remote source: github:owner/repo[/subdir][#ref], a github.com URL, a public kody.codes/@owner/leaf[.git] listing (read-only smart-HTTP clone), a .tar.gz/.tgz URL, or a JSON file-map URL. Pass "as" to fork under a new package.json name. The server downloads it (hosts limited by KODY_PACKAGE_SOURCE_HOSTS) and saves it like packageSave. Secrets are never transferred.',
	tags: ['packages', 'write'],
	keywords: [
		'install from github',
		'install from url',
		'install from kody.codes',
		'add package from repo',
		'download package',
		'update package',
		'fork package',
	],
	inputSchema: {
		type: 'object',
		properties: {
			source: {
				type: 'string',
				description:
					'github:owner/repo[/sub/dir][#ref], https://github.com/owner/repo[/tree/ref/sub/dir], https://kody.codes/@owner/leaf[.git], kody:@owner/leaf[#ref], or an http(s) URL to a tarball / JSON file map.',
			},
			subdir: {
				type: 'string',
				description: 'Directory inside the archive/repo holding package.json (overrides the one in source).',
			},
			as: {
				type: 'string',
				description: 'New package.json name for a fork (e.g. @me/hello). Secrets are still not transferred.',
			},
		},
		required: ['source'],
	},
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  await kody.packagePreview({ source: 'https://kody.codes/@kody/cloudflare' })
  return await kody.packageInstall({ source: 'https://kody.codes/@kody/cloudflare.git', as: '@me/cloudflare' })
}`,
	async handler(args, ctx) {
		if (ctx.fromRuntime && ctx.packageName) {
			throw new KodyError('forbidden', 'Package code may not install packages.', { status: 403 })
		}
		if (typeof args.source !== 'string') throw new KodyError('invalid_args', '"source" is required.')
		const source = parsePackageSource(args.source, typeof args.subdir === 'string' ? args.subdir : undefined)
		const fetched = await fetchPackageSource(source, { allowedHosts: packageSourceHostsFromEnv(ctx.env) })
		const fork = typeof args.as === 'string' && args.as.trim() !== '' ? args.as.trim() : null
		let files = fetched.files
		let savedSource = fetched.source
		if (fork) {
			const manifestName = parsePackageManifest(fetched.files).name
			if (fork !== manifestName) {
				files = renamePackageFiles(fetched.files, fork)
				parsePackageManifest(files)
				savedSource = `${fetched.source} (fork)`
			}
		}
		const saved = await ctx.userCell.packageSave({ files, source: savedSource })
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'package.install',
			target: saved.name,
			details: {
				version: saved.version,
				source: savedSource,
				fetchedFrom: fetched.fetchedFrom,
				commit: fetched.commit ?? null,
				fork: fork !== null && savedSource.endsWith('(fork)'),
			},
		})
		return {
			...saved,
			fetchedFrom: fetched.fetchedFrom,
			commit: fetched.commit ?? null,
			files: Object.keys(files).length,
			warnings: fetched.warnings,
			fork: savedSource.endsWith('(fork)'),
		}
	},
})

export const packagePreview = defineCapability<{ source: string; subdir?: string }>({
	domain: 'packages',
	name: 'packagePreview',
	description:
		'Fetch a remote package source without saving it: returns manifest, README, AGENTS, file list, declared permissions (jobs/webhooks/subscriptions/secretProvider/dependencies), provenance, and commit SHA for git clones. Use packageInstall to save or fork afterward. Does not transfer secrets.',
	tags: ['packages', 'read'],
	keywords: [
		'preview package',
		'inspect package source',
		'kody.codes package',
		'package readme before install',
		'dry run install',
	],
	inputSchema: {
		type: 'object',
		properties: {
			source: {
				type: 'string',
				description:
					'Same source grammar as packageInstall (github:, kody.codes/@owner/leaf[.git], tarball, JSON map).',
			},
			subdir: { type: 'string' },
		},
		required: ['source'],
	},
	readOnly: true,
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.packagePreview({ source: 'https://kody.codes/@kody/cloudflare' })
}`,
	async handler(args, ctx) {
		if (typeof args.source !== 'string') throw new KodyError('invalid_args', '"source" is required.')
		const source = parsePackageSource(args.source, typeof args.subdir === 'string' ? args.subdir : undefined)
		const preview = await previewPackageSource(source, { allowedHosts: packageSourceHostsFromEnv(ctx.env) })
		return {
			source: preview.source,
			fetchedFrom: preview.fetchedFrom,
			commit: preview.commit,
			name: preview.name,
			version: preview.version,
			description: preview.description,
			readme: preview.readme,
			agents: preview.agents,
			fileList: preview.fileList,
			fileCount: preview.fileCount,
			permissions: preview.permissions,
			manifest: preview.manifest,
			warnings: preview.warnings,
		}
	},
})

async function updateFromCommunity(pkg: SavedPackage, ctx: CapabilityContext) {
	const match = /^community:(.+)@[^@\s]+$/.exec(pkg.source)
	if (!match) {
		throw new KodyError(
			'package_not_updatable',
			`Package "${pkg.name}" is a fork ("${pkg.source}"); update it by hand.`,
		)
	}
	const listingName = match[1]!
	const listing = await ctx.env.REGISTRY.getByName('registry').communityGet(listingName)
	if (!listing) {
		throw new KodyError('community_not_found', `"${listingName}" is no longer in the community catalog.`, {
			status: 404,
		})
	}
	if (listing.name !== pkg.name) {
		throw new KodyError(
			'package_not_updatable',
			`Listing "${listingName}" names the package "${listing.name}", not "${pkg.name}".`,
		)
	}
	const saved = await ctx.userCell.packageSave({
		files: listing.files,
		source: `${communitySourcePrefix}${listing.name}@${listing.version}`,
	})
	await recordAudit(ctx.env, {
		actor: `user:${ctx.user.id}`,
		action: 'package.update',
		target: saved.name,
		details: { version: saved.version, previousVersion: pkg.version, source: saved.source },
	})
	return { ...saved, previousVersion: pkg.version, fetchedFrom: `community:${listing.name}`, warnings: [] }
}

export const packageUpdate = defineCapability<{ name: string }>({
	domain: 'packages',
	name: 'packageUpdate',
	description:
		'Re-install a saved package from where it came from: a github:/kody.codes/URL source or a community listing. Fails for packages saved from an in-memory file map or forks.',
	tags: ['packages', 'write'],
	keywords: ['update package', 'upgrade package', 'reinstall', 'pull latest'],
	inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
	async handler(args, ctx) {
		if (ctx.fromRuntime && ctx.packageName) {
			throw new KodyError('forbidden', 'Package code may not update packages.', { status: 403 })
		}
		const pkg = await ctx.userCell.packageGet(args.name)
		if (!pkg) throw new KodyError('package_not_found', `Package "${args.name}" is not saved.`, { status: 404 })
		if (pkg.source.startsWith(communitySourcePrefix)) return await updateFromCommunity(pkg, ctx)
		let source
		try {
			source = parsePackageSource(pkg.source)
		} catch {
			throw new KodyError(
				'package_not_updatable',
				`Package "${args.name}" was saved from "${pkg.source}", not a remote source. Use packageInstall with a source.`,
			)
		}
		const fetched = await fetchPackageSource(source, { allowedHosts: packageSourceHostsFromEnv(ctx.env) })
		const saved = await ctx.userCell.packageSave({ files: fetched.files, source: fetched.source })
		if (saved.name !== pkg.name) {
			throw new KodyError(
				'invalid_package',
				`"${describePackageSource(source)}" now names the package "${saved.name}" (was "${pkg.name}"); both are saved.`,
			)
		}
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'package.update',
			target: saved.name,
			details: { version: saved.version, previousVersion: pkg.version, source: fetched.source },
		})
		return { ...saved, previousVersion: pkg.version, fetchedFrom: fetched.fetchedFrom, warnings: fetched.warnings }
	},
})

export const packageCapabilities = [
	packageSave,
	packagePreview,
	packageInstall,
	packageUpdate,
	packageList,
	packageGet,
	packageDelete,
	packageRun,
]
