import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	activityErrorReviewPrompt,
	buildRunFixPrompt,
} from './run-fix-prompt.ts'

describe('activityErrorReviewPrompt', () => {
	it("is kody's Activity prompt verbatim", () => {
		assert.equal(
			activityErrorReviewPrompt,
			'Look at my open Kody activity errors. Start with runSummary, then runList for open errors, and runGet on the ones that matter. Explain each failure and recommend whether to ignore it, mark it resolved, or fix something.',
		)
	})
})

describe('buildRunFixPrompt', () => {
	it('gives package runs the exact calls to read the run and the source, then fix and resolve after confirmation', () => {
		const prompt = buildRunFixPrompt({
			id: 'run_abc',
			kind: 'job',
			packageName: '@alan/gh-actions-alerts',
			jobId: '@alan/gh-actions-alerts#poll',
			error: 'Error: instantiate: <none>',
		})
		assert.equal(
			prompt,
			'Kody run run_abc failed (job @alan/gh-actions-alerts#poll, package @alan/gh-actions-alerts): Error: instantiate: <none>. ' +
				'Read the run with runGet({ id: "run_abc" }) and the package source with packageGet({ name: "@alan/gh-actions-alerts", includeFiles: true }), then explain the cause and propose a fix. ' +
				'After I confirm, apply it with packageSave and mark the run resolved with runUpdate({ runId: "run_abc", triage: "resolved", note: "<what was fixed>" }).',
		)
	})

	it('asks for an ignore-or-resolve recommendation for ad hoc runs, whose code is not stored', () => {
		const prompt = buildRunFixPrompt({
			id: 'run_x',
			kind: 'execute',
			packageName: null,
			jobId: null,
			error: null,
		})
		assert.equal(
			prompt,
			'Kody run run_x failed (ad hoc execute): unknown error. ' +
				'Read the run with runGet({ id: "run_x" }). Ad hoc execute code is not stored, so explain the likely cause from the error and logs and recommend whether to ignore or resolve it. ' +
				'After I confirm, update it with runUpdate({ runId: "run_x", triage: "ignored", note: "<why>" }) or triage "resolved".',
		)
	})

	it('does not double the full stop when the error already ends with one', () => {
		const prompt = buildRunFixPrompt({
			id: 'run_z',
			kind: 'execute',
			packageName: null,
			jobId: null,
			error:
				'Error: invalid_args: packageStorageInspect requires "packageName".',
		})
		assert.ok(prompt.includes('requires "packageName". Read the run'))
		assert.ok(!prompt.includes('..'))
	})

	it('keeps long errors to one readable line', () => {
		const prompt = buildRunFixPrompt({
			id: 'run_y',
			kind: 'webhook',
			packageName: '@a/b',
			jobId: null,
			error: `Error: ${'x'.repeat(600)}\n    at stack line`,
		})
		assert.ok(!prompt.includes('\n'))
		assert.ok(prompt.includes('(webhook, package @a/b): Error: '))
		assert.ok(prompt.includes('Error: ' + 'x'.repeat(293) + '…'))
		assert.ok(!prompt.includes('x'.repeat(294)))
	})
})
