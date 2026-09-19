import { KodyError } from '../lib/errors.ts'
import type { PackageFiles, PackageManifest } from './manifest.ts'

/**
 * Community catalog: packages users chose to publish for everyone on this
 * install. Lives in the RegistryCell (fleet-wide) so search and install work
 * across users. A published listing is a *copy* of the files at publish time —
 * the publisher's private edits stay private until they publish again.
 * Names are first-come: only the original publisher may republish or unpublish.
 */

export type CommunityListing = {
	name: string
	version: string
	description: string
	publisher: string
	keywords: Array<string>
	manifest: PackageManifest
	readme: string
	installs: number
	fileCount: number
	publishedAt: string
	updatedAt: string
}

export type CommunityPackage = CommunityListing & { files: PackageFiles; agents: string }

export const communitySchema = `
	CREATE TABLE IF NOT EXISTS community_packages (
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
	CREATE INDEX IF NOT EXISTS community_packages_user ON community_packages(user_id);
	CREATE INDEX IF NOT EXISTS community_packages_installs ON community_packages(installs DESC, updated_at DESC);
`

export const communityLimits = {
	maxPerUser: 100,
	maxSearchResults: 50,
	maxPublisherLength: 40,
}

export const publisherPattern = /^[a-z0-9][a-z0-9._-]{0,39}$/

type Row = {
	name: string
	user_id: string
	publisher: string
	version: string
	description: string
	keywords: string
	manifest_json: string
	files_json: string
	installs: number
	created_at: string
	updated_at: string
}

const summaryColumns =
	'name, user_id, publisher, version, description, keywords, manifest_json, files_json, installs, created_at, updated_at'

function toListing(row: Row): CommunityListing & { userId: string } {
	const files = JSON.parse(row.files_json) as PackageFiles
	return {
		name: row.name,
		userId: row.user_id,
		version: row.version,
		description: row.description,
		publisher: row.publisher,
		keywords: row.keywords ? row.keywords.split(' ') : [],
		manifest: JSON.parse(row.manifest_json) as PackageManifest,
		readme: files['README.md'] ?? '',
		installs: row.installs,
		fileCount: Object.keys(files).length,
		publishedAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function toPackage(row: Row): CommunityPackage & { userId: string } {
	const files = JSON.parse(row.files_json) as PackageFiles
	return { ...toListing(row), files, agents: files['AGENTS.md'] ?? '' }
}

export class CommunityStore {
	private readonly sql: SqlStorage
	private readonly now: () => string

	constructor(sql: SqlStorage, now: () => string = () => new Date().toISOString()) {
		this.sql = sql
		this.now = now
	}

	publish(input: {
		userId: string
		publisher: string
		name: string
		version: string
		manifest: PackageManifest
		files: PackageFiles
	}): CommunityListing {
		if (!publisherPattern.test(input.publisher)) {
			throw new KodyError(
				'invalid_args',
				`publisher must be 1-${communityLimits.maxPublisherLength} chars of a-z, 0-9, ".", "_" or "-".`,
			)
		}
		if (input.manifest.hidden) {
			throw new KodyError('invalid_package', `"${input.name}" is marked hidden in package.json; unhide it to publish.`)
		}
		const existing = this.sql
			.exec<{ user_id: string }>('SELECT user_id FROM community_packages WHERE name = ?', input.name)
			.toArray()[0]
		if (existing && existing.user_id !== input.userId) {
			throw new KodyError('community_name_taken', `"${input.name}" is already published by someone else.`, {
				status: 409,
			})
		}
		if (!existing) {
			const count =
				this.sql
					.exec<{ n: number }>('SELECT COUNT(*) AS n FROM community_packages WHERE user_id = ?', input.userId)
					.toArray()[0]?.n ?? 0
			if (count >= communityLimits.maxPerUser) {
				throw new KodyError('quota_exceeded', `You already publish ${communityLimits.maxPerUser} packages.`, {
					status: 429,
				})
			}
		}
		const now = this.now()
		this.sql.exec(
			`INSERT INTO community_packages
				(name, user_id, publisher, version, description, keywords, manifest_json, files_json, installs, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
			 ON CONFLICT(name) DO UPDATE SET
				publisher = excluded.publisher, version = excluded.version, description = excluded.description,
				keywords = excluded.keywords, manifest_json = excluded.manifest_json, files_json = excluded.files_json,
				updated_at = excluded.updated_at`,
			input.name,
			input.userId,
			input.publisher,
			input.version,
			input.manifest.description,
			input.manifest.keywords.join(' '),
			JSON.stringify(input.manifest),
			JSON.stringify(input.files),
			now,
			now,
		)
		return this.get(input.name)!
	}

	unpublish(input: { userId: string; name: string }): boolean {
		const row = this.sql
			.exec<{ user_id: string }>('SELECT user_id FROM community_packages WHERE name = ?', input.name)
			.toArray()[0]
		if (!row) return false
		if (row.user_id !== input.userId) {
			throw new KodyError('forbidden', `"${input.name}" was published by someone else.`, { status: 403 })
		}
		this.sql.exec('DELETE FROM community_packages WHERE name = ?', input.name)
		return true
	}

	unpublishAll(userId: string): number {
		const count = this.sql
			.exec<{ n: number }>('SELECT COUNT(*) AS n FROM community_packages WHERE user_id = ?', userId)
			.toArray()[0]?.n
		this.sql.exec('DELETE FROM community_packages WHERE user_id = ?', userId)
		return count ?? 0
	}

	get(name: string): CommunityPackage | null {
		const row = this.sql.exec<Row>(`SELECT ${summaryColumns} FROM community_packages WHERE name = ?`, name).toArray()[0]
		if (!row) return null
		const { userId: _userId, ...pkg } = toPackage(row)
		return pkg
	}

	/** Which user owns a listing (never exposed publicly; used for publish controls). */
	ownerOf(name: string): string | null {
		return (
			this.sql.exec<{ user_id: string }>('SELECT user_id FROM community_packages WHERE name = ?', name).toArray()[0]
				?.user_id ?? null
		)
	}

	search(input: { query?: string | undefined; limit?: number | undefined }): Array<CommunityListing> {
		const limit = Math.min(Math.max(1, input.limit ?? 20), communityLimits.maxSearchResults)
		const terms = (input.query ?? '')
			.toLowerCase()
			.split(/\s+/)
			.map((t) => t.trim())
			.filter(Boolean)
			.slice(0, 8)
		const where = terms
			.map(
				() =>
					"(lower(name) LIKE ? ESCAPE '\\' OR lower(description) LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')",
			)
			.join(' AND ')
		const params = terms.flatMap((term) => {
			const like = `%${term.replaceAll(/[%_\\]/g, (c) => `\\${c}`)}%`
			return [like, like, like]
		})
		const rows = this.sql
			.exec<Row>(
				`SELECT ${summaryColumns} FROM community_packages ${where ? `WHERE ${where}` : ''}
				 ORDER BY installs DESC, updated_at DESC LIMIT ?`,
				...params,
				limit,
			)
			.toArray()
		return rows.map((row) => {
			const { userId: _userId, ...listing } = toListing(row)
			return listing
		})
	}

	listByUser(userId: string): Array<CommunityListing> {
		return this.sql
			.exec<Row>(`SELECT ${summaryColumns} FROM community_packages WHERE user_id = ? ORDER BY name`, userId)
			.toArray()
			.map((row) => {
				const { userId: _userId, ...listing } = toListing(row)
				return listing
			})
	}

	recordInstall(name: string) {
		this.sql.exec('UPDATE community_packages SET installs = installs + 1 WHERE name = ?', name)
	}

	stats() {
		const row = this.sql
			.exec<{ packages: number; publishers: number; installs: number }>(
				'SELECT COUNT(*) AS packages, COUNT(DISTINCT user_id) AS publishers, COALESCE(SUM(installs), 0) AS installs FROM community_packages',
			)
			.toArray()[0]
		return row ?? { packages: 0, publishers: 0, installs: 0 }
	}
}
