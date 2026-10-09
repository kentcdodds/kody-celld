/**
 * Table-name prefixes that package storage must never list, drop, or let
 * package SQL mutate. Includes SQLite internals, our KV table prefix, Cloudflare
 * DO bookkeeping (`_cf_*`), and celld durability tables (`_litestream_*`).
 *
 * Shared by `clear()`, `stats()`, and the `sql()` reserved-table guard so the
 * exclusion list cannot drift (see #40).
 */
export const reservedTablePrefixes = ['sqlite_', '__kody_', '_cf_', '_litestream_'] as const

const likeEscapeChar = '\\'

/** Escape `%`, `_`, and `\` so a prefix is matched literally in a LIKE pattern. */
export function likeLiteralPrefix(prefix: string): string {
	return `${prefix.replaceAll(likeEscapeChar, `${likeEscapeChar}${likeEscapeChar}`).replaceAll('%', `${likeEscapeChar}%`).replaceAll('_', `${likeEscapeChar}_`)}%`
}

/** `name NOT LIKE '…' ESCAPE '\'` clauses excluding every reserved prefix. */
export function reservedTableExclusionSql(column = 'name'): string {
	return reservedTablePrefixes
		.map((prefix) => `${column} NOT LIKE '${likeLiteralPrefix(prefix)}' ESCAPE '${likeEscapeChar}'`)
		.join(' AND ')
}

export function isReservedTableName(name: string): boolean {
	const lower = name.toLowerCase()
	return reservedTablePrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))
}

/**
 * Crude statement scan used by `sql()`: non-SELECT statements that mention a
 * reserved prefix (or `sqlite_master`) are rejected with `reserved_table`.
 */
export function touchesReservedTable(query: string): boolean {
	const pattern = new RegExp(`\\b(?:${[...reservedTablePrefixes, 'sqlite_master'].map(escapeRegExp).join('|')})`, 'i')
	return pattern.test(query)
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
