import type { ErrorTriageFilter, RunTriageBulkInput, RunTriageUpdate } from './triage-args.ts'

// kody: packages/worker/src/run-records/run-log-do.ts (maybeAutoResolvePriorJobErrors).
export const autoResolveNote = 'auto-resolved: later success of the same job'
export const autoResolveBy = 'system:auto-resolve'

export type RunTriageFields = {
	errorTriage: 'ignored' | 'resolved' | null
	triageNote: string | null
	triagedAt: string | null
	triagedBy: string | null
	jobId: string | null
}

export type RunSummary = {
	since: string
	total: number
	errors: number
	ignored: number
	resolved: number
	running: number
	byKind: Array<{ kind: string; total: number; errors: number }>
}

export type RunTriageBulkResult = {
	matchedRunIds: Array<string>
	updatedCount: number
	hasMore: boolean
	dryRun: boolean
}

const triageColumns: Array<[string, string]> = [
	['error_triage', 'TEXT'],
	['triage_note', 'TEXT'],
	['triaged_at', 'TEXT'],
	['triaged_by', 'TEXT'],
	['job_id', 'TEXT'],
]

/** Adds the triage columns to `runs` on cells created before them; safe to call on every start. */
export function ensureRunTriageColumns(sql: SqlStorage) {
	const existing = (sql.exec(`SELECT name FROM pragma_table_info('runs')`).toArray() as Array<{ name: string }>).map(
		(row) => row.name,
	)
	for (const [name, type] of triageColumns) {
		if (!existing.includes(name)) sql.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`)
	}
	sql.exec(`CREATE INDEX IF NOT EXISTS runs_job_error ON runs(job_id, status) WHERE job_id IS NOT NULL`)
}

function text(value: unknown): string | null {
	return typeof value === 'string' ? value : null
}

export function triageFieldsFromRow(row: Record<string, unknown>): RunTriageFields {
	const triage = row.error_triage
	return {
		errorTriage: triage === 'ignored' || triage === 'resolved' ? triage : null,
		triageNote: text(row.triage_note),
		triagedAt: text(row.triaged_at),
		triagedBy: text(row.triaged_by),
		jobId: text(row.job_id),
	}
}

/** SQL boolean over `runs` for a list/bulk triage filter. `open` = unhandled error runs (kody). */
export function errorTriageWhere(filter: ErrorTriageFilter): string {
	switch (filter) {
		case 'open':
			return `(status = 'error' AND error_triage IS NULL)`
		case 'ignored':
			return `(error_triage = 'ignored')`
		case 'resolved':
			return `(error_triage = 'resolved')`
		case 'all':
			return '(1 = 1)'
		default: {
			const unhandled: never = filter
			throw new Error(`Unknown errorTriage filter: ${String(unhandled)}`)
		}
	}
}

export class RunTriageStore {
	private readonly sql: SqlStorage
	private readonly now: () => string

	constructor(sql: SqlStorage, now: () => string = () => new Date().toISOString()) {
		this.sql = sql
		this.now = now
	}

	summary(since: string | null): RunSummary {
		const oldest = (
			this.sql.exec(`SELECT MIN(created_at) AS oldest FROM runs`).toArray()[0] as { oldest: string | null }
		)?.oldest
		const from = since ?? oldest ?? this.now()
		const rows = this.sql
			.exec(
				`SELECT kind,
					COUNT(*) AS total,
					SUM(CASE WHEN status = 'error' AND error_triage IS NULL THEN 1 ELSE 0 END) AS errors,
					SUM(CASE WHEN error_triage = 'ignored' THEN 1 ELSE 0 END) AS ignored,
					SUM(CASE WHEN error_triage = 'resolved' THEN 1 ELSE 0 END) AS resolved,
					SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
				FROM runs WHERE created_at >= ? GROUP BY kind ORDER BY kind`,
				from,
			)
			.toArray() as Array<{
			kind: string
			total: number
			errors: number
			ignored: number
			resolved: number
			running: number
		}>
		const summary: RunSummary = { since: from, total: 0, errors: 0, ignored: 0, resolved: 0, running: 0, byKind: [] }
		for (const row of rows) {
			summary.total += Number(row.total)
			summary.errors += Number(row.errors)
			summary.ignored += Number(row.ignored)
			summary.resolved += Number(row.resolved)
			summary.running += Number(row.running)
			summary.byKind.push({ kind: row.kind, total: Number(row.total), errors: Number(row.errors) })
		}
		return summary
	}

	update(input: {
		runId: string
		triage: RunTriageUpdate
		note: string | undefined
		by: string
	}): { ok: true } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'not_error'; status: string } {
		const row = this.sql.exec(`SELECT status FROM runs WHERE id = ?`, input.runId).toArray()[0] as
			{ status: string } | undefined
		if (!row) return { ok: false, reason: 'not_found' }
		if (input.triage !== 'open' && row.status !== 'error') return { ok: false, reason: 'not_error', status: row.status }
		this.apply([input.runId], input.triage, input.note, input.by)
		return { ok: true }
	}

	bulk(input: RunTriageBulkInput & { by: string }): RunTriageBulkResult {
		const params: Array<string | number> = []
		const where: Array<string> = [`status = 'error'`]
		if (input.runIds) {
			where.push(`id IN (${input.runIds.map(() => '?').join(', ')})`)
			params.push(...input.runIds)
		}
		if (input.filter) {
			const f = input.filter
			where.push(errorTriageWhere(f.errorTriage))
			if (f.kind !== undefined) {
				where.push('kind = ?')
				params.push(f.kind)
			}
			if (f.packageName !== undefined) {
				where.push('package_name = ?')
				params.push(f.packageName)
			}
			if (f.jobId !== undefined) {
				where.push('job_id = ?')
				params.push(f.jobId)
			}
			if (f.errorName !== undefined) {
				where.push(`json_extract(error_json, '$.name') = ?`)
				params.push(f.errorName)
			}
			if (f.errorMessage !== undefined) {
				where.push(`json_extract(error_json, '$.message') = ?`)
				params.push(f.errorMessage)
			}
		}
		const ids = (
			this.sql
				.exec(
					`SELECT id FROM runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
					...params,
					input.limit + 1,
				)
				.toArray() as Array<{ id: string }>
		).map((row) => row.id)
		const matchedRunIds = ids.slice(0, input.limit)
		const hasMore = ids.length > input.limit
		if (input.dryRun || matchedRunIds.length === 0) {
			return { matchedRunIds, updatedCount: 0, hasMore, dryRun: input.dryRun }
		}
		const updatedCount = this.apply(matchedRunIds, input.triage, input.note, input.by)
		return { matchedRunIds, updatedCount, hasMore, dryRun: false }
	}

	autoResolveJob(input: { runId: string; jobId: string }): number {
		return this.sql.exec(
			`UPDATE runs SET error_triage = 'resolved', triage_note = ?, triaged_at = ?, triaged_by = ?
			WHERE status = 'error' AND error_triage IS NULL AND kind = 'job' AND job_id = ? AND id != ?`,
			autoResolveNote,
			this.now(),
			autoResolveBy,
			input.jobId,
			input.runId,
		).rowsWritten
	}

	private apply(ids: Array<string>, triage: RunTriageUpdate, note: string | undefined, by: string): number {
		const placeholders = ids.map(() => '?').join(', ')
		if (triage === 'open') {
			return this.sql.exec(
				`UPDATE runs SET error_triage = NULL, triage_note = NULL, triaged_at = NULL, triaged_by = NULL WHERE id IN (${placeholders})`,
				...ids,
			).rowsWritten
		}
		if (note === undefined) {
			return this.sql.exec(
				`UPDATE runs SET error_triage = ?, triaged_at = ?, triaged_by = ? WHERE id IN (${placeholders})`,
				triage,
				this.now(),
				by,
				...ids,
			).rowsWritten
		}
		return this.sql.exec(
			`UPDATE runs SET error_triage = ?, triage_note = ?, triaged_at = ?, triaged_by = ? WHERE id IN (${placeholders})`,
			triage,
			note === '' ? null : note,
			this.now(),
			by,
			...ids,
		).rowsWritten
	}
}
