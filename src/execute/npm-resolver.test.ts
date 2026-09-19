import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { NpmCacheCell } from '../cells/npm-cache-cell.ts'
import { NpmCacheStore } from './npm-cache-store.ts'
import { DatabaseSync } from 'node:sqlite'
import { npmConfigFromEnv } from './npm-config.ts'
import { resolveNpmModules, type NpmResolverOptions } from './npm-resolver.ts'

const realFetch = globalThis.fetch

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

/** In-process stand-in for the NpmCacheCell stub: same methods, same store. */
function fakeCache() {
	const store = new NpmCacheStore(memorySql())
	const stub = {
		getMany: async (urls: Array<string>, ttlMs: number) => store.getMany(urls, ttlMs),
		putMany: async (entries: Record<string, string>, maxBytes: number) => store.putMany(entries, maxBytes),
		stats: async () => store.stats(),
		clear: async () => store.clear(),
	}
	return { store, stub: stub as unknown as DurableObjectStub<NpmCacheCell> }
}

function fakeCdn(origin: string, files: Record<string, string>) {
	const requests: Array<string> = []
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
		requests.push(url.href)
		if (url.origin !== origin) return new Response('wrong origin', { status: 421 })
		const body = files[`${url.pathname}${url.search}`] ?? files[url.pathname]
		if (body === undefined) return new Response('not found', { status: 404 })
		return new Response(body, { status: 200, headers: { 'content-type': 'application/javascript' } })
	}) as typeof fetch
	return requests
}

afterEach(() => {
	globalThis.fetch = realFetch
})

const origin = 'http://esm.test'
let counter = 0
/** Distinct CDN origin per test so the per-isolate memo cannot leak between cases. */
function freshOrigin() {
	counter += 1
	return `http://esm${counter}.test`
}
const cdnFiles = {
	'/nanoid@5.0.7?target=es2022': "/* esm.sh */\nexport * from '/nanoid@5.0.7/es2022/nanoid.mjs';",
	'/nanoid@5.0.7/es2022/nanoid.mjs': "import { x } from './util.mjs'\nexport const nanoid = () => x + 'id'",
	'/nanoid@5.0.7/es2022/util.mjs': "export const x = 'n'",
}

function options(overrides: Partial<NpmResolverOptions> = {}, cdn = origin): NpmResolverOptions {
	return {
		config: npmConfigFromEnv({ KODY_ESM_CDN_URL: cdn, KODY_NPM_CACHE_MAX_MB: '1' }),
		cache: null,
		...overrides,
	}
}

describe('resolveNpmModules', () => {
	it('walks the graph on the configured CDN and rewrites imports to registered module names', async () => {
		const requests = fakeCdn(origin, cdnFiles)
		const result = await resolveNpmModules(['nanoid@5.0.7'], options())
		assert.equal(result.fetched, 3)
		assert.equal(result.cached, 0)
		assert.ok(requests.every((href) => href.startsWith(origin)))
		const entry = result.entryPaths.get('nanoid@5.0.7')
		assert.equal(entry, 'npm/esm.test/nanoid@5.0.7___target_es2022.js')
		assert.match(result.modules[entry!]!, /from '\.\/npm\/esm\.test\/nanoid@5\.0\.7\/es2022\/nanoid\.mjs'/)
		assert.match(
			result.modules['npm/esm.test/nanoid@5.0.7/es2022/nanoid.mjs']!,
			/'\.\/npm\/esm\.test\/nanoid@5\.0\.7\/es2022\/util\.mjs'/,
		)
		assert.ok(result.warnings.some((w) => w.includes('esm.test') && w.includes('3 downloaded')))
	})

	it('serves repeat resolutions from the durable cache without touching the CDN', async () => {
		const { store, stub } = fakeCache()
		const cdn = freshOrigin()
		const requests = fakeCdn(cdn, cdnFiles)
		const first = await resolveNpmModules(['nanoid@5.0.7'], options({ cache: stub }, cdn))
		assert.equal(first.fetched, 3)
		assert.equal(store.stats().modules, 3)

		// A fresh isolate: the per-process memo is gone but the durable cache is not.
		const { resolveNpmModules: fresh } = await import(`./npm-resolver.ts?isolate=${Date.now()}`)
		globalThis.fetch = (async () => {
			throw new Error('CDN must not be called on a cache hit')
		}) as typeof fetch
		const second = await fresh(['nanoid@5.0.7'], options({ cache: stub }, cdn))
		assert.equal(second.cached, 3)
		assert.equal(second.fetched, 0)
		assert.deepEqual(second.modules, first.modules)
		assert.equal(requests.length, 3)
		assert.equal(store.stats().hits, 3)
	})

	it('ignores the durable cache when the ceiling is 0', async () => {
		const { store, stub } = fakeCache()
		const cdn = freshOrigin()
		fakeCdn(cdn, cdnFiles)
		await resolveNpmModules(['nanoid@5.0.7'], {
			config: npmConfigFromEnv({ KODY_ESM_CDN_URL: cdn, KODY_NPM_CACHE_MAX_MB: '0' }),
			cache: stub,
		})
		assert.equal(store.stats().modules, 0)
	})

	it('surfaces CDN failures as npm_fetch_failed naming the CDN host', async () => {
		fakeCdn(origin, {})
		await assert.rejects(resolveNpmModules(['missing@1.0.0'], options()), (error: Error) => {
			assert.equal(error.name, 'KodyError:npm_fetch_failed:502')
			assert.match(error.message, /esm\.test returned 404/)
			return true
		})
	})

	it('skips cross-origin imports with a warning', async () => {
		fakeCdn(origin, { '/leaky@1.0.0?target=es2022': "export * from 'https://other.test/x.mjs'" })
		const result = await resolveNpmModules(['leaky@1.0.0'], options())
		assert.equal(result.fetched, 1)
		assert.ok(result.warnings.some((w) => w.startsWith('Skipped cross-origin npm import https://other.test/x.mjs')))
	})
})

describe('npmConfigFromEnv', () => {
	it('defaults to esm.sh with the durable cache on', () => {
		assert.deepEqual(npmConfigFromEnv({}), {
			enabled: true,
			cdnOrigin: 'https://esm.sh',
			cacheMaxBytes: 256 * 1024 * 1024,
			cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
		})
	})

	it('accepts a self-hosted origin and off switch', () => {
		const config = npmConfigFromEnv({ KODY_NPM_IMPORTS: 'OFF', KODY_ESM_CDN_URL: 'http://esm:80/' })
		assert.equal(config.enabled, false)
		assert.equal(config.cdnOrigin, 'http://esm')
	})

	it('rejects bad values with the variable name in the message', () => {
		assert.throws(() => npmConfigFromEnv({ KODY_NPM_IMPORTS: 'maybe' }), /KODY_NPM_IMPORTS/)
		assert.throws(() => npmConfigFromEnv({ KODY_ESM_CDN_URL: 'ftp://esm' }), /only http\(s\)/)
		assert.throws(() => npmConfigFromEnv({ KODY_ESM_CDN_URL: 'https://esm.sh/v135' }), /origin only/)
		assert.throws(() => npmConfigFromEnv({ KODY_NPM_CACHE_MAX_MB: '-1' }), /KODY_NPM_CACHE_MAX_MB/)
		assert.throws(() => npmConfigFromEnv({ KODY_NPM_CACHE_TTL_DAYS: 'soon' }), /KODY_NPM_CACHE_TTL_DAYS/)
	})
})
