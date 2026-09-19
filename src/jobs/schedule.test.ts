import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeNextRun, minimumIntervalMs, nextCronOccurrence, parseIntervalMs, validateSchedule } from './schedule.ts'

describe('parseIntervalMs', () => {
	it('parses common units', () => {
		assert.equal(parseIntervalMs('5m'), 5 * 60_000)
		assert.equal(parseIntervalMs('2 hours'), 2 * 3_600_000)
		assert.equal(parseIntervalMs('1d'), 86_400_000)
	})

	it('rejects garbage and sub-minute intervals', () => {
		assert.throws(() => parseIntervalMs('soon'), /interval/i)
		assert.throws(() => validateSchedule({ type: 'interval', every: '10s' }), /at least/i)
		assert.equal(minimumIntervalMs, 60_000)
	})
})

describe('nextCronOccurrence', () => {
	it('advances to the next matching minute', () => {
		const after = new Date('2026-01-01T00:00:30Z')
		assert.equal(nextCronOccurrence('*/5 * * * *', after).toISOString(), '2026-01-01T00:05:00.000Z')
		assert.equal(nextCronOccurrence('0 9 * * 1', after).toISOString(), '2026-01-05T09:00:00.000Z')
	})

	it('honours IANA timezones', () => {
		const after = new Date('2026-07-01T00:00:00Z')
		// 09:00 in New York during DST is 13:00 UTC.
		assert.equal(nextCronOccurrence('0 9 * * *', after, 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z')
	})

	it('rejects invalid expressions and timezones', () => {
		assert.throws(() => validateSchedule({ type: 'cron', expression: '* * *' }), /cron/i)
		assert.throws(() => validateSchedule({ type: 'cron', expression: '0 9 * * *' }, 'Mars/Olympus'), /timezone/i)
	})
})

describe('computeNextRun', () => {
	const now = new Date('2026-03-01T12:00:00Z')

	it('anchors intervals on the last run and skips missed slots', () => {
		const next = computeNextRun({ type: 'interval', every: '1h' }, { now, lastRunAt: new Date('2026-03-01T09:30:00Z') })
		assert.equal(next?.toISOString(), '2026-03-01T12:30:00.000Z')
	})

	it('runs a past-due once job immediately and only once', () => {
		const schedule = { type: 'once', runAt: '2020-01-01T00:00:00Z' } as const
		assert.equal(computeNextRun(schedule, { now })?.toISOString(), now.toISOString())
		assert.equal(computeNextRun(schedule, { now, lastRunAt: now }), null)
	})

	it('keeps a future once job at its runAt', () => {
		const schedule = { type: 'once', runAt: '2030-01-01T00:00:00Z' } as const
		assert.equal(computeNextRun(schedule, { now })?.toISOString(), '2030-01-01T00:00:00.000Z')
	})
})
