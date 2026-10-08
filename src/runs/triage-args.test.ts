import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	parseErrorTriageFilter,
	parseRunTriage,
	parseRunTriageBulk,
	parseSince,
	parseTriageNote,
	runTriageMaxNoteLength,
} from './triage-args.ts'

function invalidArgs(fn: () => unknown, pattern: RegExp) {
	assert.throws(fn, (error: unknown) => {
		const e = error as { code?: string; status?: number; message?: string }
		return e.code === 'invalid_args' && e.status === 400 && pattern.test(e.message ?? '')
	})
}

describe('parseRunTriage', () => {
	it('accepts ignored, resolved and open', () => {
		assert.equal(parseRunTriage('ignored'), 'ignored')
		assert.equal(parseRunTriage('resolved'), 'resolved')
		assert.equal(parseRunTriage('open'), 'open')
	})
	it('refuses anything else', () => {
		invalidArgs(() => parseRunTriage('closed'), /triage must be one of/)
		invalidArgs(() => parseRunTriage(undefined), /triage must be one of/)
	})
})

describe('parseTriageNote', () => {
	it('keeps the current note when omitted and clears it with an empty string', () => {
		assert.equal(parseTriageNote(undefined), undefined)
		assert.equal(parseTriageNote(''), '')
		assert.equal(parseTriageNote('flaky upstream'), 'flaky upstream')
	})
	it('refuses notes over the limit and non-strings', () => {
		assert.equal(parseTriageNote('x'.repeat(runTriageMaxNoteLength))?.length, runTriageMaxNoteLength)
		invalidArgs(() => parseTriageNote('x'.repeat(runTriageMaxNoteLength + 1)), /at most 2000/)
		invalidArgs(() => parseTriageNote(42), /note must be a string/)
	})
})

describe('parseErrorTriageFilter', () => {
	it('uses the fallback when omitted', () => {
		assert.equal(parseErrorTriageFilter(undefined, 'all'), 'all')
		assert.equal(parseErrorTriageFilter('open', 'all'), 'open')
	})
	it('refuses unknown filters', () => {
		invalidArgs(() => parseErrorTriageFilter('closed', 'all'), /errorTriage must be one of/)
	})
})

describe('parseSince', () => {
	it('accepts ISO times and null when omitted', () => {
		assert.equal(parseSince(undefined), null)
		assert.equal(parseSince('2026-10-01T00:00:00Z'), '2026-10-01T00:00:00.000Z')
	})
	it('refuses unparseable times', () => {
		invalidArgs(() => parseSince('last tuesday'), /since must be an ISO 8601 time/)
	})
})

describe('parseRunTriageBulk', () => {
	it('takes explicit run ids with defaults', () => {
		assert.deepEqual(parseRunTriageBulk({ runIds: ['run_a', 'run_b'], triage: 'resolved' }), {
			runIds: ['run_a', 'run_b'],
			filter: null,
			triage: 'resolved',
			note: undefined,
			limit: 100,
			dryRun: false,
		})
	})
	it('takes an exact filter and defaults its errorTriage to open when setting triage', () => {
		const input = parseRunTriageBulk({
			filter: { kind: 'job', jobId: '@a/b#c' },
			triage: 'ignored',
			limit: 5,
			dryRun: true,
		})
		assert.deepEqual(input.filter, { kind: 'job', jobId: '@a/b#c', errorTriage: 'open' })
		assert.equal(input.limit, 5)
		assert.equal(input.dryRun, true)
	})
	it('requires exactly one selector', () => {
		invalidArgs(() => parseRunTriageBulk({ triage: 'resolved' }), /exactly one of runIds or filter/)
		invalidArgs(
			() => parseRunTriageBulk({ runIds: ['run_a'], filter: { kind: 'job' }, triage: 'resolved' }),
			/exactly one of runIds or filter/,
		)
	})
	it('bounds runIds and limit', () => {
		invalidArgs(() => parseRunTriageBulk({ runIds: [], triage: 'resolved' }), /runIds must hold 1 to 100/)
		invalidArgs(
			() => parseRunTriageBulk({ runIds: Array.from({ length: 101 }, (_, i) => `run_${i}`), triage: 'resolved' }),
			/runIds must hold 1 to 100/,
		)
		invalidArgs(() => parseRunTriageBulk({ runIds: ['run_a'], triage: 'resolved', limit: 0 }), /limit must be 1 to 100/)
		invalidArgs(
			() => parseRunTriageBulk({ runIds: ['run_a'], triage: 'resolved', limit: 101 }),
			/limit must be 1 to 100/,
		)
	})
	it('requires at least one identity or error field in a filter', () => {
		invalidArgs(
			() => parseRunTriageBulk({ filter: { errorTriage: 'open' }, triage: 'resolved' }),
			/filter must include/,
		)
		invalidArgs(() => parseRunTriageBulk({ filter: { kind: 'cron' }, triage: 'resolved' }), /kind must be one of/)
	})
	it('refuses a filtered reopen unless it names ignored or resolved runs', () => {
		invalidArgs(() => parseRunTriageBulk({ filter: { kind: 'job' }, triage: 'open' }), /reopen requires errorTriage/)
		invalidArgs(
			() => parseRunTriageBulk({ filter: { kind: 'job', errorTriage: 'all' }, triage: 'open' }),
			/reopen requires errorTriage/,
		)
		assert.equal(
			parseRunTriageBulk({ filter: { kind: 'job', errorTriage: 'ignored' }, triage: 'open' }).filter?.errorTriage,
			'ignored',
		)
	})
})
