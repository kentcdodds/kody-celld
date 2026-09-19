// Community smoke: publish a package to the node's public catalog, find and
// read it (MCP + public HTML pages), install it as a second user (plain and
// forked), update the copy after a republish, and prove ownership rules and
// unpublish. Names are unique per run so repeated smokes never collide.
import { randomBytes } from 'node:crypto'
import { assert, baseUrl, bootstrapUser, log } from './lib.mjs'

function helloFiles(name, version, greeting) {
	return {
		'package.json': JSON.stringify({
			name,
			version,
			description: `Says ${greeting} (kody-celld smoke)`,
			keywords: ['greeting', 'smoke-catalog'],
			exports: { '.': './main.js' },
		}),
		'README.md': `# ${name}\n\nReturns a greeting.`,
		'AGENTS.md': 'Call the default export with { who }.',
		'main.js': `export default async function main({ who = 'world' } = {}) { return ${JSON.stringify(greeting)} + ', ' + who }`,
	}
}

export async function smokeCommunity({ mcp, user }) {
	const suffix = randomBytes(3).toString('hex')
	const name = `@kody-smoke/hello-${suffix}`
	const forkName = `@kody-smoke/hello-fork-${suffix}`
	await mcp.call('packageSave', { files: helloFiles(name, '1.0.0', 'hello'), source: 'smoke/community.mjs' })

	// Only saved packages can be published, and never hidden ones.
	const notSaved = await mcp.callDirectRaw('communityPublish', { name: `@kody-smoke/missing-${suffix}` })
	assert(
		notSaved.isError && /not saved/.test(JSON.stringify(notSaved.payload)),
		'publishing an unsaved package',
		notSaved.payload,
	)

	const listing = await mcp.call('communityPublish', { name })
	assert(listing.name === name && listing.version === '1.0.0', 'publish returned the wrong listing', listing)
	assert(
		typeof listing.publisher === 'string' && !listing.publisher.includes('@'),
		'publisher is a handle, not an email',
		listing,
	)
	assert(!JSON.stringify(listing).includes(user.id), 'listings must not leak user ids', listing)
	log('communityPublish', { name: listing.name, publisher: listing.publisher, url: listing.url })

	const found = await mcp.call('communitySearch', { query: `hello-${suffix}` })
	assert(found.packages.length === 1 && found.packages[0].name === name, 'search should find the new listing', found)
	const byKeyword = await mcp.call('communitySearch', { query: 'smoke-catalog', limit: 100 })
	assert(
		byKeyword.packages.some((pkg) => pkg.name === name),
		'search should match keywords',
		byKeyword.packages.length,
	)

	const detail = await mcp.call('communityGet', { name, includeFiles: true })
	assert(
		detail.readme.includes(name) && detail.files['main.js'].includes('hello'),
		'communityGet should include README and files',
		Object.keys(detail),
	)
	assert(!JSON.stringify(detail).includes(user.id), 'communityGet must not leak user ids', Object.keys(detail))

	// Public pages need no session at all.
	const index = await fetch(`${baseUrl}/community?q=hello-${suffix}`)
	assert(index.status === 200, 'GET /community should be public', index.status)
	const indexHtml = await index.text()
	assert(
		indexHtml.includes(name) && indexHtml.includes(listing.publisher),
		'/community should list the package',
		indexHtml.slice(0, 200),
	)
	const page = await fetch(`${baseUrl}/community/${encodeURIComponent(name)}`)
	assert(page.status === 200, 'GET /community/<name> should be public', page.status)
	const pageHtml = await page.text()
	assert(
		pageHtml.includes('communityInstall') && pageHtml.includes('Returns a greeting') && !pageHtml.includes(user.id),
		'detail page should show README + install snippet and no user ids',
		pageHtml.slice(0, 200),
	)
	const missingPage = await fetch(`${baseUrl}/community/${encodeURIComponent(`@kody-smoke/nope-${suffix}`)}`)
	assert(missingPage.status === 404, 'unknown listings should 404', missingPage.status)
	const post = await fetch(`${baseUrl}/community`, { method: 'POST' })
	assert(post.status === 405, 'community pages are read-only', post.status)
	log('public pages', { index: index.status, detail: page.status })

	// A second user installs a copy and a fork; neither can touch the listing.
	const other = await bootstrapUser('smoke-b')
	await other.mcp.initialize()
	const copy = await other.mcp.call('communityInstall', { name })
	assert(
		copy.name === name && copy.source === `community:${name}@1.0.0`,
		'install should record community provenance',
		copy,
	)
	const fork = await other.mcp.call('communityInstall', { name, as: forkName })
	assert(fork.name === forkName && fork.fork === true && /\(fork\)$/.test(fork.source), 'fork should be renamed', fork)
	const ranFork = await other.mcp.callDirect('packageRun', { name: forkName, params: { who: 'celld' } })
	assert(ranFork.ok && ranFork.result === 'hello, celld', 'forked package should run', ranFork)
	log('communityInstall', { copy: copy.source, fork: fork.source, ran: ranFork.result })

	const steal = await other.mcp.callDirectRaw('communityUnpublish', { name })
	assert(
		steal.isError && /forbidden/.test(JSON.stringify(steal.payload)),
		'other users cannot unpublish',
		steal.payload,
	)
	// Publishing the installed copy (same package.json name) must not take over the listing.
	const squat = await other.mcp.callDirectRaw('communityPublish', { name })
	assert(
		squat.isError && /community_name_taken/.test(JSON.stringify(squat.payload)),
		'names belong to the first publisher',
		squat.payload,
	)
	const stillOriginal = await mcp.call('communityGet', { name })
	assert(stillOriginal.version === '1.0.0', 'squatting attempt must not change the listing', stillOriginal)
	log('ownership', 'unpublish + republish by another user refused')

	// Republish a new version; the installed copy updates from the catalog.
	await mcp.call('packageSave', { files: helloFiles(name, '1.1.0', 'howdy'), source: 'smoke/community.mjs' })
	const republished = await mcp.call('communityPublish', { name })
	assert(republished.version === '1.1.0', 'republish should carry the new version', republished)
	const updated = await other.mcp.call('packageUpdate', { name })
	assert(
		updated.version === '1.1.0' && updated.source === `community:${name}@1.1.0`,
		'copy should update from catalog',
		updated,
	)
	const ranCopy = await other.mcp.callDirect('packageRun', { name, params: { who: 'celld' } })
	assert(ranCopy.ok && ranCopy.result === 'howdy, celld', 'updated copy should run the new code', ranCopy)
	const forkUpdate = await other.mcp.callDirectRaw('packageUpdate', { name: forkName })
	assert(
		forkUpdate.isError && /fork/.test(JSON.stringify(forkUpdate.payload)),
		'forks are not auto-updatable',
		forkUpdate.payload,
	)
	const stats = await mcp.call('communityGet', { name })
	assert(stats.installs === 2, 'install counter should count both installs', stats.installs)
	log('republish + update', { version: updated.version, installs: stats.installs })

	// Unpublish: listing disappears, installed copies stay.
	const gone = await mcp.call('communityUnpublish', { name })
	assert(gone.unpublished === true, 'unpublish should succeed for the owner', gone)
	const afterwards = await mcp.callDirectRaw('communityGet', { name })
	assert(
		afterwards.isError && /community_not_found/.test(JSON.stringify(afterwards.payload)),
		'listing should be gone',
		afterwards.payload,
	)
	const kept = await other.mcp.call('packageGet', { name })
	assert(kept.version === '1.1.0', 'installed copies survive unpublish', kept)
	const orphanUpdate = await other.mcp.callDirectRaw('packageUpdate', { name })
	assert(
		orphanUpdate.isError && /no longer in the community catalog/.test(JSON.stringify(orphanUpdate.payload)),
		'orphaned copies report the missing listing',
		orphanUpdate.payload,
	)
	log('communityUnpublish', { unpublished: gone.unpublished, copyKept: kept.version })
}
