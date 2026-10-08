import {
	describePackageSource,
	fetchPackageSource,
	type FetchLike,
	type FetchedPackage,
	type PackageSource,
} from './install.ts'

/**
 * kody-celld: the package-preview explorer GETs once per file click. Without a
 * cache that re-downloads the whole remote (up to 8 MB / 24 MB unpacked) on
 * every navigation. Keyed by the resolved source string so a commit-pinned
 * `github:…#sha` shares one entry across files. Small and in-process — enough
 * for browsing one package; cold isolates just refetch.
 */
const maxEntries = 3

const cache = new Map<string, FetchedPackage>()

export function fetchedPackageCacheKey(source: PackageSource): string {
	return describePackageSource(source)
}

export function clearFetchedPackageCache() {
	cache.clear()
}

export function fetchedPackageCacheSize() {
	return cache.size
}

function put(key: string, value: FetchedPackage) {
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
	const hit = cache.get(key)
	if (hit) {
		cache.delete(key)
		cache.set(key, hit)
		return hit
	}
	const fetched = await fetchPackageSource(source, options)
	put(key, fetched)
	return fetched
}
