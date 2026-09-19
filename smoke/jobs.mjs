// Jobs smoke: package-owned jobs created on save, manual run, "once" job
// picked up by the dispatcher, and (optionally) a real cron-triggered run.
import { admin, assert, log, waitFor } from './lib.mjs'

export async function smokeJobs({ mcp, user, waitForCron }) {
	const jobs = await mcp.call('jobList', { packageName: '@kody-smoke/counter' })
	const tick = jobs.jobs.find((job) => job.jobName === 'tick')
	const backfill = jobs.jobs.find((job) => job.jobName === 'backfill')
	assert(tick && backfill, 'counter package jobs should exist', jobs)
	assert(tick.schedule.type === 'interval' && tick.nextRunAt, 'interval job should have a next run', tick)
	assert(
		backfill.schedule.type === 'once' && backfill.nextRunAt && Date.parse(backfill.nextRunAt) <= Date.now(),
		'past "once" job should be due immediately',
		backfill,
	)
	log('jobs registered from manifest', { tick: tick.nextRunAt, backfill: backfill.nextRunAt })

	const manual = await mcp.callDirect('jobRunNow', { id: tick.id })
	assert(manual.ok && manual.result.trigger === 'manual' && manual.result.ticks >= 1, 'manual job run failed', manual)
	log('jobRunNow', { ticks: manual.result.ticks, trigger: manual.result.trigger })

	// Simulate the cron trigger firing now: the past-due "once" job must run exactly once.
	const dispatch = await admin.dispatchJobs()
	assert(dispatch.status === 200, 'admin dispatch failed', dispatch.json)
	const ranBackfill = dispatch.json.ran.find((entry) => entry.jobId === backfill.id)
	assert(ranBackfill?.ok, 'dispatcher should have run the past-due once job', dispatch.json)
	const again = await admin.dispatchJobs()
	assert(!again.json.ran.some((entry) => entry.jobId === backfill.id), '"once" job must not run twice', again.json)
	const backfillAfter = await mcp.call('jobGet', { id: backfill.id, runs: 5 })
	assert(
		backfillAfter.job.nextRunAt === null && backfillAfter.job.lastStatus === 'success',
		'once job should be exhausted',
		backfillAfter.job,
	)
	assert(
		backfillAfter.runs[0].trigger === 'cron' && backfillAfter.runs[0].result.trigger === 'cron',
		'job run history should carry the trigger',
		backfillAfter.runs[0],
	)
	log('dispatcher ran past-due once job exactly once', {
		lastStatus: backfillAfter.job.lastStatus,
		nextRunAt: backfillAfter.job.nextRunAt,
	})

	const disabled = await mcp.call('jobUpdate', { id: backfill.id, enabled: false })
	assert(disabled.enabled === false, 'jobUpdate should disable', disabled)
	log('jobUpdate disable')

	const runs = await mcp.call('jobRuns', { jobId: tick.id, limit: 5 })
	assert(
		runs.runs.length >= 1 && runs.runs[0].logs.some((entry) => entry.args?.[0] === 'tick'),
		'job runs should capture console logs',
		runs.runs[0],
	)

	if (!waitForCron) {
		log('skipping real cron wait (pass --wait-cron to include it)')
		return
	}

	// Real celld cron: the "* * * * *" trigger runs the dispatcher every minute.
	const before = (await mcp.call('jobRuns', { jobId: tick.id, limit: 50 })).runs.filter(
		(run) => run.trigger === 'cron',
	).length
	log(`waiting for the celld cron trigger to run "${tick.id}" (next at ${tick.nextRunAt})`)
	const cronRun = await waitFor(
		'a cron-triggered tick run',
		async () => {
			const current = (await mcp.call('jobRuns', { jobId: tick.id, limit: 50 })).runs.filter(
				(run) => run.trigger === 'cron',
			)
			// The dispatcher marks the row `running` first; wait until it has finished.
			return current.length > before && current[0].finishedAt ? current[0] : null
		},
		{ timeoutMs: 150_000, intervalMs: 5_000 },
	)
	assert(cronRun.status === 'success' && cronRun.result.trigger === 'cron', 'cron run should succeed', cronRun)
	const status = await mcp.callDirect('packageRun', { name: '@kody-smoke/counter', export: '.' })
	assert(
		status.result.events.some((row) => row.kind === 'tick:cron'),
		'cron tick should be recorded in package SQL',
		status.result.events,
	)
	log('celld cron trigger ran the job', { jobRunId: cronRun.id, ticks: cronRun.result.ticks })
	void user
}
