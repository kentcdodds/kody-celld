import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { defaultPublisher, renamePackageFiles } from '../capabilities/community.ts'
import { CommunityStore, communityLimits, communitySchema } from './community-store.ts'
import { parsePackageManifest, type PackageFiles } from './manifest.ts'

/** Just enough of Durable Object `SqlStorage` for the store. */
function memorySql() {
	const db = new DatabaseSync(':memory:')
	return {
		exec(query: string, ...params: Array<string | number | null>) {
			const statements = query.split(';').filter((s) => s.trim())
			if (statements.length > 1) {
				for (const statement of statements) db.exec(statement)
				return { toArray: () => [], rowsWritten: 0 }
			}
			const statement = db.prepare(query)
			if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...params), rowsWritten: 0 }
			const result = statement.run(...params)
			return { toArray: () => [], rowsWritten: Number(result.changes) }
		},
	} as unknown as SqlStorage
}

function store() {
	let tick = 0
	const sql = memorySql()
	sql.exec(communitySchema)
	return new CommunityStore(sql, () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString())
}

function files(name: string, extra: Record<string, unknown> = {}): PackageFiles {
	return {
		'package.json': JSON.stringify({
			name,
			version: '1.0.0',
			description: `The ${name} package`,
			exports: { '.': './main.js' },
			keywords: ['weather', 'demo'],
			...extra,
		}),
		'README.md': `# ${name}`,
		'AGENTS.md': 'Call the default export.',
		'main.js': 'export default async () => 1',
	}
}

function published(name: string, userId: string, extra: Record<string, unknown> = {}) {
	const pkgFiles = files(name, extra)
	const manifest = parsePackageManifest(pkgFiles)
	return { userId, publisher: userId, name: manifest.name, version: manifest.version, manifest, files: pkgFiles }
}

describe('CommunityStore', () => {
	it('publishes, searches, reads and counts installs', () => {
		const community = store()
		const listing = community.publish(published('@a/weather', 'alice'))
		assert.equal(listing.name, '@a/weather')
		assert.equal(listing.publisher, 'alice')
		assert.equal(listing.fileCount, 4)
		assert.equal(listing.readme, '# @a/weather')
		assert.deepEqual(listing.keywords, ['weather', 'demo'])
		community.publish(published('@b/notes', 'bob', { keywords: ['notes'], description: 'Daily notes' }))

		assert.deepEqual(
			community.search({ query: 'weather' }).map((l) => l.name),
			['@a/weather'],
		)
		assert.deepEqual(
			community.search({ query: 'daily NOTES' }).map((l) => l.name),
			['@b/notes'],
		)
		assert.deepEqual(community.search({ query: '100%_nothing' }), [])
		assert.equal(community.search({}).length, 2)

		community.recordInstall('@b/notes')
		assert.deepEqual(
			community.search({}).map((l) => l.name),
			['@b/notes', '@a/weather'],
		)
		const pkg = community.get('@b/notes')
		assert.ok(pkg)
		assert.equal(pkg.installs, 1)
		assert.equal(pkg.files['main.js'], 'export default async () => 1')
		assert.equal(pkg.agents, 'Call the default export.')
		assert.equal('userId' in pkg, false)
		assert.deepEqual({ ...community.stats() }, { packages: 2, publishers: 2, installs: 1 })
		assert.equal(community.ownerOf('@b/notes'), 'bob')
		assert.equal(community.ownerOf('@nobody/x'), null)
	})

	it('republishing updates the copy; other users cannot take or remove the name', () => {
		const community = store()
		community.publish(published('@a/weather', 'alice'))
		const again = community.publish(published('@a/weather', 'alice', { version: '1.1.0', description: 'Better' }))
		assert.equal(again.version, '1.1.0')
		assert.equal(again.description, 'Better')
		assert.notEqual(again.updatedAt, again.publishedAt)
		assert.throws(() => community.publish(published('@a/weather', 'mallory')), /community_name_taken:409/)
		assert.throws(() => community.unpublish({ userId: 'mallory', name: '@a/weather' }), /forbidden:403/)
		assert.equal(community.unpublish({ userId: 'alice', name: '@a/weather' }), true)
		assert.equal(community.unpublish({ userId: 'alice', name: '@a/weather' }), false)
		assert.equal(community.get('@a/weather'), null)
	})

	it('refuses hidden packages and bad publisher handles, and caps listings per user', () => {
		const community = store()
		assert.throws(() => community.publish(published('@a/secret', 'alice', { kody: { hidden: true } })), /marked hidden/)
		assert.throws(
			() => community.publish({ ...published('@a/x', 'alice'), publisher: 'Not Valid!' }),
			/publisher must be/,
		)
		for (let i = 0; i < communityLimits.maxPerUser; i += 1) community.publish(published(`@a/p${i}`, 'alice'))
		assert.throws(() => community.publish(published('@a/one-more', 'alice')), /quota_exceeded:429/)
		// Republishing an existing name is still allowed at the cap.
		community.publish(published('@a/p0', 'alice', { version: '2.0.0' }))
		assert.equal(community.listByUser('alice').length, communityLimits.maxPerUser)
	})

	it('search limits and escapes LIKE wildcards', () => {
		const community = store()
		community.publish(published('@a/100-percent', 'alice', { description: '100% sure' }))
		community.publish(published('@a/other', 'alice', { description: '1000 things' }))
		assert.deepEqual(
			community.search({ query: '100%' }).map((l) => l.name),
			['@a/100-percent'],
		)
		assert.equal(community.search({ limit: 1 }).length, 1)
		assert.equal(community.search({ limit: 999 }).length, 2)
	})
})

describe('community helpers', () => {
	it('derives a safe publisher handle from an email', () => {
		assert.equal(defaultPublisher('Kent.Dodds+kody@example.com'), 'kent.dodds-kody')
		assert.equal(defaultPublisher('__weird@example.com'), 'weird')
		assert.equal(defaultPublisher('!!!@example.com'), 'user')
		assert.equal(defaultPublisher(`${'a'.repeat(60)}@x.test`).length, 40)
	})

	it('renames package.json for forks and keeps the rest of the file map', () => {
		const forked = renamePackageFiles(files('@a/weather'), '@me/weather')
		assert.equal(parsePackageManifest(forked).name, '@me/weather')
		assert.equal(forked['main.js'], 'export default async () => 1')
		assert.throws(() => renamePackageFiles({ 'README.md': 'x' }, '@me/x'), /no package\.json/)
		assert.throws(() => renamePackageFiles({ 'package.json': '{' }, '@me/x'), /not valid JSON/)
	})
})
