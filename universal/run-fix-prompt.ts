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

function sentence(text: string) {
	return /[.!?…]$/.test(text) ? text : `${text}.`
}

/**
 * kody-celld: a per-run "fix with AI" prompt for the Activity detail view, to
 * paste into an MCP client. It spells out the exact calls (an agent guessing
 * argument names creates new error runs while investigating) and only asks;
 * the agent changes things after the person confirms. Ad hoc execute code is
 * not stored, so those runs get a diagnosis and an ignore/resolve call
 * instead of a fix.
 */
export function buildRunFixPrompt(run: {
	id: string
	kind: string
	packageName: string | null
	jobId: string | null
	error: string | null
}): string {
	const id = JSON.stringify(run.id)
	const head = sentence(
		`Kody run ${run.id} failed (${
			run.packageName
				? `${run.jobId ? `job ${run.jobId}` : run.kind}, package ${run.packageName}`
				: `ad hoc ${run.kind}`
		}): ${oneLine(run.error)}`,
	)
	if (run.packageName) {
		return [
			head,
			`Read the run with runGet({ id: ${id} }) and the package source with packageGet({ name: ${JSON.stringify(run.packageName)}, includeFiles: true }), then explain the cause and propose a fix.`,
			`After I confirm, apply it with packageSave and mark the run resolved with runUpdate({ runId: ${id}, triage: "resolved", note: "<what was fixed>" }).`,
		].join(' ')
	}
	return [
		head,
		`Read the run with runGet({ id: ${id} }). Ad hoc execute code is not stored, so explain the likely cause from the error and logs and recommend whether to ignore or resolve it.`,
		`After I confirm, update it with runUpdate({ runId: ${id}, triage: "ignored", note: "<why>" }) or triage "resolved".`,
	].join(' ')
}
