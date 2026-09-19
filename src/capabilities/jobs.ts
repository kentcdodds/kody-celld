import type { JobRunRecord } from '../cells/user-cell.ts'
import { runJobNow } from '../jobs/dispatcher.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { defineCapability, defineDomain } from './define.ts'

export const jobsDomain = defineDomain({
	name: 'jobs',
	description:
		'Package-owned scheduled work. Jobs are declared in package.json#kody.jobs ({ entry, schedule: cron | interval | once, timezone?, enabled? }) and created when the package is saved. A celld cron trigger runs the dispatcher every minute; each due job runs its entry module with package provenance.',
	guide: `Schedules: { "type": "cron", "expression": "*/5 * * * *" }, { "type": "interval", "every": "10m" } (minimum 1 minute), or { "type": "once", "runAt": "2026-10-01T09:00:00Z" }. Job entries are modules with a default export that receives { jobName, packageName, scheduledFor, trigger }.`,
})

export const jobList = defineCapability<{ packageName?: string }>({
	domain: 'jobs',
	name: 'jobList',
	description: 'List jobs with schedule, next/last run, and last status.',
	tags: ['jobs', 'read'],
	keywords: ['scheduled jobs', 'cron', 'recurring', 'list jobs', 'next run'],
	inputSchema: { type: 'object', properties: { packageName: { type: 'string' } } },
	readOnly: true,
	async handler(args, ctx) {
		return { jobs: await ctx.userCell.jobList({ packageName: args.packageName }) }
	},
})

export const jobGet = defineCapability<{ id: string; runs?: number }>({
	domain: 'jobs',
	name: 'jobGet',
	description: 'Get one job (id is "<package>#<jobName>") with its recent run history.',
	tags: ['jobs', 'read'],
	keywords: ['job history', 'job runs', 'job status', 'why did job fail'],
	inputSchema: {
		type: 'object',
		properties: {
			id: { type: 'string' },
			runs: { type: 'integer', description: 'How many recent runs (default 10).' },
		},
		required: ['id'],
	},
	readOnly: true,
	async handler(args, ctx) {
		const job = await ctx.userCell.jobGet(args.id)
		if (!job) throw new KodyError('job_not_found', `Job "${args.id}" was not found.`, { status: 404 })
		return { job, runs: (await ctx.userCell.jobRunList({ jobId: args.id, limit: args.runs ?? 10 })).map(jobRunView) }
	},
})

export const jobUpdate = defineCapability<{ id: string; enabled: boolean }>({
	domain: 'jobs',
	name: 'jobUpdate',
	description:
		'Enable or disable a job. Schedules themselves live in the package manifest; re-save the package to change them.',
	tags: ['jobs', 'write'],
	keywords: ['pause job', 'disable job', 'enable job', 'resume'],
	inputSchema: {
		type: 'object',
		properties: { id: { type: 'string' }, enabled: { type: 'boolean' } },
		required: ['id', 'enabled'],
	},
	async handler(args, ctx) {
		const job = await ctx.userCell.jobUpdate({ id: args.id, enabled: args.enabled })
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: args.enabled ? 'job.enable' : 'job.disable',
			target: args.id,
			details: null,
		})
		return job
	},
})

export const jobRunNow = defineCapability<{ id: string }>({
	domain: 'jobs',
	name: 'jobRunNow',
	description: 'Run a job immediately (trigger "manual") without changing its schedule. Returns the job run record.',
	tags: ['jobs', 'execute'],
	keywords: ['run job now', 'trigger job', 'force job'],
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	async handler(args, ctx) {
		if (ctx.fromRuntime) {
			throw new KodyError('forbidden', 'jobRunNow is not available from inside a run.', { status: 403 })
		}
		const job = await ctx.userCell.jobGet(args.id)
		if (!job) throw new KodyError('job_not_found', `Job "${args.id}" was not found.`, { status: 404 })
		return runJobNow(ctx.env, ctx.exports, ctx.user, job, 'manual')
	},
})

export const jobRuns = defineCapability<{ jobId?: string; limit?: number }>({
	domain: 'jobs',
	name: 'jobRuns',
	description: 'List recent job runs across all jobs or for one job.',
	tags: ['jobs', 'read'],
	keywords: ['job run log', 'recent job executions'],
	inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, limit: { type: 'integer' } } },
	readOnly: true,
	async handler(args, ctx) {
		return { runs: (await ctx.userCell.jobRunList({ jobId: args.jobId, limit: args.limit })).map(jobRunView) }
	},
})

export function jobRunView({ resultJson, logsJson, ...run }: JobRunRecord) {
	return {
		...run,
		result: resultJson === null ? undefined : (JSON.parse(resultJson) as unknown),
		logs: JSON.parse(logsJson) as Array<unknown>,
	}
}

export const jobCapabilities = [jobList, jobGet, jobUpdate, jobRunNow, jobRuns]
