import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tokenizeSnippet } from './tokenize.ts'

// Ported from kody packages/highlight-worker/src/tokenize.node.test.ts (vitest → node:test).
describe('tokenizeSnippet', () => {
	it('tokenizes known languages with dual-theme styles', () => {
		const ts = tokenizeSnippet({ code: 'const secret = "<script>"', lang: 'ts' })
		assert.equal(ts.plain, false)
		assert.equal(ts.lang, 'ts')
		assert.ok(ts.code.includes('<script>'))
		const styles = ts.lines.flat().flatMap((span) => Object.values(span.style ?? {}))
		assert.equal(
			styles.some((value) => value.includes('#') || value.startsWith('var')),
			true,
		)

		const json = tokenizeSnippet({ code: '{"ok": true}', lang: 'json' })
		assert.equal(json.plain, false)
		assert.equal(
			json.lines.flat().some((span) => span.content.includes('ok')),
			true,
		)

		const jsAlias = tokenizeSnippet({ code: 'const x = 1', lang: 'js' })
		assert.equal(jsAlias.lang, 'ts')
		assert.equal(jsAlias.plain, false)

		const shell = tokenizeSnippet({ code: 'npx @kodycodes/cli install', lang: 'sh' })
		assert.equal(shell.plain, false)
		assert.equal(shell.lang, 'shellscript')

		const golang = tokenizeSnippet({ code: 'package main', lang: 'golang' })
		assert.equal(golang.plain, false)
		assert.equal(golang.lang, 'go')

		const consoleLang = tokenizeSnippet({ code: 'echo hi', lang: 'console' })
		assert.equal(consoleLang.plain, false)
		assert.equal(consoleLang.lang, 'shellscript')
	})

	it('unknown languages and oversized snippets stay plaintext', () => {
		assert.deepEqual(tokenizeSnippet({ code: 'SELECT 1', lang: 'not-a-real-lang' }), {
			code: 'SELECT 1',
			lang: 'not-a-real-lang',
			plain: true,
			lines: [],
		})
		const huge = tokenizeSnippet({ code: 'x'.repeat(50_001), lang: 'ts' })
		assert.equal(huge.plain, true)
		assert.deepEqual(huge.lines, [])
	})
})
