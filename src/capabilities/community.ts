import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { publisherPattern, type CommunityListing } from '../packages/community-store.ts'
import { parsePackageManifest, type PackageFiles } from '../packages/manifest.ts'
import { defineCapability, defineDomain, type CapabilityContext } from './define.ts'

export const communityDomain = defineDomain({
	name: 'community',
	description:
		'The community catalog of this Kody install: packages other users published. Search it, read a listing, install a copy into your own packages, or publish your own.',
	guide: `Publishing copies your saved package's files into the fleet-wide catalog under its package.json name (first publisher
owns the name; republish to update). Installing copies the listing into your packages (source "community:<name>@<version>");
pass "as" to fork it under a new name. Listings are public at <baseUrl>/community. Package-scoped secrets, storage and jobs
are never part of a listing — only files.`,
})

export const communitySourcePrefix = 'community:'

function registryOf(ctx: CapabilityContext) {
	return ctx.env.REGISTRY.getByName('registry')
}

function notFromPackage(ctx: CapabilityContext, verb: string) {
	if (ctx.fromRuntime && ctx.packageName) {
		throw new KodyError('forbidden', `Package code may not ${verb} community packages.`, { status: 403 })
	}
}

function summary(listing: CommunityListing) {
	return {
		name: listing.name,
		version: listing.version,
		description: listing.description,
		publisher: listing.publisher,
		keywords: listing.keywords,
		exports: Object.keys(listing.manifest.exports),
		jobs: Object.keys(listing.manifest.jobs),
		installs: listing.installs,
		fileCount: listing.fileCount,
		publishedAt: listing.publishedAt,
		updatedAt: listing.updatedAt,
	}
}

export function defaultPublisher(email: string) {
	const local =
		email
			.split('@')[0]
			?.toLowerCase()
			.replaceAll(/[^a-z0-9._-]/g, '-') ?? 'user'
	const trimmed = local.replace(/^[^a-z0-9]+/, '').slice(0, 40)
	return publisherPattern.test(trimmed) ? trimmed : 'user'
}

/** Rewrites package.json#name so an installed copy can live beside the original. */
export function renamePackageFiles(files: PackageFiles, name: string): PackageFiles {
	const manifestText = files['package.json']
	if (manifestText === undefined) throw new KodyError('invalid_package', 'Listing has no package.json.')
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestText)
	} catch {
		throw new KodyError('invalid_package', 'Listing package.json is not valid JSON.')
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new KodyError('invalid_package', 'Listing package.json must be an object.')
	}
	const renamed = { ...(parsed as Record<string, unknown>), name }
	return { ...files, 'package.json': JSON.stringify(renamed, null, 2) }
}

export const communitySearch = defineCapability<{ query?: string; limit?: number }>({
	domain: 'community',
	name: 'communitySearch',
	description:
		'Search the community catalog by name, description or keywords (ranked by installs). Empty query lists the most installed packages.',
	tags: ['community', 'packages', 'read'],
	keywords: ['find packages', 'browse packages', 'community packages', 'discover', 'catalog', 'registry'],
	inputSchema: {
		type: 'object',
		properties: { query: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 50 } },
	},
	readOnly: true,
	async handler(args, ctx) {
		const listings = await registryOf(ctx).communitySearch({ query: args.query, limit: args.limit })
		return { packages: listings.map(summary) }
	},
})

export const communityGet = defineCapability<{ name: string; includeFiles?: boolean }>({
	domain: 'community',
	name: 'communityGet',
	description: 'Read one community listing: manifest, README, AGENTS, file list (or all files with includeFiles).',
	tags: ['community', 'packages', 'read'],
	keywords: ['community package details', 'listing readme', 'inspect community package'],
	inputSchema: {
		type: 'object',
		properties: { name: { type: 'string' }, includeFiles: { type: 'boolean' } },
		required: ['name'],
	},
	readOnly: true,
	async handler(args, ctx) {
		const pkg = await registryOf(ctx).communityGet(args.name)
		if (!pkg)
			throw new KodyError('community_not_found', `"${args.name}" is not in the community catalog.`, { status: 404 })
		return {
			...summary(pkg),
			manifest: pkg.manifest,
			readme: pkg.readme,
			agents: pkg.agents,
			...(args.includeFiles ? { files: pkg.files } : { fileList: Object.keys(pkg.files) }),
		}
	},
})

export const communityPublish = defineCapability<{ name: string; publisher?: string }>({
	domain: 'community',
	name: 'communityPublish',
	description:
		'Publish (or republish) one of your saved packages to the community catalog under its package.json name. Optional publisher handle (defaults to the local part of your email).',
	tags: ['community', 'packages', 'write'],
	keywords: ['publish package', 'share package', 'make package public', 'release'],
	inputSchema: {
		type: 'object',
		properties: {
			name: { type: 'string' },
			publisher: { type: 'string', description: 'Public handle shown on the listing (a-z, 0-9, . _ -).' },
		},
		required: ['name'],
	},
	async handler(args, ctx) {
		notFromPackage(ctx, 'publish')
		const pkg = await ctx.userCell.packageGet(args.name)
		if (!pkg) throw new KodyError('package_not_found', `Package "${args.name}" is not saved.`, { status: 404 })
		const listing = await registryOf(ctx).communityPublish({
			userId: ctx.user.id,
			publisher:
				typeof args.publisher === 'string' && args.publisher ? args.publisher : defaultPublisher(ctx.user.email),
			name: pkg.name,
			version: pkg.version,
			manifest: pkg.manifest,
			files: pkg.files,
		})
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'community.publish',
			target: listing.name,
			details: { version: listing.version, publisher: listing.publisher },
		})
		return { ...summary(listing), url: `${ctx.env.KODY_PUBLIC_URL}/community/${encodeURIComponent(listing.name)}` }
	},
})

export const communityUnpublish = defineCapability<{ name: string }>({
	domain: 'community',
	name: 'communityUnpublish',
	description:
		'Remove one of your listings from the community catalog. Copies other users already installed stay with them.',
	tags: ['community', 'packages', 'write'],
	keywords: ['unpublish', 'remove listing', 'take down package'],
	inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
	async handler(args, ctx) {
		notFromPackage(ctx, 'unpublish')
		const removed = await registryOf(ctx).communityUnpublish({ userId: ctx.user.id, name: args.name })
		if (removed) {
			await recordAudit(ctx.env, {
				actor: `user:${ctx.user.id}`,
				action: 'community.unpublish',
				target: args.name,
				details: null,
			})
		}
		return { name: args.name, unpublished: removed }
	},
})

export const communityInstall = defineCapability<{ name: string; as?: string }>({
	domain: 'community',
	name: 'communityInstall',
	description:
		'Install a community package into your saved packages (a copy; source "community:<name>@<version>"). Pass "as" to fork it under a different package name.',
	tags: ['community', 'packages', 'write'],
	keywords: ['install community package', 'fork package', 'copy package', 'add from catalog'],
	inputSchema: {
		type: 'object',
		properties: {
			name: { type: 'string' },
			as: { type: 'string', description: 'New package.json name for a fork (e.g. @me/hello).' },
		},
		required: ['name'],
	},
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  const found = await kody.communitySearch({ query: 'weather' })
  return await kody.communityInstall({ name: found.packages[0].name })
}`,
	async handler(args, ctx) {
		notFromPackage(ctx, 'install')
		const registry = registryOf(ctx)
		const pkg = await registry.communityGet(args.name)
		if (!pkg)
			throw new KodyError('community_not_found', `"${args.name}" is not in the community catalog.`, { status: 404 })
		const fork =
			typeof args.as === 'string' && args.as.trim() !== '' && args.as.trim() !== pkg.name ? args.as.trim() : null
		const files = fork ? renamePackageFiles(pkg.files, fork) : pkg.files
		if (fork) parsePackageManifest(files)
		const source = fork
			? `${communitySourcePrefix}${pkg.name}@${pkg.version} (fork)`
			: `${communitySourcePrefix}${pkg.name}@${pkg.version}`
		const saved = await ctx.userCell.packageSave({ files, source })
		await registry.communityRecordInstall(pkg.name)
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: 'community.install',
			target: saved.name,
			details: { from: pkg.name, version: pkg.version, fork: fork !== null },
		})
		return { ...saved, from: pkg.name, fork: fork !== null }
	},
})

export const communityCapabilities = [
	communitySearch,
	communityGet,
	communityPublish,
	communityUnpublish,
	communityInstall,
]
