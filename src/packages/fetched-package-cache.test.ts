import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import {
	clearFetchedPackageCache,
	fetchPackageSourceCached,
	fetchedPackageCacheSize,
	urlFetchedPackageCacheTtlMs,
} from './fetched-package-cache.ts'
import { parsePackageSource, type FetchLike } from './install.ts'

const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const manifest = JSON.stringify({
	name: '@t/cached',
	version: '1.0.0',
	exports: { '.': './main.js' },
})

function jsonPackageResponse() {
	return new Response(
		JSON.stringify({
			'package.json': manifest,
			'main.js': 'export const ok = true\n',
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	)
}

describe('fetchPackageSourceCached', () => {
	it('reuses one fetch across file clicks for the same resolved source', async () => {
		clearFetchedPackageCache()
		let calls = 0
		const fetchImpl: FetchLike = async () => {
			calls += 1
			return jsonPackageResponse()
		}
		const source = parsePackageSource('https://example.com/pkg.json')
		const first = await fetchPackageSourceCached(source, {
			allowedHosts: ['example.com'],
			fetch: fetchImpl,
		})
		const second = await fetchPackageSourceCached(source, {
			allowedHosts: ['example.com'],
			fetch: fetchImpl,
		})
		assert.equal(calls, 1)
		assert.equal(first.files['main.js'], second.files['main.js'])
		assert.equal(fetchedPackageCacheSize(), 1)
	})

	it('coalesces concurrent fetches for the same key', async () => {
		clearFetchedPackageCache()
		let calls = 0
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const fetchImpl: FetchLike = async () => {
			calls += 1
			await gate
			return jsonPackageResponse()
		}
		const source = parsePackageSource('https://example.com/pkg.json')
		const a = fetchPackageSourceCached(source, { allowedHosts: ['example.com'], fetch: fetchImpl })
		const b = fetchPackageSourceCached(source, { allowedHosts: ['example.com'], fetch: fetchImpl })
		release()
		assert.equal((await a).files['main.js'], (await b).files['main.js'])
		assert.equal(calls, 1)
	})

	it('stores github packages under the pinned commit key, not the mutable HEAD key', async () => {
		clearFetchedPackageCache()
		let tarballCalls = 0
		const fetchImpl: FetchLike = async (url) => {
			if (url.startsWith('https://api.github.com/')) {
				return new Response(sha, { status: 200, headers: { 'content-type': 'application/vnd.github.sha' } })
			}
			tarballCalls += 1
			return new Response(
				JSON.stringify({
					'package.json': manifest,
					'main.js': `export const n = ${tarballCalls}\n`,
				}),
				{ status: 200 },
			)
		}
		const hosts = ['codeload.github.com', 'api.github.com']
		const unpinned = parsePackageSource('github:o/hello')
		const first = await fetchPackageSourceCached(unpinned, { allowedHosts: hosts, fetch: fetchImpl })
		assert.equal(first.commit, sha)
		assert.equal(tarballCalls, 1)
		// A later unpinned visit must not reuse the old tree (mutable key is not cached).
		const second = await fetchPackageSourceCached(unpinned, { allowedHosts: hosts, fetch: fetchImpl })
		assert.equal(tarballCalls, 2)
		assert.equal(second.files['main.js'], 'export const n = 2\n')
		// Commit-pinned browsing reuses the entry written by the last fetch.
		const pinned = parsePackageSource(`github:o/hello#${sha}`)
		const third = await fetchPackageSourceCached(pinned, { allowedHosts: hosts, fetch: fetchImpl })
		assert.equal(tarballCalls, 2)
		assert.equal(third.files['main.js'], second.files['main.js'])
	})

	it('evicts the oldest entry once the bound is reached', async () => {
		clearFetchedPackageCache()
		let n = 0
		const fetchImpl: FetchLike = async (url) => {
			n += 1
			return new Response(
				JSON.stringify({
					'package.json': JSON.stringify({
						name: `@t/p${n}`,
						version: '1.0.0',
						exports: { '.': './main.js' },
					}),
					'main.js': String(url),
				}),
				{ status: 200 },
			)
		}
		for (const host of ['a.example', 'b.example', 'c.example', 'd.example']) {
			await fetchPackageSourceCached(parsePackageSource(`https://${host}/pkg.json`), {
				allowedHosts: ['*.example'],
				fetch: fetchImpl,
			})
		}
		assert.equal(fetchedPackageCacheSize(), 3)
		assert.equal(n, 4)
		await fetchPackageSourceCached(parsePackageSource('https://a.example/pkg.json'), {
			allowedHosts: ['*.example'],
			fetch: fetchImpl,
		})
		assert.equal(n, 5)
	})

	it('refetches a URL source after the freshness window expires', async () => {
		clearFetchedPackageCache()
		mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
		try {
			let calls = 0
			const fetchImpl: FetchLike = async () => {
				calls += 1
				return new Response(
					JSON.stringify({
						'package.json': manifest,
						'main.js': `export const n = ${calls}\n`,
					}),
					{ status: 200 },
				)
			}
			const source = parsePackageSource('https://example.com/pkg.json')
			const first = await fetchPackageSourceCached(source, {
				allowedHosts: ['example.com'],
				fetch: fetchImpl,
			})
			assert.equal(calls, 1)
			assert.equal(first.files['main.js'], 'export const n = 1\n')
			mock.timers.tick(urlFetchedPackageCacheTtlMs - 1)
			const warm = await fetchPackageSourceCached(source, {
				allowedHosts: ['example.com'],
				fetch: fetchImpl,
			})
			assert.equal(calls, 1)
			assert.equal(warm.files['main.js'], 'export const n = 1\n')
			mock.timers.tick(2)
			const refreshed = await fetchPackageSourceCached(source, {
				allowedHosts: ['example.com'],
				fetch: fetchImpl,
			})
			assert.equal(calls, 2)
			assert.equal(refreshed.files['main.js'], 'export const n = 2\n')
		} finally {
			mock.timers.reset()
			clearFetchedPackageCache()
		}
	})
})
