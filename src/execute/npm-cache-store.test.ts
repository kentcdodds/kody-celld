import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { NpmCacheStore } from './npm-cache-store.ts'
import { npmCacheMaxModuleBytes } from './npm-config.ts'

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
	let now = 1_000_000
	const cache = new NpmCacheStore(memorySql(), () => now)
	return { cache, tick: (ms: number) => (now += ms) }
}

const day = 24 * 60 * 60 * 1000

describe('NpmCacheStore', () => {
	it('stores, serves and counts hits and misses', () => {
		const { cache } = store()
		assert.deepEqual(cache.getMany(['https://esm.sh/a'], day), {})
		cache.putMany({ 'https://esm.sh/a': 'export const a = 1' }, 1024 * 1024)
		assert.deepEqual(cache.getMany(['https://esm.sh/a', 'https://esm.sh/b'], day), {
			'https://esm.sh/a': 'export const a = 1',
		})
		const stats = cache.stats()
		assert.equal(stats.modules, 1)
		assert.equal(stats.bytes, 'export const a = 1'.length)
		assert.equal(stats.hits, 1)
		assert.equal(stats.misses, 2)
		assert.equal(stats.oldestFetchedAt, new Date(1_000_000).toISOString())
	})

	it('expires entries past the ttl and treats ttl 0 as forever', () => {
		const { cache, tick } = store()
		cache.putMany({ 'https://esm.sh/a': 'a' }, 1024)
		tick(31 * day)
		assert.deepEqual(cache.getMany(['https://esm.sh/a'], 30 * day), {})
		assert.equal(cache.stats().modules, 0, 'expired rows are removed on read')
		cache.putMany({ 'https://esm.sh/b': 'b' }, 1024)
		tick(365 * day)
		assert.deepEqual(cache.getMany(['https://esm.sh/b'], 0), { 'https://esm.sh/b': 'b' })
	})

	it('evicts least-recently-used rows beyond the byte ceiling', () => {
		const { cache, tick } = store()
		cache.putMany({ 'https://esm.sh/a': 'a'.repeat(40), 'https://esm.sh/b': 'b'.repeat(40) }, 100)
		tick(10)
		cache.getMany(['https://esm.sh/a'], 0) // a is now newer than b
		tick(10)
		const result = cache.putMany({ 'https://esm.sh/c': 'c'.repeat(40) }, 100)
		assert.deepEqual(result, { stored: 1, evicted: 1 })
		assert.deepEqual(
			Object.keys(cache.getMany(['https://esm.sh/a', 'https://esm.sh/b', 'https://esm.sh/c'], 0)).sort(),
			['https://esm.sh/a', 'https://esm.sh/c'],
		)
	})

	it('skips modules larger than the per-module or total ceiling', () => {
		const { cache } = store()
		const huge = 'x'.repeat(npmCacheMaxModuleBytes + 1)
		assert.deepEqual(cache.putMany({ 'https://esm.sh/huge': huge, 'https://esm.sh/big': 'y'.repeat(200) }, 100), {
			stored: 0,
			evicted: 0,
		})
		assert.equal(cache.stats().modules, 0)
	})

	it('measures bytes in UTF-8, not string length', () => {
		const { cache } = store()
		cache.putMany({ 'https://esm.sh/u': '€' }, 1024)
		assert.equal(cache.stats().bytes, 3)
	})

	it('clear removes modules and counters and reports what went', () => {
		const { cache } = store()
		cache.putMany({ 'https://esm.sh/a': 'abc' }, 1024)
		cache.getMany(['https://esm.sh/a'], 0)
		assert.deepEqual(cache.clear(), { cleared: 1, bytes: 3 })
		assert.deepEqual(cache.stats(), {
			modules: 0,
			bytes: 0,
			hits: 0,
			misses: 0,
			oldestFetchedAt: null,
			newestFetchedAt: null,
		})
	})
})
