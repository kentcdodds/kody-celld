import { DurableObject } from 'cloudflare:workers'
import { normalizeEmailAddress, snippetOf } from '../email/message.ts'
import type { Env } from '../env.ts'
import { computeNextRun, validateSchedule } from '../jobs/schedule.ts'
import {
	buildMasterKeyring,
	decryptWithKeyring,
	encryptSecretValue,
	randomId,
	randomToken,
	sha256Hex,
	type MasterKeyring,
} from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import {
	effectiveQuotas,
	limitsFromEnv,
	quotasFromEnv,
	utcDay,
	withinQuota,
	type Limits,
	type Quotas,
} from '../lib/limits.ts'
import {
	parsePackageManifest,
	type PackageFiles,
	type PackageManifest,
	type SubscriptionDefinition,
	type WebhookDefinition,
	type WebhookVerification,
} from '../packages/manifest.ts'
import type { IntegrationConfig, IntegrationUsage } from '../integrations/oauth.ts'
import {
	IntegrationStore,
	integrationSchema,
	type ConnectRecord,
	type ConnectTicket,
	type IntegrationRecord,
	type TokenResolution,
} from '../integrations/store.ts'
import { normalizeSecretHost, parseInsecureHostAllowance } from '../secrets/host-policy.ts'
import type { SecretScope } from '../secrets/placeholders.ts'
import {
	SecretProviderStore,
	secretProviderSchema,
	type CachedProviderValue,
	type SecretProviderBinding,
	type SecretProviderGrant,
} from '../secrets/provider-store.ts'
import { signatureMatches } from '../webhooks/verify.ts'

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
	kind: 'execute' | 'package' | 'job' | 'webhook' | 'subscription' | 'secret-provider'
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

export type DailyUsage = {
	day: string
	runs: number
	errors: number
	executeMs: number
	emailSends: number
	emailReceives: number
}

type BlobRow = {
	key: string
	size: number
	content_type: string
	sha256: string
	etag: string
	package_name: string | null
	metadata_json: string
	created_at: string
	updated_at: string
}

export type BlobRecord = {
	key: string
	size: number
	contentType: string
	sha256: string
	etag: string
	packageName: string | null
	metadata: Record<string, string>
	createdAt: string
	updatedAt: string
}

export type WebhookRecord = {
	handle: string
	packageName: string
	webhookName: string
	enabled: boolean
	createdAt: string
	updatedAt: string
	rotatedAt: string | null
	/** Previous URL secret still accepted until this time (after a rotate). */
	previousExpiresAt: string | null
	lastDeliveryAt: string | null
	deliveries: number
}

export type WebhookListing = {
	packageName: string
	definition: WebhookDefinition
	mint: WebhookRecord | null
}

export type WebhookDeliveryRecord = {
	id: string
	handle: string
	receivedAt: string
	finishedAt: string | null
	status: 'accepted' | 'rejected' | 'rate_limited' | 'replayed' | 'success' | 'error' | 'conflict'
	httpStatus: number
	reason: string | null
	runId: string | null
	idempotencyKey: string | null
	bodyBytes: number
	contentType: string | null
}

export type WebhookAdmission =
	| { ok: true; webhook: WebhookRecord; definition: WebhookDefinition; usedPrevious: boolean }
	| { ok: false; status: 404 | 429; reason: string }

export type EmailAddress = { address: string; name: string | null }

export type EmailAttachmentMeta = {
	id: string
	filename: string
	contentType: string
	size: number
	contentId: string | null
	disposition: 'attachment' | 'inline'
}

export type EmailMessageRecord = {
	id: string
	direction: 'inbound' | 'outbound'
	inboxAddress: string | null
	from: EmailAddress
	to: Array<EmailAddress>
	cc: Array<EmailAddress>
	replyTo: Array<EmailAddress>
	subject: string
	messageId: string | null
	inReplyTo: string | null
	references: Array<string>
	text: string | null
	html: string | null
	headers: Record<string, string>
	attachments: Array<EmailAttachmentMeta>
	classification: 'inbox' | 'quarantine' | null
	classificationReason: string | null
	provider: string
	providerMessageId: string | null
	deliveryStatus: string | null
	sizeBytes: number
	packageName: string | null
	inReplyToMessageId: string | null
	receivedAt: string
	createdAt: string
}

export type EmailMessageSummary = Omit<EmailMessageRecord, 'text' | 'html' | 'headers'> & {
	snippet: string
}

export type EmailDestinationRecord = {
	address: string
	verified: boolean
	isDefault: boolean
	createdAt: string
	verifiedAt: string | null
	codeExpiresAt: string | null
}

export type EmailSenderRule = {
	id: string
	kind: 'address' | 'domain'
	value: string
	effect: 'allow' | 'block' | 'quarantine'
	note: string | null
	createdAt: string
}

export type EmailDeliveryEvent = {
	id: string
	messageId: string
	provider: string
	event: string
	status: string
	detail: string | null
	at: string
}

export type UsageReport = {
	day: string
	today: DailyUsage
	history: Array<DailyUsage>
	counts: {
		packages: number
		secrets: number
		jobs: number
		runsRetained: number
		blobs: number
		blobBytes: number
		emailMessages: number
		webhooks: number
	}
	quotas: Quotas
	quotaOverride: Partial<Quotas> | null
	limits: Limits
}

const secretNamePattern = /^[a-zA-Z0-9._-]+$/
const webhookPreviousSecretGraceMs = 24 * 60 * 60 * 1000
const emailDestinationCodeTtlMs = 30 * 60 * 1000

function nowIso() {
	return new Date().toISOString()
}

/** Manifests saved before a field existed come back without it. */
function storedManifest(json: string): PackageManifest {
	const manifest = JSON.parse(json) as Partial<PackageManifest> & Pick<PackageManifest, 'name' | 'version'>
	return {
		name: manifest.name,
		version: manifest.version,
		description: manifest.description ?? '',
		exports: manifest.exports ?? {},
		jobs: manifest.jobs ?? {},
		webhooks: manifest.webhooks ?? [],
		subscriptions: manifest.subscriptions ?? [],
		secretProvider: manifest.secretProvider ?? null,
		dependencies: manifest.dependencies ?? {},
		hidden: manifest.hidden === true,
		keywords: manifest.keywords ?? [],
	}
}

function constantTimeEqual(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
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
			CREATE TABLE IF NOT EXISTS usage_daily (
				day TEXT PRIMARY KEY,
				runs INTEGER NOT NULL DEFAULT 0,
				errors INTEGER NOT NULL DEFAULT 0,
				execute_ms INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS blobs (
				key TEXT PRIMARY KEY,
				size INTEGER NOT NULL,
				content_type TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				etag TEXT NOT NULL,
				package_name TEXT,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS webhooks (
				handle TEXT PRIMARY KEY,
				package_name TEXT NOT NULL,
				webhook_name TEXT NOT NULL,
				secret_hash TEXT NOT NULL,
				secret_iv TEXT NOT NULL,
				secret_ciphertext TEXT NOT NULL,
				secret_key_id TEXT NOT NULL,
				previous_secret_hash TEXT,
				previous_expires_at TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				rotated_at TEXT,
				last_delivery_at TEXT,
				deliveries INTEGER NOT NULL DEFAULT 0,
				UNIQUE (package_name, webhook_name)
			);
			CREATE TABLE IF NOT EXISTS webhook_deliveries (
				id TEXT PRIMARY KEY,
				handle TEXT NOT NULL,
				received_at TEXT NOT NULL,
				finished_at TEXT,
				status TEXT NOT NULL,
				http_status INTEGER NOT NULL,
				reason TEXT,
				run_id TEXT,
				idempotency_key TEXT,
				body_bytes INTEGER NOT NULL DEFAULT 0,
				content_type TEXT
			);
			CREATE INDEX IF NOT EXISTS webhook_deliveries_handle ON webhook_deliveries(handle, received_at DESC);
			CREATE TABLE IF NOT EXISTS webhook_rate (
				handle TEXT NOT NULL,
				minute TEXT NOT NULL,
				n INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (handle, minute)
			);
			CREATE TABLE IF NOT EXISTS webhook_idempotency (
				handle TEXT NOT NULL,
				key TEXT NOT NULL,
				payload_hash TEXT,
				run_id TEXT,
				status TEXT NOT NULL,
				result_json TEXT,
				created_at TEXT NOT NULL,
				PRIMARY KEY (handle, key)
			);
			CREATE TABLE IF NOT EXISTS email_messages (
				id TEXT PRIMARY KEY,
				direction TEXT NOT NULL,
				inbox_address TEXT,
				from_json TEXT NOT NULL,
				to_json TEXT NOT NULL,
				cc_json TEXT NOT NULL DEFAULT '[]',
				reply_to_json TEXT NOT NULL DEFAULT '[]',
				subject TEXT NOT NULL DEFAULT '',
				message_id TEXT,
				in_reply_to TEXT,
				references_json TEXT NOT NULL DEFAULT '[]',
				text TEXT,
				html TEXT,
				headers_json TEXT NOT NULL DEFAULT '{}',
				attachments_json TEXT NOT NULL DEFAULT '[]',
				classification TEXT,
				classification_reason TEXT,
				provider TEXT NOT NULL,
				provider_message_id TEXT,
				delivery_status TEXT,
				size_bytes INTEGER NOT NULL DEFAULT 0,
				package_name TEXT,
				in_reply_to_message_id TEXT,
				received_at TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS email_messages_received ON email_messages(direction, received_at DESC);
			CREATE INDEX IF NOT EXISTS email_messages_provider ON email_messages(provider_message_id);
			CREATE TABLE IF NOT EXISTS email_attachments (
				id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL,
				content_base64 TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS email_attachments_message ON email_attachments(message_id);
			CREATE TABLE IF NOT EXISTS email_destinations (
				address TEXT PRIMARY KEY,
				verified INTEGER NOT NULL DEFAULT 0,
				code_hash TEXT,
				code_expires_at TEXT,
				is_default INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				verified_at TEXT
			);
			CREATE TABLE IF NOT EXISTS email_sender_rules (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				value TEXT NOT NULL,
				effect TEXT NOT NULL,
				note TEXT,
				created_at TEXT NOT NULL,
				UNIQUE (kind, value)
			);
			CREATE TABLE IF NOT EXISTS email_delivery_events (
				id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL,
				provider TEXT NOT NULL,
				event TEXT NOT NULL,
				status TEXT NOT NULL,
				detail TEXT,
				at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS email_delivery_events_message ON email_delivery_events(message_id, at DESC);
		`)
		this.ctx.storage.sql.exec(integrationSchema)
		this.ctx.storage.sql.exec(secretProviderSchema)
		this.limits = limitsFromEnv(env)
		this.defaultQuotas = quotasFromEnv(env)
		this.integrations = new IntegrationStore({
			sql: this.ctx.storage.sql,
			userId: () => this.userId,
			keyring: () => this.keyring(),
			insecureAllowance: parseInsecureHostAllowance(env.KODY_ALLOW_INSECURE_SECRET_HOSTS),
			fetch: (input, init) => fetch(input, init),
		})
		this.secretProviders = new SecretProviderStore(this.ctx.storage.sql)
		const secretColumns = this.ctx.storage.sql
			.exec<{ name: string }>(`SELECT name FROM pragma_table_info('secrets')`)
			.toArray()
			.map((row) => row.name)
		if (!secretColumns.includes('key_id')) {
			this.ctx.storage.sql.exec(`ALTER TABLE secrets ADD COLUMN key_id TEXT NOT NULL DEFAULT ''`)
		}
		const usageColumns = this.ctx.storage.sql
			.exec<{ name: string }>(`SELECT name FROM pragma_table_info('usage_daily')`)
			.toArray()
			.map((row) => row.name)
		if (!usageColumns.includes('email_sends')) {
			this.ctx.storage.sql.exec(`ALTER TABLE usage_daily ADD COLUMN email_sends INTEGER NOT NULL DEFAULT 0`)
		}
		if (!usageColumns.includes('email_receives')) {
			this.ctx.storage.sql.exec(`ALTER TABLE usage_daily ADD COLUMN email_receives INTEGER NOT NULL DEFAULT 0`)
		}
	}

	private readonly limits: Limits
	private readonly defaultQuotas: Quotas
	private readonly integrations: IntegrationStore
	private readonly secretProviders: SecretProviderStore

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

	// ---------------------------------------------------------- quotas & usage

	private quotaOverride(): Partial<Quotas> | null {
		const row = this.ctx.storage.sql
			.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'quota_override'`)
			.toArray()[0]
		return row ? (JSON.parse(row.value) as Partial<Quotas>) : null
	}

	private quotas() {
		return effectiveQuotas(this.defaultQuotas, this.quotaOverride())
	}

	private count(
		table: 'packages' | 'secrets' | 'jobs' | 'runs' | 'blobs' | 'email_messages' | 'webhooks' | 'integrations',
	) {
		return Number(this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]?.n ?? 0)
	}

	private blobBytes() {
		return Number(
			this.ctx.storage.sql.exec<{ n: number | null }>('SELECT SUM(size) AS n FROM blobs').toArray()[0]?.n ?? 0,
		)
	}

	private usageFor(day: string): DailyUsage {
		const row = this.ctx.storage.sql
			.exec<{ runs: number; errors: number; execute_ms: number; email_sends: number; email_receives: number }>(
				'SELECT runs, errors, execute_ms, email_sends, email_receives FROM usage_daily WHERE day = ?',
				day,
			)
			.toArray()[0]
		return {
			day,
			runs: row?.runs ?? 0,
			errors: row?.errors ?? 0,
			executeMs: row?.execute_ms ?? 0,
			emailSends: row?.email_sends ?? 0,
			emailReceives: row?.email_receives ?? 0,
		}
	}

	private assertQuota(quota: keyof Quotas, used: number, what: string) {
		const limit = this.quotas()[quota]
		if (withinQuota(limit, used)) return
		throw new KodyError('quota_exceeded', `${what} quota reached (${used}/${limit}).`, {
			status: 429,
			details: { quota, limit, used },
		})
	}

	async quotaGet(): Promise<{ quotas: Quotas; override: Partial<Quotas> | null; defaults: Quotas }> {
		return { quotas: this.quotas(), override: this.quotaOverride(), defaults: this.defaultQuotas }
	}

	/** Admin-only: replace the per-user override (`null` clears it). */
	async quotaSet(override: Partial<Quotas> | null) {
		if (override === null || Object.keys(override).length === 0) {
			this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = 'quota_override'`)
		} else {
			this.ctx.storage.sql.exec(
				`INSERT INTO meta (key, value) VALUES ('quota_override', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				JSON.stringify(override),
			)
		}
		return this.quotaGet()
	}

	async usageGet(input: { days?: number | undefined } = {}): Promise<UsageReport> {
		const days = Math.min(Math.max(input.days ?? 7, 1), 90)
		const day = utcDay()
		const history = this.ctx.storage.sql
			.exec<{ day: string }>('SELECT day FROM usage_daily ORDER BY day DESC LIMIT ?', days)
			.toArray()
			.map((row) => this.usageFor(row.day))
		return {
			day,
			today: this.usageFor(day),
			history,
			counts: {
				packages: this.count('packages'),
				secrets: this.count('secrets'),
				jobs: this.count('jobs'),
				runsRetained: this.count('runs'),
				blobs: this.count('blobs'),
				blobBytes: this.blobBytes(),
				emailMessages: this.count('email_messages'),
				webhooks: this.count('webhooks'),
			},
			quotas: this.quotas(),
			quotaOverride: this.quotaOverride(),
			limits: this.limits,
		}
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
		const exists =
			this.ctx.storage.sql
				.exec('SELECT 1 FROM secrets WHERE name = ? AND scope = ? AND package_name = ?', name, scope, packageName)
				.toArray().length > 0
		if (!exists) this.assertQuota('secrets', this.count('secrets'), 'Secret')
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
		const integrations = await this.integrations.rekey()
		return {
			resealed: resealed + integrations.resealed,
			remaining: (remaining?.c ?? 0) + integrations.remaining,
			currentKeyId: keyring.current.id,
		}
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
		if (!existing) this.assertQuota('packages', this.count('packages'), 'Package')
		const jobsElsewhere = Number(
			this.ctx.storage.sql
				.exec<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE package_name != ?', manifest.name)
				.toArray()[0]?.n ?? 0,
		)
		const declaredJobs = Object.keys(manifest.jobs).length
		if (declaredJobs > 0) {
			this.assertQuota('jobs', jobsElsewhere + declaredJobs - 1, 'Job')
		}
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
		this.reconcileWebhooks(manifest, now)
		if (!manifest.secretProvider) this.secretProviders.unbindPackage(manifest.name)
		else this.secretProviders.invalidate(manifest.secretProvider.id)
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

	private reconcileWebhooks(manifest: PackageManifest, now: string) {
		const declared = new Set(manifest.webhooks.map((hook) => hook.name))
		const rows = this.ctx.storage.sql
			.exec<{ handle: string; webhook_name: string }>(
				'SELECT handle, webhook_name FROM webhooks WHERE package_name = ?',
				manifest.name,
			)
			.toArray()
		// Mints outlive republishes so provider-side URLs stay valid; a removed
		// declaration deactivates ingress (404) without deleting the mint.
		for (const row of rows) {
			if (!declared.has(row.webhook_name)) {
				this.ctx.storage.sql.exec('UPDATE webhooks SET updated_at = ? WHERE handle = ?', now, row.handle)
			}
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
				manifest: storedManifest(row.manifest_json),
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
			manifest: storedManifest(row.manifest_json),
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
		for (const row of this.ctx.storage.sql
			.exec<{ handle: string }>('SELECT handle FROM webhooks WHERE package_name = ?', name)
			.toArray()) {
			this.ctx.storage.sql.exec('DELETE FROM webhook_deliveries WHERE handle = ?', row.handle)
			this.ctx.storage.sql.exec('DELETE FROM webhook_rate WHERE handle = ?', row.handle)
			this.ctx.storage.sql.exec('DELETE FROM webhook_idempotency WHERE handle = ?', row.handle)
		}
		this.ctx.storage.sql.exec('DELETE FROM webhooks WHERE package_name = ?', name)
		this.secretProviders.unbindPackage(name)
		return { deleted: cursor.rowsWritten > 0 }
	}

	// ----------------------------------------------------------- integrations

	async integrationSave(input: {
		config: IntegrationConfig
		clientSecret: string | null | undefined
	}): Promise<IntegrationRecord> {
		if (!this.integrations.get(input.config.name))
			this.assertQuota('integrations', this.count('integrations'), 'Integration')
		return this.integrations.save(input.config, input.clientSecret)
	}

	async integrationList(): Promise<Array<IntegrationRecord>> {
		return this.integrations.list()
	}

	async integrationGet(name: string): Promise<IntegrationRecord | null> {
		return this.integrations.get(name)
	}

	async integrationSetUsage(input: { name: string; usage: IntegrationUsage }): Promise<IntegrationRecord> {
		return this.integrations.setUsage(input.name, input.usage)
	}

	async integrationDisconnect(name: string): Promise<IntegrationRecord> {
		return this.integrations.disconnect(name)
	}

	async integrationDelete(name: string) {
		return this.integrations.delete(name)
	}

	async integrationConnectStart(input: { name: string; redirectUri: string }): Promise<ConnectTicket> {
		return this.integrations.connectStart(input.name, input.redirectUri)
	}

	async integrationConnectGet(connectId: string): Promise<ConnectRecord | null> {
		return this.integrations.connectGet(connectId)
	}

	async integrationConnectLatest(name: string): Promise<ConnectRecord | null> {
		return this.integrations.connectLatest(name)
	}

	async integrationConnectBegin(input: { connectId: string; ticket: string }): Promise<{ authorizeUrl: string }> {
		return this.integrations.connectBegin(input)
	}

	async integrationConnectComplete(input: {
		connectId: string
		nonce: string
		code: string | null
		providerError: string | null
	}): Promise<{ record: IntegrationRecord; connect: ConnectRecord }> {
		return this.integrations.connectComplete(input)
	}

	/** Metadata-only refresh for capabilities; the token stays inside the cell. */
	async integrationRefresh(
		name: string,
	): Promise<{ ok: boolean; code?: string; message?: string; record: IntegrationRecord | null }> {
		const outcome = await this.integrations.refresh(name)
		if (outcome.ok) return { ok: true, record: outcome.record }
		return { ok: false, code: outcome.code, message: outcome.message, record: outcome.record }
	}

	/** Gateway-only: returns the access token for `{{integration-token:name}}` injection. */
	async integrationTokenResolve(input: {
		name: string
		packageName: string | null
		host: string
		forceRefresh?: boolean
	}): Promise<TokenResolution> {
		return this.integrations.tokenResolve(input)
	}

	// -------------------------------------------------------- secret providers

	async secretProviderBind(input: {
		providerId: string
		packageName: string
		doorSecretName: string
		config: Record<string, string>
		locked: boolean | undefined
	}): Promise<SecretProviderBinding> {
		const pkg = await this.packageGet(input.packageName)
		if (!pkg) throw new KodyError('package_not_found', `Package "${input.packageName}" was not found.`, { status: 404 })
		if (!pkg.manifest.secretProvider || pkg.manifest.secretProvider.id !== input.providerId) {
			throw new KodyError(
				'not_a_secret_provider',
				`Package "${input.packageName}" does not declare kody.secretProvider.id "${input.providerId}"${
					pkg.manifest.secretProvider ? ` (it declares "${pkg.manifest.secretProvider.id}")` : ''
				}.`,
			)
		}
		const door = (await this.secretList()).find(
			(s) =>
				s.name === input.doorSecretName &&
				(s.scope === 'user' || (s.scope === 'package' && s.packageName === input.packageName)),
		)
		if (!door) {
			throw new KodyError(
				'secret_not_found',
				`Door secret "${input.doorSecretName}" was not found; save it with secretSave first (scope user, or scope package for "${input.packageName}").`,
				{ status: 404 },
			)
		}
		return this.secretProviders.bind(input)
	}

	async secretProviderUnbind(providerId: string) {
		return this.secretProviders.unbind(providerId)
	}

	async secretProviderSetLocked(input: { providerId: string; locked: boolean }): Promise<SecretProviderBinding> {
		return this.secretProviders.setLocked(input.providerId, input.locked)
	}

	/**
	 * Gateway-only pre-check for `{{secret/<provider>:<ref>}}`. On a locked binding a
	 * package that already holds some grant for the provider may resolve an
	 * unknown alias (`provisional`) so the canonical ref can be learned; the
	 * gateway must then re-check with `strict: true` before injecting anything.
	 */
	async secretProviderAuthorize(input: {
		providerId: string
		ref: string
		packageName: string | null
		strict?: boolean
	}): Promise<
		| { ok: true; binding: SecretProviderBinding; cached: CachedProviderValue | null; provisional: boolean }
		| { ok: false; code: string; status: number; message: string }
	> {
		const binding = this.secretProviders.get(input.providerId)
		if (!binding) {
			return {
				ok: false,
				code: 'secret_provider_not_bound',
				status: 404,
				message: `No secret provider is bound as "${input.providerId}". Bind one with secretProviderBind.`,
			}
		}
		const cached = this.secretProviders.cacheGet(input.providerId, input.ref)
		const canonicalRef = cached?.canonicalRef ?? input.ref
		if (!this.secretProviders.permits(binding, canonicalRef, input.packageName)) {
			const provisional =
				!input.strict &&
				cached === null &&
				input.packageName !== null &&
				this.secretProviders.grants(input.providerId).some((g) => g.packageName === input.packageName)
			if (provisional) return { ok: true, binding, cached: null, provisional: true }
			return {
				ok: false,
				code: 'secret_provider_not_granted',
				status: 403,
				message: `Provider "${input.providerId}" is locked; ${
					input.packageName ? `package "${input.packageName}" has no grant for` : 'ad hoc code may not use'
				} ref "${input.ref}". Grant it with secretProviderGrant.`,
			}
		}
		return { ok: true, binding, cached, provisional: false }
	}

	async secretProviderList(): Promise<Array<SecretProviderBinding & { grants: Array<SecretProviderGrant> }>> {
		const grants = this.secretProviders.grants()
		return this.secretProviders.list().map((binding) => ({
			...binding,
			grants: grants.filter((g) => g.providerId === binding.providerId),
		}))
	}

	async secretProviderGet(providerId: string): Promise<SecretProviderBinding | null> {
		return this.secretProviders.get(providerId)
	}

	async secretProviderGrant(input: {
		providerId: string
		canonicalRef: string
		packageName: string
	}): Promise<SecretProviderGrant> {
		if (!this.secretProviders.get(input.providerId)) {
			throw new KodyError('secret_provider_not_bound', `No provider is bound as "${input.providerId}".`, {
				status: 404,
			})
		}
		if (!(await this.packageGet(input.packageName))) {
			throw new KodyError('package_not_found', `Package "${input.packageName}" was not found.`, { status: 404 })
		}
		return this.secretProviders.grant(input)
	}

	async secretProviderRevoke(input: { providerId: string; canonicalRef: string; packageName: string }) {
		return this.secretProviders.revoke(input)
	}

	async secretProviderIsGranted(input: {
		providerId: string
		canonicalRef: string
		packageName: string
	}): Promise<boolean> {
		return this.secretProviders.isGranted(input)
	}

	/** Gateway-only cache of resolved provider values (in memory, never persisted). */
	async secretProviderCachePut(input: {
		providerId: string
		ref: string
		entry: Omit<CachedProviderValue, 'expiresAt'>
		ttlMs: number
	}) {
		this.secretProviders.cachePut(input.providerId, input.ref, input.entry, input.ttlMs)
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

	// ------------------------------------------------------------------ blobs

	private blobFromRow(row: BlobRow): BlobRecord {
		return {
			key: row.key,
			size: row.size,
			contentType: row.content_type,
			sha256: row.sha256,
			etag: row.etag,
			packageName: row.package_name,
			metadata: JSON.parse(row.metadata_json) as Record<string, string>,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}
	}

	private assertBlobQuota(input: { key: string; size: number }): BlobRow | undefined {
		const existing = this.ctx.storage.sql.exec<BlobRow>('SELECT * FROM blobs WHERE key = ?', input.key).toArray()[0]
		if (!existing) this.assertQuota('blobs', this.count('blobs'), 'Blob count')
		const quotas = this.quotas()
		const used = this.blobBytes()
		const projected = used - (existing?.size ?? 0) + input.size
		if (quotas.blobBytes !== 0 && projected > quotas.blobBytes) {
			throw new KodyError(
				'quota_exceeded',
				`Blob storage quota reached (${projected}/${quotas.blobBytes} bytes after this write).`,
				{ status: 429, details: { quota: 'blobBytes', limit: quotas.blobBytes, used } },
			)
		}
		return existing
	}

	/**
	 * Pre-flight quota check so oversized puts fail before any bytes are
	 * uploaded. Returns the previous record (for overwrite accounting) or null.
	 * `blobIndexPut` re-checks against the index, which is what makes the quota
	 * hold when two puts race.
	 */
	async blobReserve(input: { key: string; size: number }): Promise<BlobRecord | null> {
		const existing = this.assertBlobQuota(input)
		return existing ? this.blobFromRow(existing) : null
	}

	async blobIndexPut(input: {
		key: string
		size: number
		contentType: string
		sha256: string
		etag: string
		packageName: string | null
		metadata: Record<string, string>
	}): Promise<BlobRecord> {
		this.assertBlobQuota(input)
		const now = nowIso()
		this.ctx.storage.sql.exec(
			`INSERT INTO blobs (key, size, content_type, sha256, etag, package_name, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET
			   size = excluded.size, content_type = excluded.content_type, sha256 = excluded.sha256,
			   etag = excluded.etag, package_name = excluded.package_name, metadata_json = excluded.metadata_json,
			   updated_at = excluded.updated_at`,
			input.key,
			input.size,
			input.contentType,
			input.sha256,
			input.etag,
			input.packageName,
			JSON.stringify(input.metadata),
			now,
			now,
		)
		return this.blobFromRow(this.ctx.storage.sql.exec<BlobRow>('SELECT * FROM blobs WHERE key = ?', input.key).one())
	}

	async blobIndexGet(key: string): Promise<BlobRecord | null> {
		const row = this.ctx.storage.sql.exec<BlobRow>('SELECT * FROM blobs WHERE key = ?', key).toArray()[0]
		return row ? this.blobFromRow(row) : null
	}

	async blobIndexDelete(key: string): Promise<BlobRecord | null> {
		const existing = await this.blobIndexGet(key)
		if (existing) this.ctx.storage.sql.exec('DELETE FROM blobs WHERE key = ?', key)
		return existing
	}

	async blobIndexList(input: {
		prefix?: string | undefined
		cursor?: string | undefined
		limit?: number | undefined
	}): Promise<{ items: Array<BlobRecord>; cursor: string | null }> {
		const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000)
		const prefix = input.prefix ?? ''
		const rows = this.ctx.storage.sql
			.exec<BlobRow>(
				`SELECT * FROM blobs
				 WHERE substr(key, 1, ?) = ? AND key > ?
				 ORDER BY key ASC LIMIT ?`,
				prefix.length,
				prefix,
				input.cursor ?? '',
				limit + 1,
			)
			.toArray()
		const page = rows.slice(0, limit)
		return {
			items: page.map((row) => this.blobFromRow(row)),
			cursor: rows.length > limit ? (page[page.length - 1]?.key ?? null) : null,
		}
	}

	async blobUsage(): Promise<{ blobs: number; blobBytes: number; quotas: Pick<Quotas, 'blobs' | 'blobBytes'> }> {
		const quotas = this.quotas()
		return {
			blobs: this.count('blobs'),
			blobBytes: this.blobBytes(),
			quotas: { blobs: quotas.blobs, blobBytes: quotas.blobBytes },
		}
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
		const day = utcDay()
		const usage = this.usageFor(day)
		this.assertQuota('runsPerDay', usage.runs, 'Daily run')
		this.assertQuota('executeMsPerDay', usage.executeMs, 'Daily execute-time')
		const id = randomId('run')
		this.ctx.storage.sql.exec(
			`INSERT INTO runs (id, kind, package_name, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)`,
			id,
			input.kind,
			input.packageName ?? null,
			input.idempotencyKey ?? null,
			nowIso(),
		)
		this.ctx.storage.sql.exec(
			`INSERT INTO usage_daily (day, runs) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET runs = runs + 1`,
			day,
		)
		this.pruneRuns()
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
			`INSERT INTO usage_daily (day, errors, execute_ms) VALUES (?, ?, ?)
			 ON CONFLICT(day) DO UPDATE SET errors = errors + excluded.errors, execute_ms = execute_ms + excluded.execute_ms`,
			utcDay(),
			input.status === 'error' ? 1 : 0,
			Math.max(0, Math.round(input.durationMs)),
		)
		this.pruneRuns()
		const run = await this.runGet({ id: input.id })
		if (!run) throw new KodyError('internal_error', 'Run update failed.', { status: 500 })
		return run
	}

	private pruneRuns() {
		this.ctx.storage.sql.exec(
			`DELETE FROM runs WHERE status != 'running' AND id NOT IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT ?)`,
			this.limits.runRetentionCount,
		)
		if (this.limits.runRetentionDays > 0) {
			const cutoff = new Date(Date.now() - this.limits.runRetentionDays * 86_400_000).toISOString()
			this.ctx.storage.sql.exec(`DELETE FROM runs WHERE created_at < ? AND status != 'running'`, cutoff)
			this.ctx.storage.sql.exec('DELETE FROM usage_daily WHERE day < ?', cutoff.slice(0, 10))
		}
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

	// --------------------------------------------------------------- webhooks

	private rowToWebhook(row: {
		handle: string
		package_name: string
		webhook_name: string
		enabled: number
		created_at: string
		updated_at: string
		rotated_at: string | null
		previous_secret_hash: string | null
		previous_expires_at: string | null
		last_delivery_at: string | null
		deliveries: number
	}): WebhookRecord {
		const previousLive =
			row.previous_secret_hash !== null &&
			row.previous_expires_at !== null &&
			new Date(row.previous_expires_at).getTime() > Date.now()
		return {
			handle: row.handle,
			packageName: row.package_name,
			webhookName: row.webhook_name,
			enabled: row.enabled === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			rotatedAt: row.rotated_at,
			previousExpiresAt: previousLive ? row.previous_expires_at : null,
			lastDeliveryAt: row.last_delivery_at,
			deliveries: row.deliveries,
		}
	}

	private webhookRow(handle: string) {
		return this.ctx.storage.sql.exec('SELECT * FROM webhooks WHERE handle = ?', handle).toArray()[0] as
			| (Parameters<UserCell['rowToWebhook']>[0] & {
					secret_hash: string
					secret_iv: string
					secret_ciphertext: string
					secret_key_id: string
			  })
			| undefined
	}

	private webhookDefinition(packageName: string, webhookName: string): WebhookDefinition | null {
		const row = this.ctx.storage.sql
			.exec<{ manifest_json: string }>('SELECT manifest_json FROM packages WHERE name = ?', packageName)
			.toArray()[0]
		if (!row) return null
		return storedManifest(row.manifest_json).webhooks.find((hook) => hook.name === webhookName) ?? null
	}

	/** Declared webhooks (from saved manifests) joined with their mint state. */
	async webhookList(filter: { packageName?: string | undefined } = {}): Promise<Array<WebhookListing>> {
		const packages = (await this.packageList()).filter(
			(pkg) => filter.packageName === undefined || pkg.name === filter.packageName,
		)
		const mints = this.ctx.storage.sql
			.exec('SELECT * FROM webhooks ORDER BY package_name, webhook_name')
			.toArray() as Array<Parameters<UserCell['rowToWebhook']>[0]>
		const listing: Array<WebhookListing> = []
		for (const pkg of packages) {
			for (const definition of pkg.manifest.webhooks) {
				const mint = mints.find((row) => row.package_name === pkg.name && row.webhook_name === definition.name)
				listing.push({ packageName: pkg.name, definition, mint: mint ? this.rowToWebhook(mint) : null })
			}
		}
		return listing
	}

	async webhookGet(handle: string): Promise<(WebhookRecord & { definition: WebhookDefinition | null }) | null> {
		const row = this.webhookRow(handle)
		if (!row) return null
		return { ...this.rowToWebhook(row), definition: this.webhookDefinition(row.package_name, row.webhook_name) }
	}

	/**
	 * Mints (or returns the existing mint for) a declared webhook. The URL
	 * secret is generated here, stored hashed for lookup and sealed with the
	 * master keyring so `webhookReveal` can show the URL to the owner. The
	 * secret is never returned from this method.
	 */
	async webhookMint(input: { packageName: string; webhookName: string }): Promise<WebhookRecord> {
		const definition = this.webhookDefinition(input.packageName, input.webhookName)
		if (!definition) {
			throw new KodyError(
				'webhook_not_declared',
				`Package "${input.packageName}" does not declare webhook "${input.webhookName}".`,
				{ status: 404 },
			)
		}
		const existing = this.ctx.storage.sql
			.exec<{ handle: string }>(
				'SELECT handle FROM webhooks WHERE package_name = ? AND webhook_name = ?',
				input.packageName,
				input.webhookName,
			)
			.toArray()[0]
		if (existing) return (await this.webhookGet(existing.handle))!
		this.assertQuota('webhooks', this.count('webhooks'), 'Webhook')
		const handle = randomId('whk')
		const sealed = await this.sealWebhookSecret()
		const now = nowIso()
		this.ctx.storage.sql.exec(
			`INSERT INTO webhooks (handle, package_name, webhook_name, secret_hash, secret_iv, secret_ciphertext, secret_key_id, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			handle,
			input.packageName,
			input.webhookName,
			sealed.hash,
			sealed.iv,
			sealed.ciphertext,
			sealed.keyId,
			now,
			now,
		)
		return (await this.webhookGet(handle))!
	}

	private async sealWebhookSecret() {
		const secret = randomToken('whs', 32).slice('whs_'.length)
		const { current } = await this.keyring()
		const encrypted = await encryptSecretValue(current.key, this.userId, secret)
		return { hash: await sha256Hex(secret), iv: encrypted.iv, ciphertext: encrypted.ciphertext, keyId: current.id }
	}

	/** Issues a new URL secret; the previous one stays valid for 24h or until the first accepted delivery on the new one. */
	async webhookRotate(handle: string): Promise<WebhookRecord> {
		const row = this.webhookRow(handle)
		if (!row) throw new KodyError('webhook_not_found', `Webhook "${handle}" was not found.`, { status: 404 })
		const sealed = await this.sealWebhookSecret()
		const now = new Date()
		this.ctx.storage.sql.exec(
			`UPDATE webhooks SET previous_secret_hash = secret_hash, previous_expires_at = ?, secret_hash = ?, secret_iv = ?,
			   secret_ciphertext = ?, secret_key_id = ?, rotated_at = ?, updated_at = ? WHERE handle = ?`,
			new Date(now.getTime() + webhookPreviousSecretGraceMs).toISOString(),
			sealed.hash,
			sealed.iv,
			sealed.ciphertext,
			sealed.keyId,
			now.toISOString(),
			now.toISOString(),
			handle,
		)
		return (await this.webhookGet(handle))!
	}

	async webhookSetEnabled(input: { handle: string; enabled: boolean }): Promise<WebhookRecord> {
		const row = this.webhookRow(input.handle)
		if (!row) throw new KodyError('webhook_not_found', `Webhook "${input.handle}" was not found.`, { status: 404 })
		this.ctx.storage.sql.exec(
			'UPDATE webhooks SET enabled = ?, updated_at = ? WHERE handle = ?',
			input.enabled ? 1 : 0,
			nowIso(),
			input.handle,
		)
		return (await this.webhookGet(input.handle))!
	}

	async webhookDelete(handle: string) {
		const cursor = this.ctx.storage.sql.exec('DELETE FROM webhooks WHERE handle = ?', handle)
		this.ctx.storage.sql.exec('DELETE FROM webhook_deliveries WHERE handle = ?', handle)
		this.ctx.storage.sql.exec('DELETE FROM webhook_rate WHERE handle = ?', handle)
		this.ctx.storage.sql.exec('DELETE FROM webhook_idempotency WHERE handle = ?', handle)
		return { deleted: cursor.rowsWritten > 0 }
	}

	/**
	 * Decrypts the current URL secret. Only the authenticated HTTP reveal route
	 * and the admin API call this — never a capability, so the URL cannot end
	 * up in an MCP result or run history.
	 */
	async webhookReveal(handle: string): Promise<{ handle: string; secret: string; previousExpiresAt: string | null }> {
		const row = this.webhookRow(handle)
		if (!row) throw new KodyError('webhook_not_found', `Webhook "${handle}" was not found.`, { status: 404 })
		const secret = await decryptWithKeyring(await this.keyring(), this.userId, {
			iv: row.secret_iv,
			ciphertext: row.secret_ciphertext,
			keyId: row.secret_key_id || undefined,
		})
		return { handle, secret, previousExpiresAt: this.rowToWebhook(row).previousExpiresAt }
	}

	/**
	 * Ingress gate: matches the URL secret (current or unexpired previous),
	 * checks enabled + declaration, and counts the delivery against the
	 * per-minute rate limit. Every failure is reported so the route can log a
	 * delivery row and answer with the same generic status.
	 */
	async webhookAdmit(input: { handle: string; secret: string; now: string }): Promise<WebhookAdmission> {
		const row = this.webhookRow(input.handle)
		if (!row) return { ok: false, status: 404, reason: 'unknown_handle' }
		const provided = await sha256Hex(input.secret)
		const matchesCurrent = constantTimeEqual(provided, row.secret_hash)
		const previousLive =
			row.previous_secret_hash !== null &&
			row.previous_expires_at !== null &&
			new Date(row.previous_expires_at).getTime() > new Date(input.now).getTime()
		const matchesPrevious = previousLive && constantTimeEqual(provided, row.previous_secret_hash ?? '')
		if (!matchesCurrent && !matchesPrevious) return { ok: false, status: 404, reason: 'secret_mismatch' }
		if (row.enabled !== 1) return { ok: false, status: 404, reason: 'disabled' }
		const definition = this.webhookDefinition(row.package_name, row.webhook_name)
		if (!definition) return { ok: false, status: 404, reason: 'not_declared' }
		const minute = input.now.slice(0, 16)
		this.ctx.storage.sql.exec('DELETE FROM webhook_rate WHERE handle = ? AND minute != ?', input.handle, minute)
		const count = Number(
			this.ctx.storage.sql
				.exec<{ n: number }>('SELECT n FROM webhook_rate WHERE handle = ? AND minute = ?', input.handle, minute)
				.toArray()[0]?.n ?? 0,
		)
		if (count >= definition.rateLimitPerMinute) return { ok: false, status: 429, reason: 'rate_limited' }
		this.ctx.storage.sql.exec(
			'INSERT INTO webhook_rate (handle, minute, n) VALUES (?, ?, 1) ON CONFLICT(handle, minute) DO UPDATE SET n = n + 1',
			input.handle,
			minute,
		)
		if (matchesCurrent && row.previous_secret_hash !== null) {
			this.ctx.storage.sql.exec(
				'UPDATE webhooks SET previous_secret_hash = NULL, previous_expires_at = NULL WHERE handle = ?',
				input.handle,
			)
		}
		this.ctx.storage.sql.exec(
			'UPDATE webhooks SET last_delivery_at = ?, deliveries = deliveries + 1 WHERE handle = ?',
			input.now,
			input.handle,
		)
		return { ok: true, webhook: this.rowToWebhook(row), definition, usedPrevious: !matchesCurrent }
	}

	/**
	 * Verifies a provider signature against HMAC-SHA256 of `message` under a
	 * stored secret. Both the plaintext key and the digest stay inside the cell;
	 * only the verdict crosses RPC.
	 */
	async webhookSignatureCheck(input: {
		packageName: string
		secretName: string
		message: string
		candidates: Array<string>
		encoding: WebhookVerification['encoding']
	}): Promise<{ ok: true; matches: boolean } | { ok: false; reason: 'secret_missing' }> {
		const resolved = await this.secretResolveValues({
			names: [{ name: input.secretName, scope: null }],
			packageName: input.packageName,
		})
		const value = resolved.values[input.secretName]
		if (value === undefined) return { ok: false, reason: 'secret_missing' }
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(value),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		)
		const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input.message)))
		let binary = ''
		for (const byte of digest) binary += String.fromCharCode(byte)
		const encoded = {
			hex: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
			base64: btoa(binary),
		}
		return { ok: true, matches: signatureMatches(input.candidates, encoded, input.encoding) }
	}

	async webhookDeliveryRecord(input: {
		handle: string
		status: WebhookDeliveryRecord['status']
		httpStatus: number
		reason?: string | null | undefined
		runId?: string | null | undefined
		idempotencyKey?: string | null | undefined
		bodyBytes: number
		contentType?: string | null | undefined
	}): Promise<string> {
		const id = randomId('whd')
		this.ctx.storage.sql.exec(
			`INSERT INTO webhook_deliveries (id, handle, received_at, finished_at, status, http_status, reason, run_id, idempotency_key, body_bytes, content_type)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.handle,
			nowIso(),
			input.status === 'accepted' ? null : nowIso(),
			input.status,
			input.httpStatus,
			input.reason ?? null,
			input.runId ?? null,
			input.idempotencyKey ?? null,
			input.bodyBytes,
			input.contentType ?? null,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM webhook_deliveries WHERE handle = ? AND id NOT IN
			   (SELECT id FROM webhook_deliveries WHERE handle = ? ORDER BY received_at DESC LIMIT 200)`,
			input.handle,
			input.handle,
		)
		return id
	}

	async webhookDeliveryFinish(input: {
		id: string
		status: 'success' | 'error'
		runId: string | null
		reason?: string | null | undefined
	}) {
		this.ctx.storage.sql.exec(
			'UPDATE webhook_deliveries SET status = ?, finished_at = ?, run_id = ?, reason = ? WHERE id = ?',
			input.status,
			nowIso(),
			input.runId,
			input.reason ?? null,
			input.id,
		)
	}

	async webhookDeliveryList(input: {
		handle?: string | undefined
		limit?: number | undefined
	}): Promise<Array<WebhookDeliveryRecord>> {
		const limit = Math.min(Math.max(input.limit ?? 20, 1), 200)
		const rows = (
			input.handle
				? this.ctx.storage.sql.exec(
						'SELECT * FROM webhook_deliveries WHERE handle = ? ORDER BY received_at DESC LIMIT ?',
						input.handle,
						limit,
					)
				: this.ctx.storage.sql.exec('SELECT * FROM webhook_deliveries ORDER BY received_at DESC LIMIT ?', limit)
		).toArray() as Array<{
			id: string
			handle: string
			received_at: string
			finished_at: string | null
			status: WebhookDeliveryRecord['status']
			http_status: number
			reason: string | null
			run_id: string | null
			idempotency_key: string | null
			body_bytes: number
			content_type: string | null
		}>
		return rows.map((row) => ({
			id: row.id,
			handle: row.handle,
			receivedAt: row.received_at,
			finishedAt: row.finished_at,
			status: row.status,
			httpStatus: row.http_status,
			reason: row.reason,
			runId: row.run_id,
			idempotencyKey: row.idempotency_key,
			bodyBytes: row.body_bytes,
			contentType: row.content_type,
		}))
	}

	/**
	 * Idempotency ledger for deliveries. `payloadHash === null` means "match by
	 * key alone" (vendor delivery ids); otherwise a different payload under the
	 * same key is a conflict.
	 */
	async webhookIdempotencyClaim(input: {
		handle: string
		key: string
		payloadHash: string | null
	}): Promise<
		| { state: 'new' }
		| { state: 'in_progress' }
		| { state: 'conflict' }
		| { state: 'replay'; runId: string | null; resultJson: string | null; status: string }
	> {
		const existing = this.ctx.storage.sql
			.exec<{ payload_hash: string | null; run_id: string | null; status: string; result_json: string | null }>(
				'SELECT payload_hash, run_id, status, result_json FROM webhook_idempotency WHERE handle = ? AND key = ?',
				input.handle,
				input.key,
			)
			.toArray()[0]
		if (existing) {
			if (input.payloadHash !== null && existing.payload_hash !== null && existing.payload_hash !== input.payloadHash) {
				return { state: 'conflict' }
			}
			if (existing.status === 'running') return { state: 'in_progress' }
			return { state: 'replay', runId: existing.run_id, resultJson: existing.result_json, status: existing.status }
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO webhook_idempotency (handle, key, payload_hash, status, created_at) VALUES (?, ?, ?, 'running', ?)`,
			input.handle,
			input.key,
			input.payloadHash,
			nowIso(),
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM webhook_idempotency WHERE handle = ? AND key NOT IN
			   (SELECT key FROM webhook_idempotency WHERE handle = ? ORDER BY created_at DESC LIMIT 1000)`,
			input.handle,
			input.handle,
		)
		return { state: 'new' }
	}

	async webhookIdempotencyFinish(input: {
		handle: string
		key: string
		status: 'success' | 'error'
		runId: string | null
		resultJson: string | null
	}) {
		this.ctx.storage.sql.exec(
			'UPDATE webhook_idempotency SET status = ?, run_id = ?, result_json = ? WHERE handle = ? AND key = ?',
			input.status,
			input.runId,
			input.resultJson !== null && input.resultJson.length > 64 * 1024 ? null : input.resultJson,
			input.handle,
			input.key,
		)
	}

	// ---------------------------------------------------------- subscriptions

	/** Packages subscribed to a topic, with the handler module to run. */
	async subscriptionList(
		filter: { topic?: string | undefined } = {},
	): Promise<Array<SubscriptionDefinition & { packageName: string }>> {
		const out: Array<SubscriptionDefinition & { packageName: string }> = []
		for (const pkg of await this.packageList()) {
			for (const subscription of pkg.manifest.subscriptions) {
				if (filter.topic !== undefined && subscription.topic !== filter.topic) continue
				out.push({ ...subscription, packageName: pkg.name })
			}
		}
		return out
	}

	// ------------------------------------------------------------------ email

	private rowToEmail(row: {
		id: string
		direction: 'inbound' | 'outbound'
		inbox_address: string | null
		from_json: string
		to_json: string
		cc_json: string
		reply_to_json: string
		subject: string
		message_id: string | null
		in_reply_to: string | null
		references_json: string
		text: string | null
		html: string | null
		headers_json: string
		attachments_json: string
		classification: 'inbox' | 'quarantine' | null
		classification_reason: string | null
		provider: string
		provider_message_id: string | null
		delivery_status: string | null
		size_bytes: number
		package_name: string | null
		in_reply_to_message_id: string | null
		received_at: string
		created_at: string
	}): EmailMessageRecord {
		return {
			id: row.id,
			direction: row.direction,
			inboxAddress: row.inbox_address,
			from: JSON.parse(row.from_json) as EmailAddress,
			to: JSON.parse(row.to_json) as Array<EmailAddress>,
			cc: JSON.parse(row.cc_json) as Array<EmailAddress>,
			replyTo: JSON.parse(row.reply_to_json) as Array<EmailAddress>,
			subject: row.subject,
			messageId: row.message_id,
			inReplyTo: row.in_reply_to,
			references: JSON.parse(row.references_json) as Array<string>,
			text: row.text,
			html: row.html,
			headers: JSON.parse(row.headers_json) as Record<string, string>,
			attachments: JSON.parse(row.attachments_json) as Array<EmailAttachmentMeta>,
			classification: row.classification,
			classificationReason: row.classification_reason,
			provider: row.provider,
			providerMessageId: row.provider_message_id,
			deliveryStatus: row.delivery_status,
			sizeBytes: row.size_bytes,
			packageName: row.package_name,
			inReplyToMessageId: row.in_reply_to_message_id,
			receivedAt: row.received_at,
			createdAt: row.created_at,
		}
	}

	private emailSummary(record: EmailMessageRecord): EmailMessageSummary {
		const { text, html, headers: _headers, ...rest } = record
		return { ...rest, snippet: snippetOf(text, html) }
	}

	/** Sender rules decide inbox vs quarantine; first match wins (address before domain). */
	async emailClassify(from: string): Promise<{ classification: 'inbox' | 'quarantine'; reason: string }> {
		const address = normalizeEmailAddress(from)
		const domain = address.split('@')[1] ?? ''
		const rules = await this.emailSenderRuleList()
		const byAddress = rules.find((rule) => rule.kind === 'address' && rule.value === address)
		const byDomain = rules.find(
			(rule) => rule.kind === 'domain' && (rule.value === domain || domain.endsWith(`.${rule.value}`)),
		)
		const match = byAddress ?? byDomain
		if (!match) return { classification: 'inbox', reason: 'no_rule' }
		if (match.effect === 'allow') return { classification: 'inbox', reason: `rule:${match.id}` }
		if (match.effect === 'block') return { classification: 'quarantine', reason: `blocked:${match.id}` }
		return { classification: 'quarantine', reason: `rule:${match.id}` }
	}

	async emailMessageStore(input: {
		direction: 'inbound' | 'outbound'
		inboxAddress?: string | null | undefined
		from: EmailAddress
		to: Array<EmailAddress>
		cc?: Array<EmailAddress> | undefined
		replyTo?: Array<EmailAddress> | undefined
		subject: string
		messageId?: string | null | undefined
		inReplyTo?: string | null | undefined
		references?: Array<string> | undefined
		text?: string | null | undefined
		html?: string | null | undefined
		headers?: Record<string, string> | undefined
		attachments: Array<EmailAttachmentMeta & { contentBase64: string }>
		classification?: 'inbox' | 'quarantine' | null | undefined
		classificationReason?: string | null | undefined
		provider: string
		providerMessageId?: string | null | undefined
		deliveryStatus?: string | null | undefined
		packageName?: string | null | undefined
		inReplyToMessageId?: string | null | undefined
		receivedAt?: string | undefined
		maxBytes: number
	}): Promise<EmailMessageRecord> {
		if (input.providerMessageId) {
			const existing = this.ctx.storage.sql
				.exec<{ id: string }>(
					'SELECT id FROM email_messages WHERE provider = ? AND provider_message_id = ? AND direction = ?',
					input.provider,
					input.providerMessageId,
					input.direction,
				)
				.toArray()[0]
			if (existing) {
				throw new KodyError('email_duplicate', `Message ${input.providerMessageId} was already stored.`, {
					status: 409,
					details: { id: existing.id },
				})
			}
		}
		const day = utcDay()
		const usage = this.usageFor(day)
		if (input.direction === 'inbound')
			this.assertQuota('emailReceivesPerDay', usage.emailReceives, 'Daily inbound email')
		else this.assertQuota('emailSendsPerDay', usage.emailSends, 'Daily outbound email')
		this.assertQuota('emailMessages', this.count('email_messages'), 'Stored email')
		const text = input.text ?? null
		const html = input.html ?? null
		const attachmentBytes = input.attachments.reduce((sum, item) => sum + item.size, 0)
		const sizeBytes = (text?.length ?? 0) + (html?.length ?? 0) + attachmentBytes
		if (sizeBytes > input.maxBytes) {
			throw new KodyError(
				'email_too_large',
				`Message is ${sizeBytes} bytes; the stored-message limit is ${input.maxBytes} bytes.`,
				{ status: 413 },
			)
		}
		const id = randomId('eml')
		const now = nowIso()
		this.ctx.storage.sql.exec(
			`INSERT INTO email_messages (id, direction, inbox_address, from_json, to_json, cc_json, reply_to_json, subject, message_id,
			   in_reply_to, references_json, text, html, headers_json, attachments_json, classification, classification_reason,
			   provider, provider_message_id, delivery_status, size_bytes, package_name, in_reply_to_message_id, received_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.direction,
			input.inboxAddress ?? null,
			JSON.stringify(input.from),
			JSON.stringify(input.to),
			JSON.stringify(input.cc ?? []),
			JSON.stringify(input.replyTo ?? []),
			input.subject,
			input.messageId ?? null,
			input.inReplyTo ?? null,
			JSON.stringify(input.references ?? []),
			text,
			html,
			JSON.stringify(input.headers ?? {}),
			JSON.stringify(input.attachments.map(({ contentBase64: _content, ...meta }) => meta)),
			input.classification ?? null,
			input.classificationReason ?? null,
			input.provider,
			input.providerMessageId ?? null,
			input.deliveryStatus ?? null,
			sizeBytes,
			input.packageName ?? null,
			input.inReplyToMessageId ?? null,
			input.receivedAt ?? now,
			now,
		)
		for (const attachment of input.attachments) {
			this.ctx.storage.sql.exec(
				'INSERT INTO email_attachments (id, message_id, content_base64) VALUES (?, ?, ?)',
				attachment.id,
				id,
				attachment.contentBase64,
			)
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO usage_daily (day, email_sends, email_receives) VALUES (?, ?, ?)
			 ON CONFLICT(day) DO UPDATE SET email_sends = email_sends + excluded.email_sends, email_receives = email_receives + excluded.email_receives`,
			day,
			input.direction === 'outbound' ? 1 : 0,
			input.direction === 'inbound' ? 1 : 0,
		)
		return (await this.emailMessageGet(id))!
	}

	async emailMessageGet(id: string): Promise<EmailMessageRecord | null> {
		const row = this.ctx.storage.sql.exec('SELECT * FROM email_messages WHERE id = ?', id).toArray()[0]
		return row ? this.rowToEmail(row as Parameters<UserCell['rowToEmail']>[0]) : null
	}

	async emailMessageList(input: {
		direction?: 'inbound' | 'outbound' | undefined
		classification?: 'inbox' | 'quarantine' | undefined
		inboxAddress?: string | undefined
		/** Case-insensitive substring match over subject, sender, and text body. */
		query?: string | undefined
		limit?: number | undefined
	}): Promise<Array<EmailMessageSummary>> {
		const limit = Math.min(Math.max(input.limit ?? 20, 1), 200)
		const where: Array<string> = []
		const params: Array<string> = []
		if (input.direction) {
			where.push('direction = ?')
			params.push(input.direction)
		}
		if (input.classification) {
			where.push('classification = ?')
			params.push(input.classification)
		}
		if (input.inboxAddress) {
			where.push('inbox_address = ?')
			params.push(normalizeEmailAddress(input.inboxAddress))
		}
		if (input.query?.trim()) {
			const like = `%${input.query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`
			where.push("(subject LIKE ? ESCAPE '\\' OR from_json LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')")
			params.push(like, like, like)
		}
		const sql = `SELECT * FROM email_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_at DESC LIMIT ?`
		return (
			this.ctx.storage.sql.exec(sql, ...params, limit).toArray() as Array<Parameters<UserCell['rowToEmail']>[0]>
		).map((row) => this.emailSummary(this.rowToEmail(row)))
	}

	async emailMessageDelete(id: string) {
		const cursor = this.ctx.storage.sql.exec('DELETE FROM email_messages WHERE id = ?', id)
		this.ctx.storage.sql.exec('DELETE FROM email_attachments WHERE message_id = ?', id)
		this.ctx.storage.sql.exec('DELETE FROM email_delivery_events WHERE message_id = ?', id)
		return { deleted: cursor.rowsWritten > 0 }
	}

	async emailMessageRelease(id: string): Promise<EmailMessageRecord> {
		const message = await this.emailMessageGet(id)
		if (!message) throw new KodyError('email_not_found', `Message "${id}" was not found.`, { status: 404 })
		this.ctx.storage.sql.exec(
			`UPDATE email_messages SET classification = 'inbox', classification_reason = 'released' WHERE id = ?`,
			id,
		)
		return (await this.emailMessageGet(id))!
	}

	async emailAttachmentGet(input: {
		messageId: string
		attachmentId: string
	}): Promise<(EmailAttachmentMeta & { contentBase64: string }) | null> {
		const message = await this.emailMessageGet(input.messageId)
		const meta = message?.attachments.find((item) => item.id === input.attachmentId)
		if (!meta) return null
		const row = this.ctx.storage.sql
			.exec<{ content_base64: string }>(
				'SELECT content_base64 FROM email_attachments WHERE id = ? AND message_id = ?',
				input.attachmentId,
				input.messageId,
			)
			.toArray()[0]
		if (!row) return null
		return { ...meta, contentBase64: row.content_base64 }
	}

	async emailMessageSetDelivery(input: {
		id?: string | undefined
		providerMessageId?: string | undefined
		provider: string
		status: string
		event: string
		detail?: string | null | undefined
		at?: string | undefined
	}): Promise<EmailMessageRecord | null> {
		const row = (
			input.id
				? this.ctx.storage.sql.exec('SELECT id FROM email_messages WHERE id = ?', input.id)
				: this.ctx.storage.sql.exec(
						`SELECT id FROM email_messages WHERE provider = ? AND provider_message_id = ? AND direction = 'outbound'`,
						input.provider,
						input.providerMessageId ?? '',
					)
		).toArray()[0] as { id: string } | undefined
		if (!row) return null
		if (input.id === undefined && input.providerMessageId === undefined) return null
		this.ctx.storage.sql.exec('UPDATE email_messages SET delivery_status = ? WHERE id = ?', input.status, row.id)
		if (input.providerMessageId !== undefined) {
			this.ctx.storage.sql.exec(
				'UPDATE email_messages SET provider_message_id = COALESCE(provider_message_id, ?) WHERE id = ?',
				input.providerMessageId,
				row.id,
			)
		}
		this.ctx.storage.sql.exec(
			'INSERT INTO email_delivery_events (id, message_id, provider, event, status, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			randomId('evt'),
			row.id,
			input.provider,
			input.event,
			input.status,
			input.detail ?? null,
			input.at ?? nowIso(),
		)
		return this.emailMessageGet(row.id)
	}

	async emailDeliveryEventList(messageId: string): Promise<Array<EmailDeliveryEvent>> {
		return this.ctx.storage.sql
			.exec<{
				id: string
				message_id: string
				provider: string
				event: string
				status: string
				detail: string | null
				at: string
			}>('SELECT * FROM email_delivery_events WHERE message_id = ? ORDER BY at DESC LIMIT 50', messageId)
			.toArray()
			.map((row) => ({
				id: row.id,
				messageId: row.message_id,
				provider: row.provider,
				event: row.event,
				status: row.status,
				detail: row.detail,
				at: row.at,
			}))
	}

	// destinations: addresses this user may send to. The account email is
	// always allowed; others need a verification code delivered to them.

	private rowToDestination(row: {
		address: string
		verified: number
		is_default: number
		created_at: string
		verified_at: string | null
		code_expires_at: string | null
	}): EmailDestinationRecord {
		return {
			address: row.address,
			verified: row.verified === 1,
			isDefault: row.is_default === 1,
			createdAt: row.created_at,
			verifiedAt: row.verified_at,
			codeExpiresAt: row.verified === 1 ? null : row.code_expires_at,
		}
	}

	async emailDestinationList(): Promise<Array<EmailDestinationRecord>> {
		return (
			this.ctx.storage.sql
				.exec('SELECT * FROM email_destinations ORDER BY is_default DESC, address')
				.toArray() as Array<Parameters<UserCell['rowToDestination']>[0]>
		).map((row) => this.rowToDestination(row))
	}

	/** Adds a destination and returns the one-time code to email to it (the caller sends it; it is never stored in plaintext). */
	async emailDestinationBegin(input: {
		address: string
		preVerified?: boolean | undefined
	}): Promise<{ destination: EmailDestinationRecord; code: string | null }> {
		const address = normalizeEmailAddress(input.address)
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) {
			throw new KodyError('invalid_email_address', `"${input.address}" is not a valid email address.`)
		}
		const now = nowIso()
		const existing = this.ctx.storage.sql
			.exec<{ verified: number }>('SELECT verified FROM email_destinations WHERE address = ?', address)
			.toArray()[0]
		if (existing?.verified === 1 || input.preVerified) {
			this.ctx.storage.sql.exec(
				`INSERT INTO email_destinations (address, verified, created_at, verified_at, is_default) VALUES (?, 1, ?, ?, ?)
				 ON CONFLICT(address) DO UPDATE SET verified = 1, verified_at = COALESCE(email_destinations.verified_at, excluded.verified_at), code_hash = NULL, code_expires_at = NULL`,
				address,
				now,
				now,
				this.count_destinations() === 0 ? 1 : 0,
			)
			return { destination: (await this.emailDestinationList()).find((d) => d.address === address)!, code: null }
		}
		const digits = new Uint32Array(1)
		crypto.getRandomValues(digits)
		const code = String((digits[0] ?? 0) % 1_000_000).padStart(6, '0')
		this.ctx.storage.sql.exec(
			`INSERT INTO email_destinations (address, verified, code_hash, code_expires_at, created_at) VALUES (?, 0, ?, ?, ?)
			 ON CONFLICT(address) DO UPDATE SET code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at`,
			address,
			await sha256Hex(`${address}:${code}`),
			new Date(Date.now() + emailDestinationCodeTtlMs).toISOString(),
			now,
		)
		return { destination: (await this.emailDestinationList()).find((d) => d.address === address)!, code }
	}

	private count_destinations() {
		return Number(
			this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM email_destinations').toArray()[0]?.n ?? 0,
		)
	}

	async emailDestinationVerify(input: { address: string; code: string }): Promise<EmailDestinationRecord> {
		const address = normalizeEmailAddress(input.address)
		const row = this.ctx.storage.sql
			.exec<{ code_hash: string | null; code_expires_at: string | null; verified: number }>(
				'SELECT code_hash, code_expires_at, verified FROM email_destinations WHERE address = ?',
				address,
			)
			.toArray()[0]
		if (!row)
			throw new KodyError('email_destination_not_found', `No pending destination "${address}".`, { status: 404 })
		if (row.verified === 1) return (await this.emailDestinationList()).find((d) => d.address === address)!
		const expired = !row.code_expires_at || new Date(row.code_expires_at).getTime() < Date.now()
		const provided = await sha256Hex(`${address}:${String(input.code ?? '').trim()}`)
		if (expired || !row.code_hash || !constantTimeEqual(provided, row.code_hash)) {
			throw new KodyError('email_verification_failed', 'The verification code is wrong or expired.', { status: 400 })
		}
		const now = nowIso()
		this.ctx.storage.sql.exec(
			'UPDATE email_destinations SET verified = 1, verified_at = ?, code_hash = NULL, code_expires_at = NULL, is_default = ? WHERE address = ?',
			now,
			this.ctx.storage.sql.exec('SELECT 1 FROM email_destinations WHERE is_default = 1').toArray().length ? 0 : 1,
			address,
		)
		return (await this.emailDestinationList()).find((d) => d.address === address)!
	}

	async emailDestinationSetDefault(address: string): Promise<EmailDestinationRecord> {
		const normalized = normalizeEmailAddress(address)
		if (!(await this.emailDestinationIsVerified(normalized))) {
			throw new KodyError('email_destination_unverified', `"${normalized}" is not a verified destination.`, {
				status: 404,
			})
		}
		this.ctx.storage.sql.exec(
			'UPDATE email_destinations SET is_default = CASE WHEN address = ? THEN 1 ELSE 0 END',
			normalized,
		)
		return (await this.emailDestinationList()).find((d) => d.address === normalized)!
	}

	async emailDestinationRemove(address: string) {
		const cursor = this.ctx.storage.sql.exec(
			'DELETE FROM email_destinations WHERE address = ?',
			normalizeEmailAddress(address),
		)
		return { deleted: cursor.rowsWritten > 0 }
	}

	async emailDestinationIsVerified(address: string): Promise<boolean> {
		return (
			this.ctx.storage.sql
				.exec('SELECT 1 FROM email_destinations WHERE address = ? AND verified = 1', normalizeEmailAddress(address))
				.toArray().length > 0
		)
	}

	async emailSenderRuleList(): Promise<Array<EmailSenderRule>> {
		return this.ctx.storage.sql
			.exec<{
				id: string
				kind: 'address' | 'domain'
				value: string
				effect: 'allow' | 'block' | 'quarantine'
				note: string | null
				created_at: string
			}>('SELECT * FROM email_sender_rules ORDER BY kind, value')
			.toArray()
			.map((row) => ({
				id: row.id,
				kind: row.kind,
				value: row.value,
				effect: row.effect,
				note: row.note,
				createdAt: row.created_at,
			}))
	}

	async emailSenderRuleSet(input: {
		kind: 'address' | 'domain'
		value: string
		effect: 'allow' | 'block' | 'quarantine'
		note?: string | null | undefined
	}): Promise<EmailSenderRule> {
		const value = normalizeEmailAddress(input.value)
		if (input.kind === 'address' && !value.includes('@')) {
			throw new KodyError('invalid_args', 'Address rules need a full email address.')
		}
		if (input.kind === 'domain' && (value.includes('@') || !value.includes('.'))) {
			throw new KodyError('invalid_args', 'Domain rules need a bare domain like "example.com".')
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO email_sender_rules (id, kind, value, effect, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(kind, value) DO UPDATE SET effect = excluded.effect, note = excluded.note`,
			randomId('rule'),
			input.kind,
			value,
			input.effect,
			input.note ?? null,
			nowIso(),
		)
		return (await this.emailSenderRuleList()).find((rule) => rule.kind === input.kind && rule.value === value)!
	}

	async emailSenderRuleDelete(id: string) {
		const cursor = this.ctx.storage.sql.exec('DELETE FROM email_sender_rules WHERE id = ?', id)
		return { deleted: cursor.rowsWritten > 0 }
	}
}
