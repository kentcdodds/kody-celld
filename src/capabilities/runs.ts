import { KodyError } from '../lib/errors.ts'
import {
	errorTriageFilters,
	parseErrorTriageFilter,
	parseRunTriage,
	parseRunTriageBulk,
	parseSince,
	parseTriageNote,
	runTriageBulkMaxLimit,
	runTriageMaxNoteLength,
	runTriageUpdates,
} from '../runs/triage-args.ts'
import { defineCapability, defineDomain } from './define.ts'

export const runsDomain = defineDomain({
	name: 'runs',
	description:
		'History of execute/package/job runs: status, console logs, warnings, and the fetch-gateway decisions (forwarded / injected / denied) made on their behalf. Error runs can be soft-triaged as ignored or resolved (kody parity).',
})

const errorTriageFilterSchema = {
	type: 'string',
	enum: [...errorTriageFilters],
	description:
		'open = error runs not ignored/resolved; ignored / resolved = triaged error runs; all (default) = every run.',
}

const runTriageUpdateSchema = {
	type: 'string',
	enum: [...runTriageUpdates],
	description: 'ignored (noise), resolved (fixed), or open (clear triage).',
}

export const runList = defineCapability<{ limit?: number; errorTriage?: string }>({
	domain: 'runs',
	name: 'runList',
	description:
		'List recent runs (newest first) with their triage fields. Pass errorTriage "open" to see only unhandled failures; the default "all" returns every run.',
	tags: ['runs', 'read'],
	keywords: ['recent runs', 'execution history', 'what ran', 'open errors', 'failures'],
	inputSchema: {
		type: 'object',
		properties: { limit: { type: 'integer' }, errorTriage: errorTriageFilterSchema },
	},
	readOnly: true,
	async handler(args, ctx) {
		return {
			runs: await ctx.userCell.runList({
				limit: args.limit,
				errorTriage: parseErrorTriageFilter(args.errorTriage, 'all'),
			}),
		}
	},
})

export const runGet = defineCapability<{ id: string }>({
	domain: 'runs',
	name: 'runGet',
	description:
		'Get one run with its result, logs, warnings, gateway events and triage fields (secret values are never included).',
	tags: ['runs', 'read'],
	keywords: ['run details', 'run logs', 'gateway events', 'denied host', 'why blocked'],
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	readOnly: true,
	async handler(args, ctx) {
		const run = await ctx.userCell.runGet({ id: args.id })
		if (!run) throw new KodyError('run_not_found', `Run "${args.id}" was not found.`, { status: 404 })
		const { resultJson, logsJson, ...rest } = run
		return {
			...rest,
			result: resultJson === null ? undefined : (JSON.parse(resultJson) as unknown),
			logs: JSON.parse(logsJson) as Array<unknown>,
		}
	},
})

// kody: packages/worker/src/mcp/capabilities/runs/run-summary.ts
export const runSummary = defineCapability<{ since?: string }>({
	domain: 'runs',
	name: 'runSummary',
	description:
		'Summarize recent run totals, open error count (excluding ignored/resolved), ignored/resolved counts, still-running count, and per-kind breakdown to answer "is anything broken?" before drilling into runList or runGet.',
	tags: ['runs', 'read'],
	keywords: ['summary', 'health', 'broken', 'errors', 'failures', 'status', 'overview', 'triage'],
	inputSchema: {
		type: 'object',
		properties: {
			since: {
				type: 'string',
				description: 'Optional ISO 8601 lower bound (inclusive). Defaults to the oldest retained run.',
			},
		},
	},
	readOnly: true,
	async handler(args, ctx) {
		return ctx.userCell.runSummary({ since: parseSince(args.since) })
	},
})

// kody: packages/worker/src/mcp/capabilities/runs/run-update.ts
export const runUpdate = defineCapability<{ runId: string; triage: string; note?: string }>({
	domain: 'runs',
	name: 'runUpdate',
	description:
		'Mark a retained error run as ignored or resolved (or clear triage back to open) so runSummary and the Activity page stop counting already-handled noise, without deleting history. Only error runs accept ignored/resolved; the original error, logs and status stay intact.',
	tags: ['runs', 'write'],
	keywords: ['triage', 'ignore error', 'resolve error', 'reopen', 'dismiss failure', 'noise'],
	inputSchema: {
		type: 'object',
		properties: {
			runId: { type: 'string', description: 'Run id from runList, runGet or jobRunNow.' },
			triage: runTriageUpdateSchema,
			note: {
				type: 'string',
				description: `Optional note (at most ${runTriageMaxNoteLength} characters). Omit to keep the current note; pass "" to clear it. Cleared when triage is open.`,
			},
		},
		required: ['runId', 'triage'],
	},
	async handler(args, ctx) {
		const run = await ctx.userCell.runTriageUpdate({
			runId: args.runId,
			triage: parseRunTriage(args.triage),
			note: parseTriageNote(args.note),
		})
		const { resultJson, logsJson, gateway, ...rest } = run
		void resultJson
		void logsJson
		void gateway
		return { run: rest }
	},
})

// kody: packages/worker/src/mcp/capabilities/runs/run-update-bulk.ts
export const runUpdateBulk = defineCapability<Record<string, unknown>>({
	domain: 'runs',
	name: 'runUpdateBulk',
	description: `Soft-triage up to ${runTriageBulkMaxLimit} retained error runs by explicit runIds or an exact-match filter (kind, packageName, jobId, errorName, errorMessage). Use dryRun first, then repeat filtered updates while hasMore is true. Status, error details and logs never change.`,
	tags: ['runs', 'write'],
	keywords: ['bulk triage', 'resolve duplicate errors', 'ignore recurring failures', 'job errors', 'activity cleanup'],
	inputSchema: {
		type: 'object',
		properties: {
			runIds: { type: 'array', items: { type: 'string' } },
			filter: {
				type: 'object',
				properties: {
					kind: { type: 'string' },
					packageName: { type: 'string' },
					jobId: { type: 'string' },
					errorName: { type: 'string' },
					errorMessage: { type: 'string' },
					errorTriage: errorTriageFilterSchema,
				},
			},
			triage: runTriageUpdateSchema,
			note: { type: 'string' },
			limit: { type: 'integer' },
			dryRun: { type: 'boolean' },
		},
		required: ['triage'],
	},
	async handler(args, ctx) {
		return ctx.userCell.runTriageBulk(parseRunTriageBulk(args))
	},
})

export const runCapabilities = [runList, runGet, runSummary, runUpdate, runUpdateBulk]
