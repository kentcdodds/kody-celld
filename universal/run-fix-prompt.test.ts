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
	it('names the run, job, package and error and asks for a confirmed fix then runUpdate', () => {
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
				'Use runGet to read its logs and packageGet with files to read the package source, explain the cause and propose a fix. ' +
				'After I confirm, apply it with packageSave and mark the run resolved with runUpdate.',
		)
	})

	it('describes ad hoc execute runs without a package', () => {
		const prompt = buildRunFixPrompt({
			id: 'run_x',
			kind: 'execute',
			packageName: null,
			jobId: null,
			error: null,
		})
		assert.ok(
			prompt.startsWith(
				'Kody run run_x failed (ad hoc execute): unknown error. ',
			),
		)
		assert.ok(
			prompt.includes(
				'Use runGet to read its logs, explain the cause and propose a fix.',
			),
		)
		assert.ok(!prompt.includes('packageGet'))
		assert.ok(!prompt.includes('packageSave'))
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
