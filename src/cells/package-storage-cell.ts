import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.ts'
import { KodyError } from '../lib/errors.ts'

export type StorageListOptions = {
	prefix?: string | undefined
	limit?: number | undefined
	cursor?: string | undefined
}

export type SqlResult = {
	columns: Array<string>
	rows: Array<Record<string, SqlStorageValue>>
	rowCount: number
	rowsRead: number
	rowsWritten: number
}

const reservedTablePrefix = '__kody_'

/**
 * `packageStorage()` backing store: one SQLite cell per (user, package). The
 * key/value surface lives in the `__kody_kv` table; `sql()` runs against the
 * same database so a package can create its own tables next to it.
 */
export class PackageStorageCell extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS __kody_kv (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`)
	}

	/** Returns the stored JSON text, or undefined. */
	async get(key: string): Promise<string | undefined> {
		const row = this.ctx.storage.sql
			.exec<{ value: string }>('SELECT value FROM __kody_kv WHERE key = ?', key)
			.toArray()[0]
		return row?.value
	}

	/** `valueJson` is JSON text; undefined deletes the key. */
	async set(key: string, valueJson: string | undefined) {
		if (typeof key !== 'string' || !key) throw new KodyError('invalid_key', 'Key is required.')
		if (valueJson === undefined) {
			await this.delete(key)
			return
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO __kody_kv (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			key,
			valueJson,
			new Date().toISOString(),
		)
	}

	async delete(key: string) {
		const cursor = this.ctx.storage.sql.exec('DELETE FROM __kody_kv WHERE key = ?', key)
		return cursor.rowsWritten > 0
	}

	async list(options: StorageListOptions = {}) {
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000)
		const prefix = options.prefix ?? ''
		const cursor = options.cursor ?? ''
		const rows = this.ctx.storage.sql
			.exec<{ key: string; value: string; updated_at: string }>(
				`SELECT key, value, updated_at FROM __kody_kv
				 WHERE key >= ? AND key > ? AND substr(key, 1, ?) = ?
				 ORDER BY key ASC LIMIT ?`,
				prefix,
				cursor,
				prefix.length,
				prefix,
				limit + 1,
			)
			.toArray()
		const page = rows.slice(0, limit)
		return {
			items: page.map((row) => ({
				key: row.key,
				valueJson: row.value,
				updatedAt: row.updated_at,
			})),
			cursor: rows.length > limit ? (page[page.length - 1]?.key ?? null) : null,
		}
	}

	async clear() {
		this.ctx.storage.sql.exec('DELETE FROM __kody_kv')
		const tables = this.ctx.storage.sql
			.exec<{ name: string }>(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__kody_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`,
			)
			.toArray()
		for (const table of tables) {
			this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS "${table.name.replaceAll('"', '""')}"`)
		}
	}

	async sql(query: string, params: Array<SqlStorageValue> = []): Promise<SqlResult> {
		if (typeof query !== 'string' || !query.trim()) {
			throw new KodyError('invalid_sql', 'A SQL statement is required.')
		}
		if (/\b(?:__kody_|sqlite_master|_cf_)/i.test(query) && !/^\s*select/i.test(query)) {
			throw new KodyError('reserved_table', `Statements may not modify tables prefixed with ${reservedTablePrefix}.`)
		}
		const cursor = this.ctx.storage.sql.exec(query, ...params)
		const rows = cursor.toArray() as Array<Record<string, SqlStorageValue>>
		return {
			columns: cursor.columnNames,
			rows,
			rowCount: rows.length,
			rowsRead: cursor.rowsRead,
			rowsWritten: cursor.rowsWritten,
		}
	}

	async stats() {
		const kv = this.ctx.storage.sql.exec<{ c: number }>('SELECT count(*) AS c FROM __kody_kv').toArray()[0]
		const tables = this.ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__kody_%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '_litestream_%' ORDER BY name",
			)
			.toArray()
			.map((row) => row.name)
		return { keys: kv?.c ?? 0, tables, databaseSize: this.ctx.storage.sql.databaseSize }
	}
}

export function packageStorageCellName(userId: string, packageName: string) {
	return `${userId}::${packageName}`
}
