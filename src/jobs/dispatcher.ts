import type { JobRecord } from '../cells/user-cell.ts'
import type { Env } from '../env.ts'
import { executeRun, getUserCell } from '../execute/engine.ts'

export type JobUser = { id: string; email: string }

/**
 * Runs one job with package provenance and records a job_run row. The
 * schedule itself was already advanced by `jobsClaimDue` (or is untouched for
 * manual triggers), so a crashed run never re-fires the same slot.
 */
export async function runJobNow(
	env: Env,
	exports: ExecutionContext['exports'],
	user: JobUser,
	job: JobRecord,
	trigger: 'cron' | 'manual',
	scheduledFor: string = new Date().toISOString(),
) {
	const userCell = getUserCell(env, user.id)
	const jobRunId = await userCell.jobRunStart({ jobId: job.id, trigger })
	const result = await executeRun(env, exports, {
		kind: 'job',
		user,
		entry: { kind: 'package', packageName: job.packageName, entryPath: job.entry },
		params: { jobName: job.jobName, packageName: job.packageName, scheduledFor, trigger, jobId: job.id },
		trigger,
	})
	await userCell.jobRunFinish({
		id: jobRunId,
		jobId: job.id,
		status: result.ok ? 'success' : 'error',
		resultJson: result.result === undefined ? null : JSON.stringify(result.result),
		error: result.error ? `${result.error.name}: ${result.error.message}` : null,
		logsJson: JSON.stringify(result.logs),
	})
	return { jobRunId, runId: result.runId, ok: result.ok, result: result.result, error: result.error, logs: result.logs }
}

/** Cron entry point: claims and runs every due job for every user. */
export async function dispatchDueJobs(env: Env, exports: ExecutionContext['exports'], now = new Date()) {
	const registry = env.REGISTRY.getByName('registry')
	const users = await registry.listUsers()
	const nowIso = now.toISOString()
	const summary: Array<{ userId: string; jobId: string; ok: boolean; runId: string }> = []
	await Promise.all(
		users.map(async (user) => {
			const due = await getUserCell(env, user.id).jobsClaimDue(nowIso)
			for (const job of due) {
				const outcome = await runJobNow(env, exports, user, job, 'cron', job.nextRunAt ?? nowIso)
				summary.push({ userId: user.id, jobId: job.id, ok: outcome.ok, runId: outcome.runId })
			}
		}),
	)
	return { at: nowIso, users: users.length, ran: summary }
}
