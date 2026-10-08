// Run triage smoke (kody parity): runSummary, runUpdate, runUpdateBulk,
// runList errorTriage filter, and auto-resolve of a job's earlier errors.
import { randomBytes } from 'node:crypto'
import { assert, log } from './lib.mjs'

export async function smokeRuns({ mcp }) {
	const before = await mcp.call('runSummary')
	const failed = await mcp.execute(`export default async function main() { throw new Error('triage smoke failure') }`)
	assert(!failed.ok && failed.runId, 'a failing execute should record an error run', failed)
	const after = await mcp.call('runSummary')
	assert(
		after.errors === before.errors + 1 && after.byKind.some((k) => k.kind === 'execute' && k.errors >= 1),
		'runSummary counts the new open error by kind',
		{ before, after },
	)

	const ignored = await mcp.callDirect('runUpdate', {
		runId: failed.runId,
		triage: 'ignored',
		note: 'smoke: expected failure',
	})
	assert(
		ignored.run.errorTriage === 'ignored' &&
			ignored.run.triageNote === 'smoke: expected failure' &&
			typeof ignored.run.triagedBy === 'string' &&
			ignored.run.status === 'error',
		'runUpdate marks the run ignored without changing its status',
		ignored,
	)
	const afterIgnore = await mcp.call('runSummary')
	assert(
		afterIgnore.errors === before.errors && afterIgnore.ignored === before.ignored + 1,
		'an ignored error no longer counts as open',
		afterIgnore,
	)
	const listedIgnored = await mcp.call('runList', { errorTriage: 'ignored', limit: 200 })
	const listedOpen = await mcp.call('runList', { errorTriage: 'open', limit: 200 })
	const listedAll = await mcp.call('runList', { limit: 200 })
	assert(
		listedIgnored.runs.some((r) => r.id === failed.runId) &&
			!listedOpen.runs.some((r) => r.id === failed.runId) &&
			listedAll.runs.some((r) => r.id === failed.runId && r.errorTriage === 'ignored'),
		'runList filters by errorTriage and still returns everything by default',
	)
	const reopened = await mcp.callDirect('runUpdate', { runId: failed.runId, triage: 'open' })
	assert(
		reopened.run.errorTriage === null && reopened.run.triageNote === null,
		'reopen clears triage and note',
		reopened,
	)

	const okRun = await mcp.execute(`export default async function main() { return 1 }`)
	const refused = await mcp.callDirectRaw('runUpdate', { runId: okRun.runId, triage: 'resolved' })
	assert(
		refused.isError && /only error runs can be ignored or resolved/.test(JSON.stringify(refused.payload)),
		'runUpdate refuses to resolve a successful run',
		refused,
	)
	const badReopen = await mcp.callDirectRaw('runUpdateBulk', { filter: { kind: 'execute' }, triage: 'open' })
	assert(
		badReopen.isError && /reopen requires errorTriage/.test(JSON.stringify(badReopen.payload)),
		'filtered reopen needs errorTriage',
		badReopen,
	)

	const failedRun = await mcp.call('runGet', { id: failed.runId })
	const dry = await mcp.callDirect('runUpdateBulk', {
		filter: { errorMessage: failedRun.error.message },
		triage: 'resolved',
		dryRun: true,
	})
	assert(
		dry.dryRun === true && dry.updatedCount === 0 && dry.matchedRunIds.includes(failed.runId),
		'runUpdateBulk dry run previews matches by exact error message',
		dry,
	)
	const bulk = await mcp.callDirect('runUpdateBulk', {
		runIds: [failed.runId, 'run_does_not_exist'],
		triage: 'resolved',
	})
	assert(
		bulk.updatedCount === 1 && bulk.matchedRunIds.length === 1 && bulk.hasMore === false,
		'runUpdateBulk resolves known ids and skips unknown ones',
		bulk,
	)
	log('triage', { runId: failed.runId, summary: await mcp.call('runSummary') })

	// A job that fails once and then succeeds resolves its earlier error (kody auto-resolve).
	const pkgName = `@kody-smoke/triage-${randomBytes(3).toString('hex')}`
	await mcp.call('packageSave', {
		files: {
			'package.json': JSON.stringify({
				name: pkgName,
				version: '1.0.0',
				description: 'run triage smoke',
				exports: './flaky.js',
				kody: {
					jobs: {
						flaky: {
							entry: './flaky.js',
							schedule: { type: 'interval', every: '24h' },
							enabled: false,
							description: 'fails on its first run only',
						},
					},
				},
			}),
			'README.md': `# ${pkgName}`,
			'AGENTS.md': 'Fails on the first run, succeeds afterwards.',
			'flaky.js': `import { packageStorage } from 'kody:runtime'
export default async function flaky() {
  const store = packageStorage()
  const runs = (await store.get('runs')) ?? 0
  await store.set('runs', runs + 1)
  if (runs === 0) throw new Error('first run fails')
  return { runs: runs + 1 }
}`,
		},
		source: 'smoke/runs.mjs',
	})
	const jobId = `${pkgName}#flaky`
	const first = await mcp.callDirect('jobRunNow', { id: jobId })
	assert(first.ok === false && first.runId, 'the flaky job fails on its first run', first)
	const firstOpen = await mcp.call('runGet', { id: first.runId })
	assert(firstOpen.errorTriage === null && firstOpen.jobId === jobId, 'job runs record their job id', firstOpen)
	const second = await mcp.callDirect('jobRunNow', { id: jobId })
	assert(second.ok === true, 'the flaky job succeeds on its second run', second)
	const firstAfter = await mcp.call('runGet', { id: first.runId })
	assert(
		firstAfter.status === 'error' &&
			firstAfter.errorTriage === 'resolved' &&
			firstAfter.triagedBy === 'system:auto-resolve' &&
			firstAfter.triageNote === 'auto-resolved: later success of the same job',
		'a later success of the same job auto-resolves its earlier error',
		firstAfter,
	)
	log('auto-resolve', { jobId, resolvedRunId: first.runId })
}
