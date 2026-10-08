import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import {
	autoResolveBy,
	autoResolveNote,
	ensureRunTriageColumns,
	errorTriageWhere,
	RunTriageStore,
	triageFieldsFromRow,
} from './triage-store.ts'

/** Just enough of Durable Object `SqlStorage` (exec -> toArray/rowsWritten) for the store. */
function memorySql() {
	const db = new DatabaseSync(':memory:')
	return {
		exec(query: string, ...params: Array<string | number | null>) {
			const statement = db.prepare(query)
			if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...params), rowsWritten: 0 }
			const result = statement.run(...params)
			return { toArray: () => [], rowsWritten: Number(result.changes) }
		},
	} as unknown as SqlStorage
}

// Pre-change shape of `runs` (src/cells/user-cell.ts).
const runsDdl = `CREATE TABLE runs (
	id TEXT PRIMARY KEY, kind TEXT NOT NULL, package_name TEXT, idempotency_key TEXT,
	status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
	result_json TEXT, error_json TEXT, logs_json TEXT NOT NULL DEFAULT '[]',
	warnings_json TEXT NOT NULL DEFAULT '[]', gateway_json TEXT NOT NULL DEFAULT '[]')`

type Seed = {
	id: string
	kind?: string
	status: 'running' | 'success' | 'error'
	createdAt: string
	packageName?: string | null
	jobId?: string | null
	error?: { name: string; message: string } | null
	triage?: 'ignored' | 'resolved' | null
}

function setup(seeds: Array<Seed> = []) {
	const sql = memorySql()
	sql.exec(runsDdl)
	ensureRunTriageColumns(sql)
	for (const s of seeds) {
		sql.exec(
			`INSERT INTO runs (id, kind, package_name, status, created_at, error_json, job_id, error_triage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			s.id,
			s.kind ?? 'execute',
			s.packageName ?? null,
			s.status,
			s.createdAt,
			s.status === 'error' ? JSON.stringify(s.error ?? { name: 'Error', message: 'boom' }) : null,
			s.jobId ?? null,
			s.triage ?? null,
		)
	}
	const store = new RunTriageStore(sql, () => '2026-10-08T12:00:00.000Z')
	const row = (id: string) => sql.exec('SELECT * FROM runs WHERE id = ?', id).toArray()[0] as Record<string, unknown>
	return { sql, store, row }
}

describe('ensureRunTriageColumns', () => {
	it('migration adds columns to an existing table once', () => {
		const sql = memorySql()
		sql.exec(runsDdl)
		sql.exec(
			`INSERT INTO runs (id, kind, status, created_at, error_json) VALUES ('run_old', 'job', 'error', '2026-10-01T00:00:00Z', '{"name":"Error","message":"old"}')`,
		)
		ensureRunTriageColumns(sql)
		ensureRunTriageColumns(sql)
		const columns = (sql.exec(`SELECT name FROM pragma_table_info('runs')`).toArray() as Array<{ name: string }>).map(
			(c) => c.name,
		)
		for (const column of ['error_triage', 'triage_note', 'triaged_at', 'triaged_by', 'job_id']) {
			assert.equal(columns.filter((c) => c === column).length, 1, column)
		}
		const old = sql.exec(`SELECT * FROM runs WHERE id = 'run_old'`).toArray()[0] as Record<string, unknown>
		assert.deepEqual(triageFieldsFromRow(old), {
			errorTriage: null,
			triageNote: null,
			triagedAt: null,
			triagedBy: null,
			jobId: null,
		})
		assert.equal(new RunTriageStore(sql).summary(null).errors, 1)
	})
})

describe('RunTriageStore.summary', () => {
	it('counts open errors, ignored, resolved and running per kind since a time', () => {
		const { store } = setup([
			{ id: 'r1', kind: 'job', status: 'error', createdAt: '2026-10-08T01:00:00Z' },
			{ id: 'r2', kind: 'job', status: 'error', createdAt: '2026-10-08T02:00:00Z', triage: 'ignored' },
			{ id: 'r3', kind: 'execute', status: 'error', createdAt: '2026-10-08T03:00:00Z', triage: 'resolved' },
			{ id: 'r4', kind: 'execute', status: 'success', createdAt: '2026-10-08T04:00:00Z' },
			{ id: 'r5', kind: 'webhook', status: 'running', createdAt: '2026-10-08T05:00:00Z' },
			{ id: 'r0', kind: 'job', status: 'error', createdAt: '2026-10-01T00:00:00Z' },
		])
		assert.deepEqual(store.summary(null), {
			since: '2026-10-01T00:00:00Z',
			total: 6,
			errors: 2,
			ignored: 1,
			resolved: 1,
			running: 1,
			byKind: [
				{ kind: 'execute', total: 2, errors: 0 },
				{ kind: 'job', total: 3, errors: 2 },
				{ kind: 'webhook', total: 1, errors: 0 },
			],
		})
		const recent = store.summary('2026-10-08T00:00:00.000Z')
		assert.equal(recent.since, '2026-10-08T00:00:00.000Z')
		assert.equal(recent.total, 5)
		assert.equal(recent.errors, 1)
	})
	it('reports zeros since now when there are no runs', () => {
		const { store } = setup()
		assert.deepEqual(store.summary(null), {
			since: '2026-10-08T12:00:00.000Z',
			total: 0,
			errors: 0,
			ignored: 0,
			resolved: 0,
			running: 0,
			byKind: [],
		})
	})
})

describe('RunTriageStore.update', () => {
	it('ignores and resolves an error run with a note, keeps the note when omitted, clears it with an empty string', () => {
		const { store, row } = setup([{ id: 'r1', status: 'error', createdAt: '2026-10-08T01:00:00Z' }])
		assert.deepEqual(store.update({ runId: 'r1', triage: 'ignored', note: 'flaky', by: 'user_1' }), { ok: true })
		assert.deepEqual(triageFieldsFromRow(row('r1')), {
			errorTriage: 'ignored',
			triageNote: 'flaky',
			triagedAt: '2026-10-08T12:00:00.000Z',
			triagedBy: 'user_1',
			jobId: null,
		})
		store.update({ runId: 'r1', triage: 'resolved', note: undefined, by: 'user_1' })
		assert.equal(triageFieldsFromRow(row('r1')).errorTriage, 'resolved')
		assert.equal(triageFieldsFromRow(row('r1')).triageNote, 'flaky')
		store.update({ runId: 'r1', triage: 'resolved', note: '', by: 'user_1' })
		assert.equal(triageFieldsFromRow(row('r1')).triageNote, null)
		assert.equal(row('r1').status, 'error')
		assert.equal(row('r1').error_json, '{"name":"Error","message":"boom"}')
	})
	it('reopen clears every triage field', () => {
		const { store, row } = setup([{ id: 'r1', status: 'error', createdAt: '2026-10-08T01:00:00Z' }])
		store.update({ runId: 'r1', triage: 'ignored', note: 'flaky', by: 'user_1' })
		assert.deepEqual(store.update({ runId: 'r1', triage: 'open', note: undefined, by: 'user_1' }), { ok: true })
		const fields = triageFieldsFromRow(row('r1'))
		assert.equal(fields.errorTriage, null)
		assert.equal(fields.triageNote, null)
		assert.equal(fields.triagedAt, null)
		assert.equal(fields.triagedBy, null)
	})
	it('refuses ignored/resolved on non-error runs and reports unknown ids', () => {
		const { store } = setup([{ id: 'ok', status: 'success', createdAt: '2026-10-08T01:00:00Z' }])
		assert.deepEqual(store.update({ runId: 'ok', triage: 'resolved', note: undefined, by: 'u' }), {
			ok: false,
			reason: 'not_error',
			status: 'success',
		})
		assert.deepEqual(store.update({ runId: 'nope', triage: 'ignored', note: undefined, by: 'u' }), {
			ok: false,
			reason: 'not_found',
		})
	})
})

describe('RunTriageStore.bulk', () => {
	const errors = (n: number, extra: Partial<Seed> = {}) =>
		Array.from({ length: n }, (_, i) => ({
			id: `e${i}`,
			kind: 'job',
			status: 'error' as const,
			createdAt: `2026-10-08T0${Math.min(i, 9)}:00:0${i % 10}Z`,
			jobId: '@a/b#tick',
			...extra,
		}))

	it('updates explicit ids, skipping unknown and non-error runs', () => {
		const { store, row } = setup([...errors(2), { id: 'ok', status: 'success', createdAt: '2026-10-08T05:00:00Z' }])
		const result = store.bulk({
			runIds: ['e0', 'e1', 'ok', 'missing'],
			filter: null,
			triage: 'resolved',
			note: 'fixed upstream',
			limit: 100,
			dryRun: false,
			by: 'user_1',
		})
		assert.deepEqual(result.matchedRunIds.sort(), ['e0', 'e1'])
		assert.equal(result.updatedCount, 2)
		assert.equal(result.hasMore, false)
		assert.equal(triageFieldsFromRow(row('e0')).triageNote, 'fixed upstream')
		assert.equal(triageFieldsFromRow(row('ok')).errorTriage, null)
	})

	it('dry run previews matches without changing rows', () => {
		const { store, row } = setup(errors(3))
		const result = store.bulk({
			runIds: null,
			filter: { jobId: '@a/b#tick', errorTriage: 'open' },
			triage: 'ignored',
			note: undefined,
			limit: 100,
			dryRun: true,
			by: 'u',
		})
		assert.equal(result.matchedRunIds.length, 3)
		assert.equal(result.updatedCount, 0)
		assert.equal(result.dryRun, true)
		assert.equal(triageFieldsFromRow(row('e0')).errorTriage, null)
	})

	it('bulk by filter pages with hasMore until done', () => {
		const { store } = setup(errors(5))
		const input = {
			runIds: null,
			filter: { kind: 'job' as const, errorTriage: 'open' as const },
			triage: 'resolved' as const,
			note: undefined,
			limit: 2,
			dryRun: false,
			by: 'u',
		}
		const first = store.bulk(input)
		assert.equal(first.updatedCount, 2)
		assert.equal(first.hasMore, true)
		const second = store.bulk(input)
		assert.equal(second.updatedCount, 2)
		assert.equal(second.hasMore, true)
		const third = store.bulk(input)
		assert.equal(third.updatedCount, 1)
		assert.equal(third.hasMore, false)
		assert.equal(store.summary(null).resolved, 5)
	})

	it('matches error name and message exactly and reopens ignored runs by filter', () => {
		const { store, row } = setup([
			{
				id: 'a',
				status: 'error',
				createdAt: '2026-10-08T01:00:00Z',
				error: { name: 'TypeError', message: 'x is undefined' },
				triage: 'ignored',
			},
			{
				id: 'b',
				status: 'error',
				createdAt: '2026-10-08T02:00:00Z',
				error: { name: 'TypeError', message: 'x is undefined!' },
				triage: 'ignored',
			},
		])
		const reopened = store.bulk({
			runIds: null,
			filter: { errorName: 'TypeError', errorMessage: 'x is undefined', errorTriage: 'ignored' },
			triage: 'open',
			note: undefined,
			limit: 100,
			dryRun: false,
			by: 'u',
		})
		assert.deepEqual(reopened.matchedRunIds, ['a'])
		assert.equal(triageFieldsFromRow(row('a')).errorTriage, null)
		assert.equal(triageFieldsFromRow(row('b')).errorTriage, 'ignored')
	})
})

describe('RunTriageStore.bulk termination', () => {
	const fiveErrors = Array.from({ length: 5 }, (_, i) => ({
		id: `t${i}`,
		kind: 'job',
		status: 'error' as const,
		createdAt: `2026-10-08T01:00:0${i}Z`,
	}))

	it('repeating a filter that also matches already-triaged rows terminates', () => {
		const { store } = setup(fiveErrors)
		const input = {
			runIds: null,
			filter: { kind: 'job' as const, errorTriage: 'all' as const },
			triage: 'resolved' as const,
			note: undefined,
			limit: 2,
			dryRun: false,
			by: 'u',
		}
		const updated: Array<number> = []
		for (let call = 0; call < 10; call++) {
			const result = store.bulk(input)
			updated.push(result.updatedCount)
			if (!result.hasMore) break
		}
		assert.deepEqual(updated, [2, 2, 1])
		assert.equal(store.summary(null).resolved, 5)
	})

	it('runIds beyond the limit make progress on repeat', () => {
		const { store } = setup(fiveErrors)
		const input = {
			runIds: fiveErrors.map((row) => row.id),
			filter: null,
			triage: 'ignored' as const,
			note: undefined,
			limit: 2,
			dryRun: false,
			by: 'u',
		}
		const updated: Array<number> = []
		for (let call = 0; call < 10; call++) {
			const result = store.bulk(input)
			updated.push(result.updatedCount)
			if (!result.hasMore) break
		}
		assert.deepEqual(updated, [2, 2, 1])
	})

	it('reopening rows that are already open matches nothing (kody)', () => {
		const { store } = setup(fiveErrors.slice(0, 1))
		const result = store.bulk({
			runIds: ['t0'],
			filter: null,
			triage: 'open',
			note: undefined,
			limit: 100,
			dryRun: false,
			by: 'u',
		})
		assert.deepEqual(result, { matchedRunIds: [], updatedCount: 0, hasMore: false, dryRun: false })
	})
})

describe('RunTriageStore.autoResolveJob', () => {
	it('resolves only open errors of the same job and leaves ignored, other jobs and other kinds alone', () => {
		const { store, row } = setup([
			{ id: 'a1', kind: 'job', status: 'error', createdAt: '2026-10-08T01:00:00Z', jobId: '@a/b#tick' },
			{
				id: 'a2',
				kind: 'job',
				status: 'error',
				createdAt: '2026-10-08T02:00:00Z',
				jobId: '@a/b#tick',
				triage: 'ignored',
			},
			{ id: 'b1', kind: 'job', status: 'error', createdAt: '2026-10-08T03:00:00Z', jobId: '@a/b#other' },
			{ id: 'x1', kind: 'execute', status: 'error', createdAt: '2026-10-08T04:00:00Z' },
			{ id: 'a3', kind: 'job', status: 'success', createdAt: '2026-10-08T05:00:00Z', jobId: '@a/b#tick' },
		])
		assert.equal(store.autoResolveJob({ runId: 'a3', jobId: '@a/b#tick' }), 1)
		assert.deepEqual(triageFieldsFromRow(row('a1')), {
			errorTriage: 'resolved',
			triageNote: autoResolveNote,
			triagedAt: '2026-10-08T12:00:00.000Z',
			triagedBy: autoResolveBy,
			jobId: '@a/b#tick',
		})
		assert.equal(triageFieldsFromRow(row('a2')).errorTriage, 'ignored')
		assert.equal(triageFieldsFromRow(row('b1')).errorTriage, null)
		assert.equal(triageFieldsFromRow(row('x1')).errorTriage, null)
	})
})

describe('RunTriageStore.autoResolveJob ordering', () => {
	it('leaves errors of the same job that started after the successful run open', () => {
		const { store, row } = setup([
			{ id: 'early', kind: 'job', status: 'error', createdAt: '2026-10-08T01:00:00Z', jobId: '@a/b#tick' },
			{ id: 'ok', kind: 'job', status: 'success', createdAt: '2026-10-08T02:00:00Z', jobId: '@a/b#tick' },
			{ id: 'later', kind: 'job', status: 'error', createdAt: '2026-10-08T02:00:30Z', jobId: '@a/b#tick' },
		])
		assert.equal(store.autoResolveJob({ runId: 'ok', jobId: '@a/b#tick' }), 1)
		assert.equal(triageFieldsFromRow(row('early')).errorTriage, 'resolved')
		assert.equal(triageFieldsFromRow(row('later')).errorTriage, null)
	})
})

describe('errorTriageWhere', () => {
	it('selects the right rows for each filter', () => {
		const { sql } = setup([
			{ id: 'open', status: 'error', createdAt: '2026-10-08T01:00:00Z' },
			{ id: 'ign', status: 'error', createdAt: '2026-10-08T02:00:00Z', triage: 'ignored' },
			{ id: 'res', status: 'error', createdAt: '2026-10-08T03:00:00Z', triage: 'resolved' },
			{ id: 'ok', status: 'success', createdAt: '2026-10-08T04:00:00Z' },
		])
		const ids = (filter: 'open' | 'ignored' | 'resolved' | 'all') =>
			(
				sql.exec(`SELECT id FROM runs WHERE ${errorTriageWhere(filter)} ORDER BY id`).toArray() as Array<{ id: string }>
			).map((r) => r.id)
		assert.deepEqual(ids('open'), ['open'])
		assert.deepEqual(ids('ignored'), ['ign'])
		assert.deepEqual(ids('resolved'), ['res'])
		assert.deepEqual(ids('all'), ['ign', 'ok', 'open', 'res'])
	})
})
