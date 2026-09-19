import { executeRun } from '../execute/engine.ts'
import { KodyError } from '../lib/errors.ts'
import type { PackageFiles } from '../packages/manifest.ts'
import { defineCapability, defineDomain } from './define.ts'

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
		return ctx.userCell.packageSave({ files: args.files, source: args.source })
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
		return ctx.userCell.packageDelete(args.name)
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

export const packageCapabilities = [packageSave, packageList, packageGet, packageDelete, packageRun]
