import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	defaultLimits,
	defaultQuotas,
	effectiveQuotas,
	limitsFromEnv,
	parseQuotaOverride,
	quotasFromEnv,
	utcDay,
	withinQuota,
} from './limits.ts'

describe('limits', () => {
	it('falls back to defaults for unset or empty vars', () => {
		assert.deepEqual(limitsFromEnv({}), defaultLimits)
		assert.deepEqual(limitsFromEnv({ KODY_EXECUTE_TIMEOUT_MS: '' }), defaultLimits)
		assert.deepEqual(quotasFromEnv({}), defaultQuotas)
	})

	it('reads integers and rejects garbage or out-of-range values', () => {
		assert.equal(limitsFromEnv({ KODY_EXECUTE_TIMEOUT_MS: '120000' }).executeTimeoutMs, 120_000)
		assert.equal(limitsFromEnv({ KODY_RUN_RETENTION_DAYS: '30' }).runRetentionDays, 30)
		assert.throws(
			() => limitsFromEnv({ KODY_EXECUTE_TIMEOUT_MS: 'soon' }),
			/KODY_EXECUTE_TIMEOUT_MS: Expected an integer/,
		)
		assert.throws(() => limitsFromEnv({ KODY_EXECUTE_TIMEOUT_MS: '10' }), /between 1000 and 900000/)
		assert.throws(() => quotasFromEnv({ KODY_QUOTA_RUNS_PER_DAY: '-1' }), /KODY_QUOTA_RUNS_PER_DAY/)
	})

	it('validates per-user overrides', () => {
		assert.deepEqual(parseQuotaOverride({ runsPerDay: 10, secrets: 0 }), { runsPerDay: 10, secrets: 0 })
		assert.throws(() => parseQuotaOverride({ nope: 1 }), /Unknown quota "nope"/)
		assert.throws(() => parseQuotaOverride({ runsPerDay: 1.5 }), /non-negative integer/)
		assert.throws(() => parseQuotaOverride([]), /must be an object/)
	})

	it('merges overrides on top of env defaults', () => {
		const defaults = quotasFromEnv({ KODY_QUOTA_RUNS_PER_DAY: '100', KODY_QUOTA_SECRETS: '5' })
		assert.deepEqual(effectiveQuotas(defaults, { runsPerDay: 0 }), { ...defaults, runsPerDay: 0 })
		assert.deepEqual(effectiveQuotas(defaults, null), defaults)
	})

	it('treats 0 as unlimited', () => {
		assert.equal(withinQuota(0, 1_000_000), true)
		assert.equal(withinQuota(3, 2), true)
		assert.equal(withinQuota(3, 3), false)
	})

	it('buckets usage by UTC day', () => {
		assert.equal(utcDay(new Date('2026-09-19T23:59:59.000Z')), '2026-09-19')
		assert.equal(utcDay(new Date('2026-09-20T00:00:00.000Z')), '2026-09-20')
	})
})
