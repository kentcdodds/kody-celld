import { npmCacheMaxModuleBytes } from './npm-config.ts'

export type NpmCacheStats = {
	modules: number
	bytes: number
	hits: number
	misses: number
	oldestFetchedAt: string | null
	newestFetchedAt: string | null
}

export const npmCacheSchema = `
	CREATE TABLE IF NOT EXISTS modules (
		url TEXT PRIMARY KEY,
		source TEXT NOT NULL,
		bytes INTEGER NOT NULL,
		fetched_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS modules_last_used ON modules(last_used_at);
	CREATE TABLE IF NOT EXISTS counters (
		name TEXT PRIMARY KEY,
		value INTEGER NOT NULL
	);
`

/**
 * SQL-backed module cache used by NpmCacheCell: sources keyed by CDN URL, TTL
 * expiry on read, least-recently-used eviction on write, hit/miss counters.
 */
export class NpmCacheStore {
	private readonly sql: SqlStorage
	private readonly now: () => number

	constructor(sql: SqlStorage, now: () => number = Date.now) {
		this.sql = sql
		this.now = now
		this.sql.exec(npmCacheSchema)
	}

	private bump(name: 'hits' | 'misses', by: number) {
		if (by === 0) return
		this.sql.exec(
			`INSERT INTO counters (name, value) VALUES (?, ?)
			 ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`,
			name,
			by,
		)
	}

	private counter(name: string) {
		return Number(
			this.sql.exec<{ value: number }>('SELECT value FROM counters WHERE name = ?', name).toArray()[0]?.value ?? 0,
		)
	}

	/** Returns the cached sources for the given URLs (missing or expired ones are absent). */
	getMany(urls: Array<string>, ttlMs: number): Record<string, string> {
		const found: Record<string, string> = {}
		if (urls.length === 0) return found
		const now = this.now()
		const minFetchedAt = ttlMs > 0 ? now - ttlMs : Number.NEGATIVE_INFINITY
		for (const url of urls) {
			const row = this.sql
				.exec<{ source: string; fetched_at: number }>('SELECT source, fetched_at FROM modules WHERE url = ?', url)
				.toArray()[0]
			if (!row) continue
			if (row.fetched_at < minFetchedAt) {
				this.sql.exec('DELETE FROM modules WHERE url = ?', url)
				continue
			}
			found[url] = row.source
			this.sql.exec('UPDATE modules SET last_used_at = ? WHERE url = ?', now, url)
		}
		const hits = Object.keys(found).length
		this.bump('hits', hits)
		this.bump('misses', urls.length - hits)
		return found
	}

	/** Stores fetched sources (skipping oversized ones), then evicts LRU rows beyond `maxBytes`. */
	putMany(entries: Record<string, string>, maxBytes: number) {
		const now = this.now()
		let stored = 0
		for (const [url, source] of Object.entries(entries)) {
			const bytes = new TextEncoder().encode(source).byteLength
			if (bytes > npmCacheMaxModuleBytes || bytes > maxBytes) continue
			this.sql.exec(
				`INSERT INTO modules (url, source, bytes, fetched_at, last_used_at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(url) DO UPDATE SET source = excluded.source, bytes = excluded.bytes,
				   fetched_at = excluded.fetched_at, last_used_at = excluded.last_used_at`,
				url,
				source,
				bytes,
				now,
				now,
			)
			stored += 1
		}
		const evicted = this.evict(maxBytes)
		return { stored, evicted }
	}

	private totalBytes() {
		return Number(this.sql.exec<{ n: number | null }>('SELECT SUM(bytes) AS n FROM modules').toArray()[0]?.n ?? 0)
	}

	private evict(maxBytes: number) {
		let total = this.totalBytes()
		let evicted = 0
		while (total > maxBytes) {
			const victim = this.sql
				.exec<{ url: string; bytes: number }>(
					'SELECT url, bytes FROM modules ORDER BY last_used_at ASC, url ASC LIMIT 1',
				)
				.toArray()[0]
			if (!victim) break
			this.sql.exec('DELETE FROM modules WHERE url = ?', victim.url)
			total -= Number(victim.bytes)
			evicted += 1
		}
		return evicted
	}

	stats(): NpmCacheStats {
		const row = this.sql
			.exec<{ n: number; bytes: number | null; oldest: number | null; newest: number | null }>(
				'SELECT COUNT(*) AS n, SUM(bytes) AS bytes, MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest FROM modules',
			)
			.toArray()[0]
		return {
			modules: Number(row?.n ?? 0),
			bytes: Number(row?.bytes ?? 0),
			hits: this.counter('hits'),
			misses: this.counter('misses'),
			oldestFetchedAt: row?.oldest ? new Date(Number(row.oldest)).toISOString() : null,
			newestFetchedAt: row?.newest ? new Date(Number(row.newest)).toISOString() : null,
		}
	}

	clear() {
		const before = this.stats()
		this.sql.exec('DELETE FROM modules')
		this.sql.exec('DELETE FROM counters')
		return { cleared: before.modules, bytes: before.bytes }
	}
}
