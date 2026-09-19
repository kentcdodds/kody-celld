import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.ts'
import { computeNextRun, validateSchedule } from '../jobs/schedule.ts'
import {
	buildMasterKeyring,
	decryptWithKeyring,
	encryptSecretValue,
	randomId,
	type MasterKeyring,
} from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { parsePackageManifest, type PackageFiles, type PackageManifest } from '../packages/manifest.ts'
import { normalizeSecretHost } from '../secrets/host-policy.ts'
import type { SecretScope } from '../secrets/placeholders.ts'

export type SecretMetadata = {
	name: string
	scope: SecretScope
	packageName: string | null
	description: string | null
	createdAt: string
	updatedAt: string
}

export type SecretHostApproval = { host: string; approvedAt: string; approvedBy: string }

export type SavedPackage = {
	name: string
	version: string
	manifest: PackageManifest
	files: PackageFiles
	source: string
	createdAt: string
	updatedAt: string
}

export type PackageSummary = Omit<SavedPackage, 'files'> & { fileCount: number }

export type JobRecord = {
	id: string
	packageName: string
	jobName: string
	entry: string
	schedule: PackageManifest['jobs'][string]['schedule']
	timezone: string | null
	description: string | null
	enabled: boolean
	nextRunAt: string | null
	lastRunAt: string | null
	lastStatus: string | null
	lastError: string | null
	createdAt: string
	updatedAt: string
}

export type JobRunRecord = {
	id: string
	jobId: string
	trigger: string
	startedAt: string
	finishedAt: string | null
	status: 'running' | 'success' | 'error'
	resultJson: string | null
	error: string | null
	logsJson: string
}

export type RunRecord = {
	id: string
	kind: 'execute' | 'package' | 'job'
	packageName: string | null
	idempotencyKey: string | null
	status: 'running' | 'success' | 'error'
	createdAt: string
	finishedAt: string | null
	durationMs: number | null
	resultJson: string | null
	error: { name: string; message: string } | null
	logsJson: string
	warnings: Array<string>
	gateway: Array<GatewayEvent>
}

export type GatewayEvent = {
	at: string
	method: string
	url: string
	host: string
	outcome: 'forwarded' | 'injected' | 'denied' | 'error'
	status: number | null
	secrets: Array<string>
	reason?: string
}

const secretNamePattern = /^[a-zA-Z0-9._-]+$/

function nowIso() {
	return new Date().toISOString()
}

/**
 * Everything one user owns: secrets, secret-host approvals, saved packages,
 * package-owned jobs, and run history. One SQLite cell per user id.
 */
export class UserCell extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS secrets (
				name TEXT NOT NULL,
				scope TEXT NOT NULL,
				package_name TEXT NOT NULL DEFAULT '',
				description TEXT,
				iv TEXT NOT NULL,
				ciphertext TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (name, scope, package_name)
			);
			CREATE TABLE IF NOT EXISTS secret_hosts (
				host TEXT PRIMARY KEY,
				approved_at TEXT NOT NULL,
				approved_by TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS packages (
				name TEXT PRIMARY KEY,
				version TEXT NOT NULL,
				manifest_json TEXT NOT NULL,
				files_json TEXT NOT NULL,
				source TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY,
				package_name TEXT NOT NULL,
				job_name TEXT NOT NULL,
				entry TEXT NOT NULL,
				schedule_json TEXT NOT NULL,
				timezone TEXT,
				description TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				next_run_at TEXT,
				last_run_at TEXT,
				last_status TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS jobs_due ON jobs(enabled, next_run_at);
			CREATE TABLE IF NOT EXISTS job_runs (
				id TEXT PRIMARY KEY,
				job_id TEXT NOT NULL,
				trigger TEXT NOT NULL,
				started_at TEXT NOT NULL,
				finished_at TEXT,
				status TEXT NOT NULL,
				result_json TEXT,
				error TEXT,
				logs_json TEXT NOT NULL DEFAULT '[]'
			);
			CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job_id, started_at DESC);
			CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				package_name TEXT,
				idempotency_key TEXT,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				finished_at TEXT,
				duration_ms INTEGER,
				result_json TEXT,
				error_json TEXT,
				logs_json TEXT NOT NULL DEFAULT '[]',
				warnings_json TEXT NOT NULL DEFAULT '[]',
				gateway_json TEXT NOT NULL DEFAULT '[]'
			);
			CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
			CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC);
		`)
		const secretColumns = this.ctx.storage.sql
			.exec<{ name: string }>(`SELECT name FROM pragma_table_info('secrets')`)
			.toArray()
			.map((row) => row.name)
		if (!secretColumns.includes('key_id')) {
			this.ctx.storage.sql.exec(`ALTER TABLE secrets ADD COLUMN key_id TEXT NOT NULL DEFAULT ''`)
		}
	}

	private keyringPromise: Promise<MasterKeyring> | undefined
	private keyring() {
		this.keyringPromise ??= buildMasterKeyring(this.env.KODY_MASTER_KEY, this.env.KODY_MASTER_KEY_PREVIOUS)
		return this.keyringPromise
	}

	private get userId() {
		const row = this.ctx.storage.sql
			.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'user_id'`)
			.toArray()[0]
		if (!row) throw new KodyError('cell_uninitialized', 'UserCell has no user id yet.', { status: 500 })
		return row.value
	}

	async init(userId: string) {
		this.ctx.storage.sql.exec(`INSERT INTO meta (key, value) VALUES ('user_id', ?) ON CONFLICT(key) DO NOTHING`, userId)
	}

	// ---------------------------------------------------------------- secrets

	async secretSave(input: {
		name: string
		value: string
		description?: string | undefined
		scope?: SecretScope | undefined
		packageName?: string | undefined
	}): Promise<SecretMetadata> {
		const name = input.name?.trim()
		if (!name || !secretNamePattern.test(name)) {
			throw new KodyError('invalid_secret_name', 'Secret names may contain letters, digits, ".", "_", and "-".')
		}
		if (typeof input.value !== 'string' || input.value.length === 0) {
			throw new KodyError('invalid_secret_value', 'Secret value must be a non-empty string.')
		}
		if (input.value.length > 64 * 1024) {
			throw new KodyError('invalid_secret_value', 'Secret value must be at most 64 KiB.')
		}
		const scope: SecretScope = input.scope ?? 'user'
		const packageName = scope === 'package' ? (input.packageName ?? '') : ''
		if (scope === 'package' && !packageName) {
			throw new KodyError('invalid_secret_scope', 'Package-scoped secrets need a package name.')
		}
		const { current } = await this.keyring()
		const encrypted = await encryptSecretValue(current.key, this.userId, input.value)
		const now = nowIso()
		this.ctx.storage.sql.exec(
			`INSERT INTO secrets (name, scope, package_name, description, iv, ciphertext, key_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(name, scope, package_name) DO UPDATE SET
			   description = COALESCE(excluded.description, secrets.description),
			   iv = excluded.iv, ciphertext = excluded.ciphertext, key_id = excluded.key_id, updated_at = excluded.updated_at`,
			name,
			scope,
			packageName,
			input.description ?? null,
			encrypted.iv,
			encrypted.ciphertext,
			current.id,
			now,
			now,
		)
		const saved = (await this.secretList()).find(
			(s) => s.name === name && s.scope === scope && (s.packageName ?? '') === packageName,
		)
		if (!saved) throw new KodyError('internal_error', 'Secret save failed.', { status: 500 })
		return saved
	}

	async secretList(): Promise<Array<SecretMetadata>> {
		return this.ctx.storage.sql
			.exec<{
				name: string
				scope: SecretScope
				package_name: string
				description: string | null
				created_at: string
				updated_at: string
			}>(`SELECT name, scope, package_name, description, created_at, updated_at FROM secrets ORDER BY name`)
			.toArray()
			.map((row) => ({
				name: row.name,
				scope: row.scope,
				packageName: row.package_name || null,
				description: row.description,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}))
	}

	async secretDelete(input: { name: string; scope?: SecretScope | undefined; packageName?: string | undefined }) {
		const scope = input.scope ?? 'user'
		const cursor = this.ctx.storage.sql.exec(
			'DELETE FROM secrets WHERE name = ? AND scope = ? AND package_name = ?',
			input.name,
			scope,
			scope === 'package' ? (input.packageName ?? '') : '',
		)
		return { deleted: cursor.rowsWritten > 0 }
	}

	/**
	 * Decrypts secret values for the fetch gateway. Package-scoped secrets are
	 * only visible to runs of that package; user-scoped ones to every run of
	 * this user. Missing names are reported instead of throwing so the gateway
	 * can build one useful error.
	 */
	async secretResolveValues(input: {
		names: Array<{ name: string; scope: SecretScope | null }>
		packageName: string | null
	}): Promise<{ values: Record<string, string>; missing: Array<string> }> {
		const values: Record<string, string> = {}
		const missing: Array<string> = []
		for (const ref of input.names) {
			const candidates = this.ctx.storage.sql
				.exec<{ scope: SecretScope; package_name: string; iv: string; ciphertext: string; key_id: string }>(
					'SELECT scope, package_name, iv, ciphertext, key_id FROM secrets WHERE name = ?',
					ref.name,
				)
				.toArray()
			const match = candidates.find((row) => {
				if (ref.scope && row.scope !== ref.scope) return false
				if (row.scope === 'package') return input.packageName !== null && row.package_name === input.packageName
				return true
			})
			if (!match) {
				missing.push(ref.name)
				continue
			}
			values[ref.name] = await decryptWithKeyring(await this.keyring(), this.userId, {
				iv: match.iv,
				ciphertext: match.ciphertext,
				keyId: match.key_id || undefined,
			})
		}
		return { values, missing }
	}

	/**
	 * Re-seals every secret not already sealed with the current master key.
	 * Run after adding a new KODY_MASTER_KEY (with the old one in
	 * KODY_MASTER_KEY_PREVIOUS); once it reports zero remaining, the previous
	 * key can be dropped from the configuration.
	 */
	async secretRekey(): Promise<{ resealed: number; remaining: number; currentKeyId: string }> {
		const keyring = await this.keyring()
		const rows = this.ctx.storage.sql
			.exec<{ name: string; scope: string; package_name: string; iv: string; ciphertext: string; key_id: string }>(
				'SELECT name, scope, package_name, iv, ciphertext, key_id FROM secrets WHERE key_id != ?',
				keyring.current.id,
			)
			.toArray()
		let resealed = 0
		for (const row of rows) {
			let plaintext: string
			try {
				plaintext = await decryptWithKeyring(keyring, this.userId, {
					iv: row.iv,
					ciphertext: row.ciphertext,
					keyId: row.key_id || undefined,
				})
			} catch (error) {
				console.error(
					`secretRekey: cannot decrypt ${row.scope} secret "${row.name}" (key ${row.key_id || 'legacy'}):`,
					error instanceof Error ? error.message : error,
				)
				continue
			}
			const sealed = await encryptSecretValue(keyring.current.key, this.userId, plaintext)
			this.ctx.storage.sql.exec(
				'UPDATE secrets SET iv = ?, ciphertext = ?, key_id = ? WHERE name = ? AND scope = ? AND package_name = ?',
				sealed.iv,
				sealed.ciphertext,
				keyring.current.id,
				row.name,
				row.scope,
				row.package_name,
			)
			resealed++
		}
		const remaining = this.ctx.storage.sql
			.exec<{ c: number }>('SELECT count(*) AS c FROM secrets WHERE key_id != ?', keyring.current.id)
			.toArray()[0]
		return { resealed, remaining: remaining?.c ?? 0, currentKeyId: keyring.current.id }
	}

	// ----------------------------------------------------------- secret hosts

	async secretHostApprove(input: { host: string; approvedBy: string }): Promise<SecretHostApproval> {
		const host = normalizeSecretHost(input.host)
		const now = nowIso()
		this.ctx.storage.sql.exec(
			`INSERT INTO secret_hosts (host, approved_at, approved_by) VALUES (?, ?, ?)
			 ON CONFLICT(host) DO UPDATE SET approved_at = excluded.approved_at, approved_by = excluded.approved_by`,
			host,
			now,
			input.approvedBy,
		)
		return { host, approvedAt: now, approvedBy: input.approvedBy }
	}

	async secretHostRevoke(input: { host: string }) {
		const host = normalizeSecretHost(input.host)
		const cursor = this.ctx.storage.sql.exec('DELETE FROM secret_hosts WHERE host = ?', host)
		return { host, revoked: cursor.rowsWritten > 0 }
	}

	async secretHostList(): Promise<Array<SecretHostApproval>> {
		return this.ctx.storage.sql
			.exec<{ host: string; approved_at: string; approved_by: string }>(
				'SELECT host, approved_at, approved_by FROM secret_hosts ORDER BY host',
			)
			.toArray()
			.map((row) => ({ host: row.host, approvedAt: row.approved_at, approvedBy: row.approved_by }))
	}

	// --------------------------------------------------------------- packages

	async packageSave(input: { files: PackageFiles; source?: string | undefined }): Promise<PackageSummary> {
		const files: PackageFiles = {}
		let totalBytes = 0
		for (const [path, content] of Object.entries(input.files ?? {})) {
			if (typeof content !== 'string') {
				throw new KodyError('invalid_package', `File "${path}" must be a string.`)
			}
			totalBytes += content.length
			files[path.replace(/^\.\//, '')] = content
		}
		if (totalBytes > 4 * 1024 * 1024) {
			throw new KodyError('invalid_package', 'Package files must total at most 4 MiB.')
		}
		const manifest = parsePackageManifest(files)
		for (const [jobName, job] of Object.entries(manifest.jobs)) {
			try {
				validateSchedule(job.schedule, job.timezone)
			} catch (error) {
				if (error instanceof KodyError) {
					throw new KodyError(error.code, `kody.jobs.${jobName}: ${error.message}`)
				}
				throw error
			}
		}
		const now = nowIso()
		const existing = this.ctx.storage.sql
			.exec<{ created_at: string }>('SELECT created_at FROM packages WHERE name = ?', manifest.name)
			.toArray()[0]
		this.ctx.storage.sql.exec(
			`INSERT INTO packages (name, version, manifest_json, files_json, source, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(name) DO UPDATE SET version = excluded.version, manifest_json = excluded.manifest_json,
			   files_json = excluded.files_json, source = excluded.source, updated_at = excluded.updated_at`,
			manifest.name,
			manifest.version,
			JSON.stringify(manifest),
			JSON.stringify(files),
			input.source ?? 'local',
			existing?.created_at ?? now,
			now,
		)
		this.reconcileJobs(manifest, now)
		return {
			name: manifest.name,
			version: manifest.version,
			manifest,
			source: input.source ?? 'local',
			createdAt: existing?.created_at ?? now,
			updatedAt: now,
			fileCount: Object.keys(files).length,
		}
	}

	private reconcileJobs(manifest: PackageManifest, now: string) {
		const declared = new Set(Object.keys(manifest.jobs))
		const existingRows = this.ctx.storage.sql
			.exec<{ id: string; job_name: string; enabled: number; last_run_at: string | null }>(
				'SELECT id, job_name, enabled, last_run_at FROM jobs WHERE package_name = ?',
				manifest.name,
			)
			.toArray()
		for (const row of existingRows) {
			if (!declared.has(row.job_name)) {
				this.ctx.storage.sql.exec('DELETE FROM jobs WHERE id = ?', row.id)
			}
		}
		for (const [jobName, job] of Object.entries(manifest.jobs)) {
			const id = `${manifest.name}#${jobName}`
			const existing = existingRows.find((row) => row.job_name === jobName)
			// Manifest `enabled` is the create-time default; it can turn an
			// existing job on but never off (matches Kody's documented behavior).
			const enabled = existing
				? existing.enabled === 1 || job.enabled === true
					? 1
					: 0
				: job.enabled === false
					? 0
					: 1
			const nextRun = computeNextRun(job.schedule, {
				now: new Date(now),
				timezone: job.timezone,
				lastRunAt: existing?.last_run_at ? new Date(existing.last_run_at) : null,
			})
			this.ctx.storage.sql.exec(
				`INSERT INTO jobs (id, package_name, job_name, entry, schedule_json, timezone, description, enabled, next_run_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET entry = excluded.entry, schedule_json = excluded.schedule_json,
				   timezone = excluded.timezone, description = excluded.description, enabled = excluded.enabled,
				   next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`,
				id,
				manifest.name,
				jobName,
				job.entry,
				JSON.stringify(job.schedule),
				job.timezone ?? null,
				job.description ?? null,
				enabled,
				nextRun?.toISOString() ?? null,
				now,
				now,
			)
		}
	}

	async packageList(): Promise<Array<PackageSummary>> {
		return this.ctx.storage.sql
			.exec<{
				name: string
				version: string
				manifest_json: string
				files_json: string
				source: string
				created_at: string
				updated_at: string
			}>('SELECT * FROM packages ORDER BY name')
			.toArray()
			.map((row) => ({
				name: row.name,
				version: row.version,
				manifest: JSON.parse(row.manifest_json) as PackageManifest,
				source: row.source,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				fileCount: Object.keys(JSON.parse(row.files_json) as PackageFiles).length,
			}))
	}

	async packageGet(name: string): Promise<SavedPackage | null> {
		const row = this.ctx.storage.sql
			.exec<{
				name: string
				version: string
				manifest_json: string
				files_json: string
				source: string
				created_at: string
				updated_at: string
			}>('SELECT * FROM packages WHERE name = ?', name)
			.toArray()[0]
		if (!row) return null
		return {
			name: row.name,
			version: row.version,
			manifest: JSON.parse(row.manifest_json) as PackageManifest,
			files: JSON.parse(row.files_json) as PackageFiles,
			source: row.source,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}
	}

	async packageDelete(name: string) {
		const cursor = this.ctx.storage.sql.exec('DELETE FROM packages WHERE name = ?', name)
		this.ctx.storage.sql.exec('DELETE FROM jobs WHERE package_name = ?', name)
		this.ctx.storage.sql.exec('DELETE FROM secrets WHERE scope = ? AND package_name = ?', 'package', name)
		return { deleted: cursor.rowsWritten > 0 }
	}

	// ------------------------------------------------------------------- jobs

	private rowToJob(row: {
		id: string
		package_name: string
		job_name: string
		entry: string
		schedule_json: string
		timezone: string | null
		description: string | null
		enabled: number
		next_run_at: string | null
		last_run_at: string | null
		last_status: string | null
		last_error: string | null
		created_at: string
		updated_at: string
	}): JobRecord {
		return {
			id: row.id,
			packageName: row.package_name,
			jobName: row.job_name,
			entry: row.entry,
			schedule: JSON.parse(row.schedule_json) as JobRecord['schedule'],
			timezone: row.timezone,
			description: row.description,
			enabled: row.enabled === 1,
			nextRunAt: row.next_run_at,
			lastRunAt: row.last_run_at,
			lastStatus: row.last_status,
			lastError: row.last_error,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}
	}

	async jobList(filter: { packageName?: string | undefined } = {}): Promise<Array<JobRecord>> {
		const rows = filter.packageName
			? this.ctx.storage.sql.exec('SELECT * FROM jobs WHERE package_name = ? ORDER BY id', filter.packageName)
			: this.ctx.storage.sql.exec('SELECT * FROM jobs ORDER BY id')
		return (rows.toArray() as Array<Parameters<UserCell['rowToJob']>[0]>).map((row) => this.rowToJob(row))
	}

	async jobGet(id: string): Promise<JobRecord | null> {
		const row = this.ctx.storage.sql.exec('SELECT * FROM jobs WHERE id = ?', id).toArray()[0]
		return row ? this.rowToJob(row as Parameters<UserCell['rowToJob']>[0]) : null
	}

	async jobUpdate(input: { id: string; enabled?: boolean | undefined }) {
		const job = await this.jobGet(input.id)
		if (!job) throw new KodyError('job_not_found', `Job "${input.id}" was not found.`, { status: 404 })
		const now = new Date()
		if (input.enabled !== undefined) {
			const nextRun = input.enabled
				? computeNextRun(job.schedule, {
						now,
						timezone: job.timezone ?? undefined,
						lastRunAt: job.lastRunAt ? new Date(job.lastRunAt) : null,
					})
				: null
			this.ctx.storage.sql.exec(
				'UPDATE jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
				input.enabled ? 1 : 0,
				nextRun?.toISOString() ?? null,
				now.toISOString(),
				input.id,
			)
		}
		return (await this.jobGet(input.id))!
	}

	/** Claims every enabled job whose next_run_at is due and advances its schedule. */
	async jobsClaimDue(claimedAt: string): Promise<Array<JobRecord>> {
		const now = new Date(claimedAt)
		const due = (
			this.ctx.storage.sql
				.exec(
					'SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at',
					claimedAt,
				)
				.toArray() as Array<Parameters<UserCell['rowToJob']>[0]>
		).map((row) => this.rowToJob(row))
		for (const job of due) {
			const nextRun = computeNextRun(job.schedule, { now, timezone: job.timezone ?? undefined, lastRunAt: now })
			this.ctx.storage.sql.exec(
				'UPDATE jobs SET next_run_at = ?, last_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?',
				nextRun?.toISOString() ?? null,
				claimedAt,
				'running',
				claimedAt,
				job.id,
			)
		}
		return due
	}

	async jobRunStart(input: { jobId: string; trigger: string }): Promise<string> {
		const id = randomId('jobrun')
		this.ctx.storage.sql.exec(
			`INSERT INTO job_runs (id, job_id, trigger, started_at, status) VALUES (?, ?, ?, ?, 'running')`,
			id,
			input.jobId,
			input.trigger,
			nowIso(),
		)
		return id
	}

	async jobRunFinish(input: {
		id: string
		jobId: string
		status: 'success' | 'error'
		resultJson?: string | null | undefined
		error?: string | null | undefined
		logsJson?: string | undefined
	}) {
		const finishedAt = nowIso()
		this.ctx.storage.sql.exec(
			'UPDATE job_runs SET finished_at = ?, status = ?, result_json = ?, error = ?, logs_json = ? WHERE id = ?',
			finishedAt,
			input.status,
			input.resultJson ?? null,
			input.error ?? null,
			input.logsJson ?? '[]',
			input.id,
		)
		this.ctx.storage.sql.exec(
			'UPDATE jobs SET last_status = ?, last_error = ?, updated_at = ? WHERE id = ?',
			input.status,
			input.error ?? null,
			finishedAt,
			input.jobId,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM job_runs WHERE job_id = ? AND id NOT IN (
				SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 50)`,
			input.jobId,
			input.jobId,
		)
	}

	async jobRunList(
		filter: { jobId?: string | undefined; limit?: number | undefined } = {},
	): Promise<Array<JobRunRecord>> {
		const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200)
		const rows = filter.jobId
			? this.ctx.storage.sql.exec(
					'SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?',
					filter.jobId,
					limit,
				)
			: this.ctx.storage.sql.exec('SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?', limit)
		return (
			rows.toArray() as Array<{
				id: string
				job_id: string
				trigger: string
				started_at: string
				finished_at: string | null
				status: JobRunRecord['status']
				result_json: string | null
				error: string | null
				logs_json: string
			}>
		).map((row) => ({
			id: row.id,
			jobId: row.job_id,
			trigger: row.trigger,
			startedAt: row.started_at,
			finishedAt: row.finished_at,
			status: row.status,
			resultJson: row.result_json,
			error: row.error,
			logsJson: row.logs_json,
		}))
	}

	// ------------------------------------------------------------------- runs

	async runStart(input: {
		kind: RunRecord['kind']
		packageName?: string | null | undefined
		idempotencyKey?: string | null | undefined
	}): Promise<{ run: RunRecord; replayed: boolean }> {
		if (input.idempotencyKey) {
			const existing = await this.runGet({ idempotencyKey: input.idempotencyKey })
			if (existing) return { run: existing, replayed: true }
		}
		const id = randomId('run')
		this.ctx.storage.sql.exec(
			`INSERT INTO runs (id, kind, package_name, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)`,
			id,
			input.kind,
			input.packageName ?? null,
			input.idempotencyKey ?? null,
			nowIso(),
		)
		const run = await this.runGet({ id })
		if (!run) throw new KodyError('internal_error', 'Run insert failed.', { status: 500 })
		return { run, replayed: false }
	}

	async runFinish(input: {
		id: string
		status: 'success' | 'error'
		resultJson?: string | null | undefined
		error?: { name: string; message: string } | null | undefined
		logsJson?: string | undefined
		warnings?: Array<string> | undefined
		durationMs: number
	}): Promise<RunRecord> {
		let resultJson = input.resultJson ?? null
		if (resultJson !== null && resultJson.length > 256 * 1024) {
			resultJson = JSON.stringify({ truncated: true, note: 'Result exceeded the 256 KiB run-record limit.' })
		}
		let logsJson = input.logsJson ?? '[]'
		if (logsJson.length > 256 * 1024)
			logsJson = JSON.stringify([{ level: 'warn', args: ['Logs exceeded the 256 KiB run-record limit.'] }])
		this.ctx.storage.sql.exec(
			`UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, result_json = ?, error_json = ?, logs_json = ?, warnings_json = ? WHERE id = ?`,
			input.status,
			nowIso(),
			input.durationMs,
			resultJson,
			input.error ? JSON.stringify(input.error) : null,
			logsJson,
			JSON.stringify(input.warnings ?? []),
			input.id,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT 500)`,
		)
		const run = await this.runGet({ id: input.id })
		if (!run) throw new KodyError('internal_error', 'Run update failed.', { status: 500 })
		return run
	}

	async runRecordGatewayEvent(input: { runId: string; event: GatewayEvent }) {
		const row = this.ctx.storage.sql
			.exec<{ gateway_json: string }>('SELECT gateway_json FROM runs WHERE id = ?', input.runId)
			.toArray()[0]
		if (!row) return
		const events = JSON.parse(row.gateway_json) as Array<GatewayEvent>
		events.push(input.event)
		this.ctx.storage.sql.exec(
			'UPDATE runs SET gateway_json = ? WHERE id = ?',
			JSON.stringify(events.slice(-100)),
			input.runId,
		)
	}

	async runGet(filter: { id?: string | undefined; idempotencyKey?: string | undefined }): Promise<RunRecord | null> {
		const row = (
			filter.id
				? this.ctx.storage.sql.exec('SELECT * FROM runs WHERE id = ?', filter.id)
				: this.ctx.storage.sql.exec('SELECT * FROM runs WHERE idempotency_key = ?', filter.idempotencyKey ?? '')
		).toArray()[0] as
			| {
					id: string
					kind: RunRecord['kind']
					package_name: string | null
					idempotency_key: string | null
					status: RunRecord['status']
					created_at: string
					finished_at: string | null
					duration_ms: number | null
					result_json: string | null
					error_json: string | null
					logs_json: string
					warnings_json: string
					gateway_json: string
			  }
			| undefined
		if (!row) return null
		return {
			id: row.id,
			kind: row.kind,
			packageName: row.package_name,
			idempotencyKey: row.idempotency_key,
			status: row.status,
			createdAt: row.created_at,
			finishedAt: row.finished_at,
			durationMs: row.duration_ms,
			resultJson: row.result_json,
			error: row.error_json ? (JSON.parse(row.error_json) as RunRecord['error']) : null,
			logsJson: row.logs_json,
			warnings: JSON.parse(row.warnings_json) as Array<string>,
			gateway: JSON.parse(row.gateway_json) as Array<GatewayEvent>,
		}
	}

	async runList(
		filter: { limit?: number | undefined } = {},
	): Promise<Array<Omit<RunRecord, 'resultJson' | 'logsJson' | 'gateway'>>> {
		const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200)
		return (
			this.ctx.storage.sql
				.exec(
					'SELECT id, kind, package_name, idempotency_key, status, created_at, finished_at, duration_ms, error_json, warnings_json FROM runs ORDER BY created_at DESC LIMIT ?',
					limit,
				)
				.toArray() as Array<{
				id: string
				kind: RunRecord['kind']
				package_name: string | null
				idempotency_key: string | null
				status: RunRecord['status']
				created_at: string
				finished_at: string | null
				duration_ms: number | null
				error_json: string | null
				warnings_json: string
			}>
		).map((row) => ({
			id: row.id,
			kind: row.kind,
			packageName: row.package_name,
			idempotencyKey: row.idempotency_key,
			status: row.status,
			createdAt: row.created_at,
			finishedAt: row.finished_at,
			durationMs: row.duration_ms,
			error: row.error_json ? (JSON.parse(row.error_json) as RunRecord['error']) : null,
			warnings: JSON.parse(row.warnings_json) as Array<string>,
		}))
	}
}
