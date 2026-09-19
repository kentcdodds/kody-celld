import { KodyError } from '../lib/errors.ts'
import { normalizeSecretHost } from './host-policy.ts'

// `{{secret/<provider>:<ref>}}` bindings and grants, stored in the UserCell.
// A binding says "provider id X is served by package P, unlocked with the
// stored door secret D". Values are never stored here: the gateway asks the
// bound package (in a sealed run) for the value at request time and only keeps
// it in a short-lived in-memory cache.

export const maxProviderRefLength = 512
export const maxProviderConfigKeys = 16
export const maxProviderConfigValueLength = 2_000

export type SecretProviderBinding = {
	providerId: string
	packageName: string
	doorSecretName: string
	config: Record<string, string>
	/** Locked bindings serve only refs explicitly granted to the calling package; unlocked ones serve any caller (host allowlist still applies). */
	locked: boolean
	createdAt: string
	updatedAt: string
}

export type SecretProviderGrant = {
	providerId: string
	canonicalRef: string
	packageName: string
	createdAt: string
}

export type CachedProviderValue = { value: string; hosts: Array<string>; canonicalRef: string; expiresAt: number }

type BindingRow = {
	provider_id: string
	package_name: string
	door_secret_name: string
	config_json: string
	locked: number
	created_at: string
	updated_at: string
}

type GrantRow = { provider_id: string; canonical_ref: string; package_name: string; created_at: string }

export const secretProviderSchema = `
	CREATE TABLE IF NOT EXISTS secret_provider_bindings (
		provider_id TEXT PRIMARY KEY,
		package_name TEXT NOT NULL,
		door_secret_name TEXT NOT NULL,
		config_json TEXT NOT NULL,
		locked INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS secret_provider_grants (
		provider_id TEXT NOT NULL,
		canonical_ref TEXT NOT NULL,
		package_name TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (provider_id, canonical_ref, package_name)
	);
`

function nowIso() {
	return new Date().toISOString()
}

export function parseProviderConfig(raw: unknown): Record<string, string> {
	if (raw === undefined || raw === null) return {}
	if (typeof raw !== 'object' || Array.isArray(raw))
		throw new KodyError('invalid_args', 'config must be an object of strings.')
	const config: Record<string, string> = {}
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) throw new KodyError('invalid_args', `config key "${key}" is invalid.`)
		if (typeof value !== 'string' || value.length > maxProviderConfigValueLength) {
			throw new KodyError(
				'invalid_args',
				`config["${key}"] must be a string of at most ${maxProviderConfigValueLength} chars.`,
			)
		}
		if (/(secret|token|password|passwd|api[-_]?key)/i.test(key)) {
			throw new KodyError(
				'invalid_args',
				`config["${key}"] looks like a credential. Store it with secretSave and pass its name as doorSecretName instead.`,
			)
		}
		config[key] = value
	}
	if (Object.keys(config).length > maxProviderConfigKeys) {
		throw new KodyError('invalid_args', `At most ${maxProviderConfigKeys} config keys are allowed.`)
	}
	return config
}

export function validateProviderRef(ref: string) {
	if (!ref || ref.length > maxProviderRefLength || /[\s{}]/.test(ref)) {
		throw new KodyError(
			'invalid_args',
			`Provider ref must be 1-${maxProviderRefLength} chars without whitespace or braces.`,
		)
	}
	return ref
}

/** Hosts returned by a provider package for an item; normalized like secret-host approvals. */
export function normalizeProviderHosts(raw: unknown): Array<string> {
	if (!Array.isArray(raw)) return []
	const hosts = new Set<string>()
	for (const entry of raw) {
		if (typeof entry !== 'string') continue
		let candidate = entry.trim().toLowerCase()
		if (!candidate) continue
		if (candidate.includes('://')) {
			try {
				candidate = new URL(candidate).hostname
			} catch {
				continue
			}
		} else if (candidate.includes('/')) {
			candidate = candidate.split('/')[0] ?? ''
		}
		try {
			hosts.add(normalizeSecretHost(candidate))
		} catch {
			continue
		}
		if (hosts.size >= 32) break
	}
	return [...hosts]
}

export class SecretProviderStore {
	private readonly cache = new Map<string, CachedProviderValue>()

	private readonly sql: SqlStorage

	constructor(sql: SqlStorage) {
		this.sql = sql
	}

	private toBinding(row: BindingRow): SecretProviderBinding {
		return {
			providerId: row.provider_id,
			packageName: row.package_name,
			doorSecretName: row.door_secret_name,
			config: JSON.parse(row.config_json) as Record<string, string>,
			locked: row.locked === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}
	}

	list(): Array<SecretProviderBinding> {
		return this.sql
			.exec<BindingRow>('SELECT * FROM secret_provider_bindings ORDER BY provider_id')
			.toArray()
			.map((row) => this.toBinding(row))
	}

	get(providerId: string): SecretProviderBinding | null {
		const row = this.sql
			.exec<BindingRow>('SELECT * FROM secret_provider_bindings WHERE provider_id = ?', providerId)
			.toArray()[0]
		return row ? this.toBinding(row) : null
	}

	bind(input: {
		providerId: string
		packageName: string
		doorSecretName: string
		config: Record<string, string>
		locked: boolean | undefined
	}) {
		const now = nowIso()
		const existing = this.get(input.providerId)
		const locked = input.locked ?? existing?.locked ?? false
		this.sql.exec(
			`INSERT INTO secret_provider_bindings (provider_id, package_name, door_secret_name, config_json, locked, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(provider_id) DO UPDATE SET package_name = excluded.package_name, door_secret_name = excluded.door_secret_name,
			   config_json = excluded.config_json, locked = excluded.locked, updated_at = excluded.updated_at`,
			input.providerId,
			input.packageName,
			input.doorSecretName,
			JSON.stringify(input.config),
			locked ? 1 : 0,
			now,
			now,
		)
		if (existing && existing.packageName !== input.packageName) {
			this.sql.exec('DELETE FROM secret_provider_grants WHERE provider_id = ?', input.providerId)
		}
		this.invalidate(input.providerId)
		return this.get(input.providerId)!
	}

	setLocked(providerId: string, locked: boolean) {
		const cursor = this.sql.exec(
			'UPDATE secret_provider_bindings SET locked = ?, updated_at = ? WHERE provider_id = ?',
			locked ? 1 : 0,
			nowIso(),
			providerId,
		)
		if (cursor.rowsWritten === 0) {
			throw new KodyError('secret_provider_not_bound', `No provider is bound as "${providerId}".`, { status: 404 })
		}
		this.invalidate(providerId)
		return this.get(providerId)!
	}

	/** Whether `packageName` (null = ad hoc execute) may resolve `canonicalRef` through this binding. */
	permits(binding: SecretProviderBinding, canonicalRef: string, packageName: string | null) {
		if (!binding.locked) return true
		if (packageName === null) return false
		return this.isGranted({ providerId: binding.providerId, canonicalRef, packageName })
	}

	unbind(providerId: string) {
		const cursor = this.sql.exec('DELETE FROM secret_provider_bindings WHERE provider_id = ?', providerId)
		this.sql.exec('DELETE FROM secret_provider_grants WHERE provider_id = ?', providerId)
		this.invalidate(providerId)
		return { deleted: cursor.rowsWritten > 0 }
	}

	grants(providerId?: string): Array<SecretProviderGrant> {
		const rows = providerId
			? this.sql.exec<GrantRow>(
					'SELECT * FROM secret_provider_grants WHERE provider_id = ? ORDER BY canonical_ref, package_name',
					providerId,
				)
			: this.sql.exec<GrantRow>(
					'SELECT * FROM secret_provider_grants ORDER BY provider_id, canonical_ref, package_name',
				)
		return rows.toArray().map((row) => ({
			providerId: row.provider_id,
			canonicalRef: row.canonical_ref,
			packageName: row.package_name,
			createdAt: row.created_at,
		}))
	}

	grant(input: { providerId: string; canonicalRef: string; packageName: string }): SecretProviderGrant {
		this.sql.exec(
			`INSERT INTO secret_provider_grants (provider_id, canonical_ref, package_name, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT DO NOTHING`,
			input.providerId,
			input.canonicalRef,
			input.packageName,
			nowIso(),
		)
		return this.grants(input.providerId).find(
			(g) => g.canonicalRef === input.canonicalRef && g.packageName === input.packageName,
		)!
	}

	revoke(input: { providerId: string; canonicalRef: string; packageName: string }) {
		const cursor = this.sql.exec(
			'DELETE FROM secret_provider_grants WHERE provider_id = ? AND canonical_ref = ? AND package_name = ?',
			input.providerId,
			input.canonicalRef,
			input.packageName,
		)
		this.invalidate(input.providerId)
		return { deleted: cursor.rowsWritten > 0 }
	}

	isGranted(input: { providerId: string; canonicalRef: string; packageName: string }) {
		return (
			(this.sql
				.exec<{ c: number }>(
					'SELECT count(*) AS c FROM secret_provider_grants WHERE provider_id = ? AND canonical_ref = ? AND package_name = ?',
					input.providerId,
					input.canonicalRef,
					input.packageName,
				)
				.toArray()[0]?.c ?? 0) > 0
		)
	}

	/** Packages that stop being bound providers (deleted or re-saved without the export) lose their bindings. */
	unbindPackage(packageName: string) {
		const rows = this.sql
			.exec<{ provider_id: string }>(
				'SELECT provider_id FROM secret_provider_bindings WHERE package_name = ?',
				packageName,
			)
			.toArray()
		for (const row of rows) this.unbind(row.provider_id)
		return rows.length
	}

	// ------------------------------------------------------------------ cache

	cacheGet(providerId: string, ref: string): CachedProviderValue | null {
		const hit = this.cache.get(`${providerId}\u0000${ref}`)
		if (!hit) return null
		if (hit.expiresAt <= Date.now()) {
			this.cache.delete(`${providerId}\u0000${ref}`)
			return null
		}
		return hit
	}

	cachePut(providerId: string, ref: string, entry: Omit<CachedProviderValue, 'expiresAt'>, ttlMs: number) {
		if (ttlMs <= 0) return
		if (this.cache.size >= 256) this.cache.clear()
		const cached = { ...entry, expiresAt: Date.now() + ttlMs }
		this.cache.set(`${providerId}\u0000${ref}`, cached)
		if (entry.canonicalRef !== ref) this.cache.set(`${providerId}\u0000${entry.canonicalRef}`, cached)
	}

	invalidate(providerId: string) {
		for (const key of this.cache.keys()) if (key.startsWith(`${providerId}\u0000`)) this.cache.delete(key)
	}
}
