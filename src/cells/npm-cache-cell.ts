import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.ts'
import { NpmCacheStore, type NpmCacheStats } from '../execute/npm-cache-store.ts'

export type { NpmCacheStats }

/**
 * Fleet-wide cache of ES modules fetched from the esm.sh-compatible CDN: one
 * cell (`idFromName('npm-cache')`) backed by the bucket, so a module downloaded
 * on one node is served from durable storage on every node until it ages out
 * (KODY_NPM_CACHE_TTL_DAYS) or the least-recently-used rows are evicted to
 * stay under KODY_NPM_CACHE_MAX_MB.
 */
export class NpmCacheCell extends DurableObject<Env> {
	private readonly store: NpmCacheStore

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.store = new NpmCacheStore(this.ctx.storage.sql)
	}

	async getMany(urls: Array<string>, ttlMs: number): Promise<Record<string, string>> {
		return this.store.getMany(urls, ttlMs)
	}

	async putMany(entries: Record<string, string>, maxBytes: number) {
		return this.store.putMany(entries, maxBytes)
	}

	async stats(): Promise<NpmCacheStats> {
		return this.store.stats()
	}

	async clear() {
		return this.store.clear()
	}
}
