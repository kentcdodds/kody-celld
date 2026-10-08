import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createInProcessHighlightFetcher } from './binding.ts'

const highlightUrl = 'https://highlight.internal/highlight'

describe('in-process HIGHLIGHT binding', () => {
	it("answers kody's /highlight contract with Shiki tokens", async () => {
		const response = await createInProcessHighlightFetcher().fetch(highlightUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ snippets: [{ code: 'const x = 1', lang: 'ts' }] }),
		})
		assert.equal(response.status, 200)
		const body = (await response.json()) as { results: Array<{ plain: boolean; lang: string }> }
		assert.equal(body.results.length, 1)
		assert.equal(body.results[0]?.plain, false)
		assert.equal(body.results[0]?.lang, 'ts')
	})

	it("passes the worker's 400 through for a malformed batch", async () => {
		const response = await createInProcessHighlightFetcher().fetch(highlightUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ nope: true }),
		})
		assert.equal(response.status, 400)
	})

	it('refuses oversized batches with a 413 so highlight-code falls back to plain text', async () => {
		const fetcher = createInProcessHighlightFetcher()
		const post = (snippets: Array<{ code: string; lang: string }>) =>
			fetcher.fetch(highlightUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ snippets }),
			})
		const big = Array.from({ length: 5 }, () => ({ code: 'x'.repeat(49_000), lang: 'ts' }))
		assert.equal((await post(big)).status, 413)
		const many = Array.from({ length: 201 }, () => ({ code: 'const x = 1', lang: 'ts' }))
		assert.equal((await post(many)).status, 413)
		assert.equal((await post(big.slice(0, 1))).status, 200)
	})

	it('turns a handler crash into a 500 so highlight-code falls back to plain text', async () => {
		const fetcher = createInProcessHighlightFetcher({
			fetch: async () => {
				throw new Error('tokenizer exploded')
			},
		})
		const response = await fetcher.fetch(highlightUrl, { method: 'POST', body: '{}' })
		assert.equal(response.status, 500)
	})
})
