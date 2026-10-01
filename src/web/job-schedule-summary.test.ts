import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { summarizeJobSchedule } from './job-schedule-summary.ts'

describe('summarizeJobSchedule', () => {
	it('summarizes cron, interval, and once schedules', () => {
		assert.equal(summarizeJobSchedule({ type: 'cron', expression: '0 2 * * *' }), '0 2 * * *')
		assert.equal(summarizeJobSchedule({ type: 'interval', every: '1m' }), 'every 1m')
		assert.equal(
			summarizeJobSchedule({ type: 'once', runAt: '2026-01-02T03:04:05.000Z' }),
			'once at 2026-01-02T03:04:05.000Z',
		)
	})
})
