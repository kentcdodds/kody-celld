// kody: packages/worker/client/routes/account-activity-shared.ts (activityErrorReviewPrompt).
export const activityErrorReviewPrompt = [
	'Look at my open Kody activity errors.',
	'Start with runSummary, then runList for open errors, and runGet on the ones that matter.',
	'Explain each failure and recommend whether to ignore it, mark it resolved, or fix something.',
].join(' ')

const maxErrorLength = 300

function oneLine(error: string | null): string {
	const first = (error ?? '').split('\n')[0]?.trim() ?? ''
	if (!first) return 'unknown error'
	return first.length > maxErrorLength
		? `${first.slice(0, maxErrorLength)}…`
		: first
}

/**
 * kody-celld: a per-run "fix with AI" prompt for the Activity detail view, to
 * paste into an MCP client. It only asks; the agent applies a fix after the
 * person confirms.
 */
export function buildRunFixPrompt(run: {
	id: string
	kind: string
	packageName: string | null
	jobId: string | null
	error: string | null
}): string {
	const where = run.packageName
		? `${run.jobId ? `job ${run.jobId}` : run.kind}, package ${run.packageName}`
		: `ad hoc ${run.kind}`
	const read = run.packageName
		? 'Use runGet to read its logs and packageGet with files to read the package source, explain the cause and propose a fix.'
		: 'Use runGet to read its logs, explain the cause and propose a fix.'
	const apply = run.packageName
		? 'After I confirm, apply it with packageSave and mark the run resolved with runUpdate.'
		: 'After I confirm, mark the run resolved with runUpdate.'
	return `Kody run ${run.id} failed (${where}): ${oneLine(run.error)}. ${read} ${apply}`
}
