import { KodyError } from '../lib/errors.ts'
import type { PackageFiles } from './manifest.ts'

/** Documented packageSave / install total size cap. */
export const maxPackageTotalBytes = 4 * 1024 * 1024

export const packageFilesSchema = `
	CREATE TABLE IF NOT EXISTS package_files (
		package_name TEXT NOT NULL,
		path TEXT NOT NULL,
		content TEXT NOT NULL,
		PRIMARY KEY (package_name, path)
	);
`

/** UserCell `packages` table after the files_json → package_files migration. */
export const userPackagesTableDdl = `
	CREATE TABLE IF NOT EXISTS packages (
		name TEXT PRIMARY KEY,
		version TEXT NOT NULL,
		manifest_json TEXT NOT NULL,
		source TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
`

/** RegistryCell `community_packages` table after the same migration. */
export const communityPackagesTableDdl = `
	CREATE TABLE IF NOT EXISTS community_packages (
		name TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		publisher TEXT NOT NULL,
		version TEXT NOT NULL,
		description TEXT NOT NULL,
		keywords TEXT NOT NULL,
		manifest_json TEXT NOT NULL,
		installs INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
`

export const communityPackagesIndexesDdl = `
	CREATE INDEX IF NOT EXISTS community_packages_user ON community_packages(user_id);
	CREATE INDEX IF NOT EXISTS community_packages_installs ON community_packages(installs DESC, updated_at DESC);
`

/**
 * One-time migration: move each package's `files_json` blob into per-file
 * `package_files` rows, then rebuild the parent table without that column.
 * Idempotent — a second call is a no-op once `files_json` is gone.
 * Corrupt `files_json` fails loudly; there is no dual-read fallback.
 */
export function migrateUserPackageFiles(sql: SqlStorage) {
	sql.exec(packageFilesSchema)
	dropFilesJsonColumn(sql, {
		table: 'packages',
		keepColumns: ['name', 'version', 'manifest_json', 'source', 'created_at', 'updated_at'],
		createWithoutFilesJson: `
			CREATE TABLE packages__nofiles (
				name TEXT PRIMARY KEY,
				version TEXT NOT NULL,
				manifest_json TEXT NOT NULL,
				source TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`,
	})
}

export function migrateCommunityPackageFiles(sql: SqlStorage) {
	sql.exec(packageFilesSchema)
	dropFilesJsonColumn(sql, {
		table: 'community_packages',
		keepColumns: [
			'name',
			'user_id',
			'publisher',
			'version',
			'description',
			'keywords',
			'manifest_json',
			'installs',
			'created_at',
			'updated_at',
		],
		createWithoutFilesJson: `
			CREATE TABLE community_packages__nofiles (
				name TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				publisher TEXT NOT NULL,
				version TEXT NOT NULL,
				description TEXT NOT NULL,
				keywords TEXT NOT NULL,
				manifest_json TEXT NOT NULL,
				installs INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`,
		afterRename: () => {
			sql.exec(communityPackagesIndexesDdl)
		},
	})
}

function dropFilesJsonColumn(
	sql: SqlStorage,
	meta: {
		table: 'packages' | 'community_packages'
		keepColumns: ReadonlyArray<string>
		createWithoutFilesJson: string
		afterRename?: () => void
	},
) {
	const columns = sql
		.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${meta.table}')`)
		.toArray()
		.map((row) => row.name)
	if (columns.length === 0) return
	if (!columns.includes('files_json')) return
	for (const name of meta.keepColumns) {
		if (!columns.includes(name)) {
			throw new KodyError('internal_error', `${meta.table} is missing column "${name}" for package-files migration.`, {
				status: 500,
			})
		}
	}

	const rows = sql.exec<{ name: string; files_json: string }>(`SELECT name, files_json FROM ${meta.table}`).toArray()
	for (const row of rows) {
		replacePackageFiles(sql, row.name, parseFilesJson(row.name, row.files_json))
	}

	const staging = `${meta.table}__nofiles`
	const keepList = meta.keepColumns.join(', ')
	sql.exec(`DROP TABLE IF EXISTS ${staging}`)
	sql.exec(meta.createWithoutFilesJson)
	sql.exec(`INSERT INTO ${staging} (${keepList}) SELECT ${keepList} FROM ${meta.table}`)
	sql.exec(`DROP TABLE ${meta.table}`)
	sql.exec(`ALTER TABLE ${staging} RENAME TO ${meta.table}`)
	meta.afterRename?.()
}

function parseFilesJson(packageName: string, filesJson: string): PackageFiles {
	let parsed: unknown
	try {
		parsed = JSON.parse(filesJson)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new KodyError(
			'internal_error',
			`Corrupt files_json for package "${packageName}" during migration: ${detail}`,
			{ status: 500 },
		)
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new KodyError(
			'internal_error',
			`Corrupt files_json for package "${packageName}" during migration: expected a path→content object.`,
			{ status: 500 },
		)
	}
	const files: PackageFiles = {}
	for (const [path, content] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof content !== 'string') {
			throw new KodyError(
				'internal_error',
				`Corrupt files_json for package "${packageName}": file "${path}" is not a string.`,
				{ status: 500 },
			)
		}
		files[path] = content
	}
	return files
}

/** Enforce the documented 4 MiB total. */
export function assertPackageTotalBytes(totalBytes: number) {
	if (totalBytes > maxPackageTotalBytes) {
		throw new KodyError(
			'invalid_package',
			`Package files must total at most 4 MiB (got ${formatMiB(totalBytes)}; limit is 4 MiB).`,
		)
	}
}

function formatMiB(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/** Replace every file row for a package (delete-then-insert). */
export function replacePackageFiles(sql: SqlStorage, packageName: string, files: PackageFiles) {
	sql.exec('DELETE FROM package_files WHERE package_name = ?', packageName)
	for (const [path, content] of Object.entries(files)) {
		sql.exec('INSERT INTO package_files (package_name, path, content) VALUES (?, ?, ?)', packageName, path, content)
	}
}

export function readPackageFiles(sql: SqlStorage, packageName: string): PackageFiles {
	const rows = sql
		.exec<{ path: string; content: string }>(
			'SELECT path, content FROM package_files WHERE package_name = ? ORDER BY path',
			packageName,
		)
		.toArray()
	const files: PackageFiles = {}
	for (const row of rows) {
		if (typeof row.content !== 'string') {
			throw new KodyError('internal_error', `Corrupt package_files row for "${packageName}" at "${row.path}".`, {
				status: 500,
			})
		}
		files[row.path] = row.content
	}
	return files
}

export function countPackageFiles(sql: SqlStorage, packageName: string): number {
	return (
		sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM package_files WHERE package_name = ?', packageName).toArray()[0]
			?.n ?? 0
	)
}

export function deletePackageFiles(sql: SqlStorage, packageName: string) {
	sql.exec('DELETE FROM package_files WHERE package_name = ?', packageName)
}
