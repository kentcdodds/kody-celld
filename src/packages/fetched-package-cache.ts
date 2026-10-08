import {
	describePackageSource,
	fetchPackageSource,
	pinPackageSourceToCommit,
	type FetchLike,
	type FetchedPackage,
	type PackageSource,
} from './install.ts'

/**
 * kody-celld: the package-preview explorer GETs once per file click. Without a
 * cache that re-downloads the whole remote (up to 8 MB / 24 MB unpacked) on
 * every navigation. Settled entries are stored only under immutable keys (URL
 * sources or commit-pinned `github:`/`kody:` refs) so a warm isolate never
 * serves a stale HEAD/branch. A separate in-flight map coalesces concurrent
 * clicks for any key (including mutable ones) without lasting mutable entries.
 */
const maxEntries = 3
const fullCommitSha = /^[0-9a-f]{40}$/i

const cache = new Map<string, Promise<FetchedPackage>>()
const inflight = new Map<string, Promise<FetchedPackage>>()

export function fetchedPackageCacheKey(source: PackageSource): string {
	return describePackageSource(source)
}

export function clearFetchedPackageCache() {
	cache.clear()
	inflight.clear()
}

export function fetchedPackageCacheSize() {
	return cache.size
}

/** Only URL sources and full-SHA refs are safe to return from the settled cache. */
function isImmutableCacheKey(source: PackageSource): boolean {
	if (source.kind === 'url') return true
	if (source.kind === 'github' || source.kind === 'kody') {
		return source.ref !== null && fullCommitSha.test(source.ref)
	}
	return false
}

function storeKeyFor(source: PackageSource, fetched: FetchedPackage): string | null {
	if (fetched.commit) return pinPackageSourceToCommit(describePackageSource(source), fetched.commit)
	if (source.kind === 'url') return describePackageSource(source)
	return null
}

function putSettled(key: string, value: Promise<FetchedPackage>) {
	if (cache.has(key)) cache.delete(key)
	else if (cache.size >= maxEntries) {
		const oldest = cache.keys().next().value
		if (oldest !== undefined) cache.delete(oldest)
	}
	cache.set(key, value)
}

export async function fetchPackageSourceCached(
	source: PackageSource,
	options: { allowedHosts: Array<string>; fetch?: FetchLike | undefined },
): Promise<FetchedPackage> {
	const key = fetchedPackageCacheKey(source)
	if (isImmutableCacheKey(source)) {
		const hit = cache.get(key)
		if (hit) {
			cache.delete(key)
			cache.set(key, hit)
			return hit
		}
	}

	const pendingHit = inflight.get(key)
	if (pendingHit) return pendingHit

	const pending = fetchPackageSource(source, options)
	inflight.set(key, pending)
	try {
		const fetched = await pending
		const storeKey = storeKeyFor(source, fetched)
		if (storeKey) putSettled(storeKey, Promise.resolve(fetched))
		return fetched
	} finally {
		if (inflight.get(key) === pending) inflight.delete(key)
	}
}
