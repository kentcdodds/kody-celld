import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { highlightSnippetKey } from './highlighted-code.ts'

// Ported from kody packages/worker/universal/highlighted-code.node.test.ts.
describe('highlightSnippetKey', () => {
	it('highlight snippet keys keep lang and code fields distinct', () => {
		assert.notEqual(
			highlightSnippetKey({ lang: 'ts', code: 'const x: number = 1' }),
			highlightSnippetKey({ lang: 'ts:const x', code: ' number = 1' }),
		)
		assert.equal(
			highlightSnippetKey({ lang: 'ts', code: 'const x = 1' }),
			highlightSnippetKey({ lang: 'TS', code: 'const x = 1' }),
		)
	})
})
