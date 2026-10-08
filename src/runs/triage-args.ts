import { KodyError } from '../lib/errors.ts'

// kody: packages/worker/src/run-records/types.ts (runErrorTriageMaxNoteLength)
// and src/mcp/capabilities/runs/run-update-bulk.ts (max 100 per call).
export const runTriageMaxNoteLength = 2000
export const runTriageBulkMaxLimit = 100

/** Single source for run `kind` (kody's surface). */
export const runKinds = ['execute', 'package', 'job', 'webhook', 'subscription', 'secret-provider'] as const
export type RunKind = (typeof runKinds)[number]

/** Soft triage values stored on error runs (`null` = open). */
export const runErrorTriageValues = ['ignored', 'resolved'] as const
export type RunErrorTriage = (typeof runErrorTriageValues)[number]

/** Values accepted by runUpdate / runUpdateBulk. */
export const runTriageUpdates = ['ignored', 'resolved', 'open'] as const
export type RunTriageUpdate = (typeof runTriageUpdates)[number]

/** List / bulk / summary filters over soft triage. */
export const errorTriageFilters = ['open', 'ignored', 'resolved', 'all'] as const
export type ErrorTriageFilter = (typeof errorTriageFilters)[number]

export type RunTriageBulkFilter = {
	kind?: RunKind
	packageName?: string
	jobId?: string
	errorName?: string
	errorMessage?: string
	errorTriage: ErrorTriageFilter
}

export type RunTriageBulkInput = {
	runIds: Array<string> | null
	filter: RunTriageBulkFilter | null
	triage: RunTriageUpdate
	note: string | undefined
	limit: number
	dryRun: boolean
}

function invalid(message: string): never {
	throw new KodyError('invalid_args', message, { status: 400 })
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlyArray<T>, label: string): T {
	if (typeof value === 'string' && (allowed as ReadonlyArray<string>).includes(value)) return value as T
	return invalid(`${label} must be one of ${allowed.join(', ')}.`)
}

function optionalText(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string' || value.length === 0) return invalid(`${label} must be a non-empty string.`)
	return value
}

export function parseRunTriage(value: unknown): RunTriageUpdate {
	return oneOf(value, runTriageUpdates, 'triage')
}

export function parseTriageNote(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string') return invalid('note must be a string.')
	if (value.length > runTriageMaxNoteLength)
		return invalid(`note must be at most ${runTriageMaxNoteLength} characters.`)
	// kody: whitespace-only notes clear triage_note (trim then empty → clear).
	return value.trim()
}

export function parseErrorTriageFilter(value: unknown, fallback: ErrorTriageFilter): ErrorTriageFilter {
	if (value === undefined || value === null) return fallback
	return oneOf(value, errorTriageFilters, 'errorTriage')
}

export function parseSince(value: unknown): string | null {
	if (value === undefined || value === null) return null
	const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
	if (Number.isNaN(time)) return invalid('since must be an ISO 8601 time.')
	return new Date(time).toISOString()
}

export function parseRunTriageBulk(args: Record<string, unknown>): RunTriageBulkInput {
	const triage = parseRunTriage(args.triage)
	const note = parseTriageNote(args.note)
	const hasIds = args.runIds !== undefined && args.runIds !== null
	const hasFilter = args.filter !== undefined && args.filter !== null
	if (hasIds === hasFilter) invalid('Provide exactly one of runIds or filter.')

	let limit = runTriageBulkMaxLimit
	if (args.limit !== undefined && args.limit !== null) {
		if (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > runTriageBulkMaxLimit) {
			invalid(`limit must be 1 to ${runTriageBulkMaxLimit}.`)
		}
		limit = args.limit as number
	}
	const dryRun = args.dryRun === true

	if (hasIds) {
		const ids = args.runIds
		if (
			!Array.isArray(ids) ||
			ids.length < 1 ||
			ids.length > runTriageBulkMaxLimit ||
			!ids.every((id) => typeof id === 'string' && id.length > 0)
		) {
			invalid(`runIds must hold 1 to ${runTriageBulkMaxLimit} run ids.`)
		}
		return { runIds: ids as Array<string>, filter: null, triage, note, limit, dryRun }
	}

	const raw = args.filter
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('filter must be an object.')
	const source = raw as Record<string, unknown>
	const filter: RunTriageBulkFilter = { errorTriage: 'open' }
	if (source.kind !== undefined && source.kind !== null) filter.kind = oneOf(source.kind, runKinds, 'filter.kind')
	const packageName = optionalText(source.packageName, 'filter.packageName')
	if (packageName !== undefined) filter.packageName = packageName
	const jobId = optionalText(source.jobId, 'filter.jobId')
	if (jobId !== undefined) filter.jobId = jobId
	const errorName = optionalText(source.errorName, 'filter.errorName')
	if (errorName !== undefined) filter.errorName = errorName
	const errorMessage = optionalText(source.errorMessage, 'filter.errorMessage')
	if (errorMessage !== undefined) filter.errorMessage = errorMessage
	if (
		filter.kind === undefined &&
		filter.packageName === undefined &&
		filter.jobId === undefined &&
		filter.errorName === undefined &&
		filter.errorMessage === undefined
	) {
		invalid('filter must include kind, packageName, jobId, errorName, or errorMessage.')
	}
	if (triage === 'open') {
		if (source.errorTriage !== 'ignored' && source.errorTriage !== 'resolved') {
			invalid('A filtered reopen requires errorTriage "ignored" or "resolved".')
		}
		filter.errorTriage = source.errorTriage
	} else {
		filter.errorTriage = parseErrorTriageFilter(source.errorTriage, 'open')
	}
	return { runIds: null, filter, triage, note, limit, dryRun }
}
