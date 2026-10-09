import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { KodyError } from '../lib/errors.ts'
import {
	assertPackageTotalBytes,
	countPackageFiles,
	deletePackageFiles,
	maxPackageTotalBytes,
	migrateCommunityPackageFiles,
	migrateUserPackageFiles,
	packageFilesSchema,
	readPackageFiles,
	replacePackageFiles,
	userPackagesTableDdl,
} from './package-files-store.ts'

/** Just enough of Durable Object `SqlStorage` for the store. */
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

function columnsOf(sql: SqlStorage, table: string): Array<string> {
	return sql
		.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
		.toArray()
		.map((row) => row.name)
}

describe('package-files-store', () => {
	it('replaces, reads, counts and deletes per-file rows', () => {
		const sql = memorySql()
		sql.exec(packageFilesSchema)
		replacePackageFiles(sql, '@a/pkg', { 'a.js': 'one', 'b.js': 'two' })
		assert.deepEqual(readPackageFiles(sql, '@a/pkg'), { 'a.js': 'one', 'b.js': 'two' })
		assert.equal(countPackageFiles(sql, '@a/pkg'), 2)
		replacePackageFiles(sql, '@a/pkg', { 'c.js': 'three' })
		assert.deepEqual(readPackageFiles(sql, '@a/pkg'), { 'c.js': 'three' })
		assert.equal(countPackageFiles(sql, '@a/pkg'), 1)
		deletePackageFiles(sql, '@a/pkg')
		assert.deepEqual(readPackageFiles(sql, '@a/pkg'), {})
		assert.equal(countPackageFiles(sql, '@a/pkg'), 0)
	})

	it('migrates user packages off files_json and refuses a second dual-read path', () => {
		const sql = memorySql()
		sql.exec(`
			CREATE TABLE packages (
				name TEXT PRIMARY KEY,
				version TEXT NOT NULL,
				manifest_json TEXT NOT NULL,
				files_json TEXT NOT NULL,
				source TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`)
		sql.exec(
			`INSERT INTO packages (name, version, manifest_json, files_json, source, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			'@a/old',
			'1.0.0',
			'{"name":"@a/old","version":"1.0.0"}',
			JSON.stringify({ 'package.json': '{"name":"@a/old"}', 'README.md': '# old' }),
			'local',
			'2024-01-01T00:00:00.000Z',
			'2024-01-02T00:00:00.000Z',
		)
		migrateUserPackageFiles(sql)
		assert.ok(!columnsOf(sql, 'packages').includes('files_json'))
		assert.deepEqual(readPackageFiles(sql, '@a/old'), {
			'package.json': '{"name":"@a/old"}',
			'README.md': '# old',
		})
		const row = sql
			.exec<{ name: string; version: string; source: string }>(
				'SELECT name, version, source FROM packages WHERE name = ?',
				'@a/old',
			)
			.toArray()[0]
		assert.equal(row?.name, '@a/old')
		assert.equal(row?.version, '1.0.0')
		assert.equal(row?.source, 'local')
		// Idempotent: running again leaves the post-migration shape alone.
		migrateUserPackageFiles(sql)
		assert.ok(!columnsOf(sql, 'packages').includes('files_json'))
		assert.deepEqual(readPackageFiles(sql, '@a/old'), {
			'package.json': '{"name":"@a/old"}',
			'README.md': '# old',
		})
	})

	it('migrates community packages and rebuilds indexes', () => {
		const sql = memorySql()
		sql.exec(`
			CREATE TABLE community_packages (
				name TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				publisher TEXT NOT NULL,
				version TEXT NOT NULL,
				description TEXT NOT NULL,
				keywords TEXT NOT NULL,
				manifest_json TEXT NOT NULL,
				files_json TEXT NOT NULL,
				installs INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`)
		sql.exec(
			`INSERT INTO community_packages
				(name, user_id, publisher, version, description, keywords, manifest_json, files_json, installs, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)`,
			'@a/pub',
			'alice',
			'alice',
			'1.0.0',
			'desc',
			'kw',
			'{}',
			JSON.stringify({ 'README.md': '# pub', 'AGENTS.md': 'agents' }),
			'2024-01-01T00:00:00.000Z',
			'2024-01-02T00:00:00.000Z',
		)
		migrateCommunityPackageFiles(sql)
		assert.ok(!columnsOf(sql, 'community_packages').includes('files_json'))
		assert.deepEqual(readPackageFiles(sql, '@a/pub'), { 'README.md': '# pub', 'AGENTS.md': 'agents' })
		assert.equal(
			sql.exec<{ installs: number }>('SELECT installs FROM community_packages WHERE name = ?', '@a/pub').toArray()[0]
				?.installs,
			3,
		)
	})

	it('fails loudly on corrupt files_json during migration', () => {
		const sql = memorySql()
		sql.exec(`
			CREATE TABLE packages (
				name TEXT PRIMARY KEY,
				version TEXT NOT NULL,
				manifest_json TEXT NOT NULL,
				files_json TEXT NOT NULL,
				source TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`)
		sql.exec(
			`INSERT INTO packages (name, version, manifest_json, files_json, source, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			'@a/bad',
			'1.0.0',
			'{}',
			'{not-json',
			'local',
			'2024-01-01T00:00:00.000Z',
			'2024-01-01T00:00:00.000Z',
		)
		assert.throws(
			() => migrateUserPackageFiles(sql),
			(error: unknown) => {
				assert.ok(error instanceof KodyError)
				assert.match(error.message, /Corrupt files_json for package "@a\/bad"/)
				return true
			},
		)
	})

	it('fresh schema has no files_json and migration is a no-op', () => {
		const sql = memorySql()
		sql.exec(userPackagesTableDdl)
		sql.exec(packageFilesSchema)
		migrateUserPackageFiles(sql)
		assert.ok(!columnsOf(sql, 'packages').includes('files_json'))
		assert.deepEqual(columnsOf(sql, 'package_files').sort(), ['content', 'package_name', 'path'])
	})

	it('assertPackageTotalBytes names the 4 MiB limit', () => {
		assertPackageTotalBytes(maxPackageTotalBytes)
		assert.throws(
			() => assertPackageTotalBytes(maxPackageTotalBytes + 1),
			(error: unknown) => {
				assert.ok(error instanceof KodyError)
				assert.equal(error.code, 'invalid_package')
				assert.match(error.message, /at most 4 MiB/)
				assert.match(error.message, /limit is 4 MiB/)
				return true
			},
		)
	})
})
