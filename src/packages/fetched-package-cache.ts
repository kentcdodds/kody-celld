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
 * every navigation. Settled entries for commit-pinned `github:`/`kody:` refs
 * are immutable; URL sources get a short freshness window so a warm isolate
 * does not serve a changed package at the same URL until eviction. A separate
 * in-flight map coalesces concurrent clicks for any key (including mutable
 * HEAD/branch refs) without lasting mutable entries.
 */
const maxEntries = 3

/** Freshness window for settled URL-source entries (mutable content). */
export const urlFetchedPackageCacheTtlMs = 60_000

type SettledEntry = {
	value: Promise<FetchedPackage>
	/** `null` = commit-pinned (immutable until eviction); otherwise absolute expiry. */
	expiresAt: number | null
}

const cache = new Map<string, SettledEntry>()
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

function storeKeyFor(source: PackageSource, fetched: FetchedPackage): string | null {
	if (fetched.commit) return pinPackageSourceToCommit(describePackageSource(source), fetched.commit)
	if (source.kind === 'url') return describePackageSource(source)
	return null
}

function putSettled(key: string, value: Promise<FetchedPackage>, expiresAt: number | null) {
	if (cache.has(key)) cache.delete(key)
	else if (cache.size >= maxEntries) {
		const oldest = cache.keys().next().value
		if (oldest !== undefined) cache.delete(oldest)
	}
	cache.set(key, { value, expiresAt })
}

function settledHit(key: string): Promise<FetchedPackage> | null {
	const hit = cache.get(key)
	if (!hit) return null
	if (hit.expiresAt !== null && Date.now() >= hit.expiresAt) {
		cache.delete(key)
		return null
	}
	cache.delete(key)
	cache.set(key, hit)
	return hit.value
}

export async function fetchPackageSourceCached(
	source: PackageSource,
	options: { allowedHosts: Array<string>; privateHosts?: Array<string>; fetch?: FetchLike | undefined },
): Promise<FetchedPackage> {
	const key = fetchedPackageCacheKey(source)
	const cached = settledHit(key)
	if (cached) return cached

	const pendingHit = inflight.get(key)
	if (pendingHit) return pendingHit

	const pending = fetchPackageSource(source, options)
	inflight.set(key, pending)
	try {
		const fetched = await pending
		const storeKey = storeKeyFor(source, fetched)
		if (storeKey) {
			const expiresAt = source.kind === 'url' ? Date.now() + urlFetchedPackageCacheTtlMs : null
			putSettled(storeKey, Promise.resolve(fetched), expiresAt)
		}
		return fetched
	} finally {
		if (inflight.get(key) === pending) inflight.delete(key)
	}
}
