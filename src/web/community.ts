import { renderPage } from '#app/render.tsx'
import { type CommunityListingView } from '#universal/loader-data.ts'
import type { Env } from '../env.ts'
import type { CommunityListing } from '../packages/community-store.ts'
import { appSessionOf } from './http.ts'
import { readWebSession } from './session.ts'

/**
 * Public community catalog pages. No sign-in needed: listings are meant to be
 * browsed and linked. Only what CommunityStore exposes is rendered — never the
 * publisher's user id, email, secrets, storage or private packages.
 */

export function isCommunityRoute(pathname: string) {
	return pathname === '/community' || pathname.startsWith('/community/')
}

function listingView(listing: CommunityListing): CommunityListingView {
	return {
		name: listing.name,
		version: listing.version,
		description: listing.description || null,
		publisher: listing.publisher,
		installs: listing.installs,
		updatedAt: listing.updatedAt,
	}
}

export async function handleCommunity(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
	}
	const registry = env.REGISTRY.getByName('registry')
	const session = appSessionOf(await readWebSession(request, env))
	const name = decodeURIComponent(url.pathname.slice('/community/'.length))

	if (url.pathname === '/community' || url.pathname === '/community/') {
		const query = url.searchParams.get('q')?.trim() ?? ''
		const [listings, stats] = await Promise.all([
			registry.communitySearch({ query, limit: 50 }),
			registry.communityStats(),
		])
		return renderPage({
			title: 'Community packages',
			pathname: '/community',
			session,
			data: { page: 'community', query, stats, listings: listings.map(listingView) },
		})
	}

	const pkg = await registry.communityGet(name)
	if (!pkg) {
		return renderPage({
			title: 'Not found',
			pathname: url.pathname,
			session,
			status: 404,
			data: { page: 'communityNotFound', name },
		})
	}
	return renderPage({
		title: pkg.name,
		pathname: url.pathname,
		session,
		data: {
			page: 'communityDetail',
			publicUrl: env.KODY_PUBLIC_URL,
			pkg: {
				...listingView(pkg),
				publishedAt: pkg.publishedAt,
				fileCount: pkg.fileCount,
				keywords: pkg.keywords,
				exports: Object.entries(pkg.manifest.exports).map(([exportName, path]) => ({
					specifier: `kody:${pkg.name}${exportName === '.' ? '' : `/${exportName}`}`,
					path,
				})),
				jobs: Object.entries(pkg.manifest.jobs).map(([jobName, job]) => ({
					name: jobName,
					entry: job.entry,
					schedule: JSON.stringify(job.schedule),
				})),
				files: Object.keys(pkg.files).sort(),
				readme: pkg.readme,
				agents: pkg.agents || null,
			},
		},
	})
}
