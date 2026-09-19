/**
 * Operator-tunable runtime limits and per-user quotas. Every value comes from
 * a `KODY_*` var (see docs/operations.md); unset means the default, and `0`
 * for a quota means "unlimited". Quotas can be overridden per user by an
 * admin (`PUT /admin/users/:id/quota`), which merges on top of the env values.
 */

export type Limits = {
	/** Wall-clock budget for one execute / package / job run. */
	executeTimeoutMs: number
	/** Newest N runs kept per user; older rows are pruned on the next finish. */
	runRetentionCount: number
	/** Runs older than this many days are pruned (0 = keep until the count limit). */
	runRetentionDays: number
	/** Max console entries persisted per run. */
	runLogLimit: number
	/** Default `responseLimit` for execute results. */
	responseLimitBytes: number
	/** Admin audit entries kept in the registry. */
	auditRetentionCount: number
}

export type Quotas = {
	/** Runs (execute + package + job) a user may start per UTC day. */
	runsPerDay: number
	/** Total execute wall-clock ms a user may consume per UTC day. */
	executeMsPerDay: number
	/** Saved packages per user. */
	packages: number
	/** Stored secrets per user (all scopes). */
	secrets: number
	/** Package-owned jobs per user. */
	jobs: number
}

export type LimitEnv = Partial<
	Record<
		| 'KODY_EXECUTE_TIMEOUT_MS'
		| 'KODY_RUN_RETENTION_COUNT'
		| 'KODY_RUN_RETENTION_DAYS'
		| 'KODY_RUN_LOG_LIMIT'
		| 'KODY_RESPONSE_LIMIT_BYTES'
		| 'KODY_AUDIT_RETENTION_COUNT'
		| 'KODY_QUOTA_RUNS_PER_DAY'
		| 'KODY_QUOTA_EXECUTE_MS_PER_DAY'
		| 'KODY_QUOTA_PACKAGES'
		| 'KODY_QUOTA_SECRETS'
		| 'KODY_QUOTA_JOBS',
		string | undefined
	>
>

export const defaultLimits: Limits = {
	executeTimeoutMs: 60_000,
	runRetentionCount: 500,
	runRetentionDays: 0,
	runLogLimit: 200,
	responseLimitBytes: 100_000,
	auditRetentionCount: 10_000,
}

/** All zero: unlimited unless the operator says otherwise. */
export const defaultQuotas: Quotas = {
	runsPerDay: 0,
	executeMsPerDay: 0,
	packages: 0,
	secrets: 0,
	jobs: 0,
}

export const quotaKeys = Object.keys(defaultQuotas) as Array<keyof Quotas>

function integer(raw: string | undefined, fallback: number, { min, max }: { min: number; max?: number }) {
	if (raw === undefined || raw.trim() === '') return fallback
	const value = Number(raw)
	if (!Number.isInteger(value)) {
		throw new Error(`Expected an integer, got "${raw}".`)
	}
	if (value < min || (max !== undefined && value > max)) {
		throw new Error(`Expected a value between ${min} and ${max ?? '∞'}, got ${value}.`)
	}
	return value
}

function read<T>(name: keyof LimitEnv, env: LimitEnv, parse: (raw: string | undefined) => T) {
	try {
		return parse(env[name])
	} catch (error) {
		throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
	}
}

export function limitsFromEnv(env: LimitEnv): Limits {
	return {
		executeTimeoutMs: read('KODY_EXECUTE_TIMEOUT_MS', env, (raw) =>
			integer(raw, defaultLimits.executeTimeoutMs, { min: 1_000, max: 15 * 60_000 }),
		),
		runRetentionCount: read('KODY_RUN_RETENTION_COUNT', env, (raw) =>
			integer(raw, defaultLimits.runRetentionCount, { min: 10, max: 100_000 }),
		),
		runRetentionDays: read('KODY_RUN_RETENTION_DAYS', env, (raw) =>
			integer(raw, defaultLimits.runRetentionDays, { min: 0, max: 3650 }),
		),
		runLogLimit: read('KODY_RUN_LOG_LIMIT', env, (raw) =>
			integer(raw, defaultLimits.runLogLimit, { min: 0, max: 10_000 }),
		),
		responseLimitBytes: read('KODY_RESPONSE_LIMIT_BYTES', env, (raw) =>
			integer(raw, defaultLimits.responseLimitBytes, { min: 1_000, max: 10_000_000 }),
		),
		auditRetentionCount: read('KODY_AUDIT_RETENTION_COUNT', env, (raw) =>
			integer(raw, defaultLimits.auditRetentionCount, { min: 100, max: 1_000_000 }),
		),
	}
}

export function quotasFromEnv(env: LimitEnv): Quotas {
	const nonNegative = (raw: string | undefined, fallback: number) => integer(raw, fallback, { min: 0 })
	return {
		runsPerDay: read('KODY_QUOTA_RUNS_PER_DAY', env, (raw) => nonNegative(raw, defaultQuotas.runsPerDay)),
		executeMsPerDay: read('KODY_QUOTA_EXECUTE_MS_PER_DAY', env, (raw) =>
			nonNegative(raw, defaultQuotas.executeMsPerDay),
		),
		packages: read('KODY_QUOTA_PACKAGES', env, (raw) => nonNegative(raw, defaultQuotas.packages)),
		secrets: read('KODY_QUOTA_SECRETS', env, (raw) => nonNegative(raw, defaultQuotas.secrets)),
		jobs: read('KODY_QUOTA_JOBS', env, (raw) => nonNegative(raw, defaultQuotas.jobs)),
	}
}

/**
 * Validates an admin-supplied per-user override: only known keys, each a
 * non-negative integer. Returns the normalized override (never `defaults`).
 */
export function parseQuotaOverride(input: unknown): Partial<Quotas> {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new Error('Quota override must be an object of { quota: nonNegativeInteger }.')
	}
	const override: Partial<Quotas> = {}
	for (const [key, value] of Object.entries(input)) {
		if (!quotaKeys.includes(key as keyof Quotas)) {
			throw new Error(`Unknown quota "${key}". Known quotas: ${quotaKeys.join(', ')}.`)
		}
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
			throw new Error(`Quota "${key}" must be a non-negative integer (0 = unlimited).`)
		}
		override[key as keyof Quotas] = value
	}
	return override
}

export function effectiveQuotas(defaults: Quotas, override: Partial<Quotas> | null) {
	return { ...defaults, ...(override ?? {}) }
}

/** `true` when a quota of `limit` allows one more unit on top of `used`. */
export function withinQuota(limit: number, used: number) {
	return limit === 0 || used < limit
}

export function utcDay(date = new Date()) {
	return date.toISOString().slice(0, 10)
}
