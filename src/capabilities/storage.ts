import { packageStorageCellName } from '../cells/package-storage-cell.ts'
import { KodyError } from '../lib/errors.ts'
import { defineCapability, defineDomain } from './define.ts'

export const storageDomain = defineDomain({
	name: 'storage',
	description:
		'Inspect package-owned durable storage from outside package code. Inside package code use `import { packageStorage } from "kody:runtime"` instead; these capabilities are for debugging and cleanup.',
})

function requireOutsideRuntime(ctx: { fromRuntime: boolean; packageName: string | null }, packageName: string) {
	if (ctx.fromRuntime && ctx.packageName !== null && ctx.packageName !== packageName) {
		throw new KodyError('forbidden', 'Package code may only inspect its own storage (use packageStorage()).', {
			status: 403,
		})
	}
}

export const packageStorageInspect = defineCapability<{ packageName: string; prefix?: string; limit?: number }>({
	domain: 'storage',
	name: 'packageStorageInspect',
	description: 'List key/value entries and stats of a package’s durable storage cell.',
	tags: ['storage', 'read', 'packages'],
	keywords: ['package storage', 'durable storage', 'inspect state', 'kv entries', 'sqlite'],
	inputSchema: {
		type: 'object',
		properties: { packageName: { type: 'string' }, prefix: { type: 'string' }, limit: { type: 'integer' } },
		required: ['packageName'],
	},
	readOnly: true,
	async handler(args, ctx) {
		requireOutsideRuntime(ctx, args.packageName)
		const cell = ctx.env.PACKAGE_STORAGE.getByName(packageStorageCellName(ctx.user.id, args.packageName))
		const [page, stats] = await Promise.all([cell.list({ prefix: args.prefix, limit: args.limit }), cell.stats()])
		return {
			packageName: args.packageName,
			items: page.items.map((item) => ({
				key: item.key,
				value: JSON.parse(item.valueJson) as unknown,
				updatedAt: item.updatedAt,
			})),
			cursor: page.cursor,
			stats,
		}
	},
})

export const packageStorageClear = defineCapability<{ packageName: string }>({
	domain: 'storage',
	name: 'packageStorageClear',
	description: 'Delete every key and every package-created table in a package’s storage cell.',
	tags: ['storage', 'write', 'destructive'],
	keywords: ['clear storage', 'reset package state', 'wipe'],
	inputSchema: { type: 'object', properties: { packageName: { type: 'string' } }, required: ['packageName'] },
	async handler(args, ctx) {
		requireOutsideRuntime(ctx, args.packageName)
		await ctx.env.PACKAGE_STORAGE.getByName(packageStorageCellName(ctx.user.id, args.packageName)).clear()
		return { cleared: true }
	},
})

export const storageCapabilities = [packageStorageInspect, packageStorageClear]
