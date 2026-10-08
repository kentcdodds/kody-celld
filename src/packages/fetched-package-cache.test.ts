import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clearFetchedPackageCache, fetchPackageSourceCached, fetchedPackageCacheSize } from './fetched-package-cache.ts'
import { parsePackageSource, type FetchLike } from './install.ts'

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
		// Oldest (a) was evicted; refetching it hits the network again.
		await fetchPackageSourceCached(parsePackageSource('https://a.example/pkg.json'), {
			allowedHosts: ['*.example'],
			fetch: fetchImpl,
		})
		assert.equal(n, 5)
	})
})
