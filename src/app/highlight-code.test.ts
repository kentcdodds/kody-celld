import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	collectMarkdownFences,
	highlightJsonValue,
	highlightMarkdownFences,
	highlightResultsByKey,
	highlightSnippets,
	uniqueHighlightSnippets,
} from '#app/highlight-code.ts'
import { highlightCacheHeaderName } from '#universal/highlight-cache-header.ts'
import {
	highlightSnippetKey,
	plainHighlightedCode,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
import { createInProcessHighlightFetcher } from '../highlight/binding.ts'

// Ported from kody packages/worker/src/app/highlight-code.node.test.ts (vitest → node:test),
// plus one case through kody-celld's in-process binding.
function highlightedFixture(
	code: string,
	lang = 'typescript',
): HighlightedCode {
	return {
		code,
		lang,
		plain: false,
		lines: [
			[{ content: code, style: { color: '#111', '--shiki-dark': '#eee' } }],
		],
	}
}

function assertTiming(timing: Array<ServerTimingEntry>, desc: string) {
	assert.equal(timing.length, 1)
	assert.equal(timing[0]?.name, 'highlight')
	assert.equal(timing[0]?.desc, desc)
}

describe('highlight-code', () => {
	it('collectMarkdownFences walks top-level and nested code tokens', () => {
		assert.deepEqual(
			collectMarkdownFences(
				['# Title', '', '```ts', 'const x = 1', '```', '', '- item', ''].join(
					'\n',
				),
			),
			[{ code: 'const x = 1', lang: 'ts' }],
		)
		assert.deepEqual(
			collectMarkdownFences(
				['> quote', '', '> ```json', '> {"ok": true}', '> ```'].join('\n'),
			),
			[{ code: '{"ok": true}', lang: 'json' }],
		)
	})

	it('highlightSnippets covers fallback, worker timings, key mapping, and worker errors', async () => {
		const fallbackTiming: Array<ServerTimingEntry> = []
		const fallback = await highlightSnippets(
			{},
			[{ code: 'const x = 1', lang: 'ts' }],
			{
				serverTiming: fallbackTiming,
			},
		)
		assert.deepEqual(fallback, [plainHighlightedCode('const x = 1', 'ts')])
		assertTiming(fallbackTiming, 'fallback')

		const snippet = { code: 'const x = 1', lang: 'ts' as const }
		const fixture = highlightedFixture(snippet.code)
		const workerTiming: Array<ServerTimingEntry> = []
		const workerEnv = {
			HIGHLIGHT: {
				fetch: async () =>
					Response.json(
						{ results: [fixture] },
						{ headers: { [highlightCacheHeaderName]: 'hit' } },
					),
			} as unknown as Fetcher,
		}
		const workerResults = await highlightSnippets(workerEnv, [snippet], {
			serverTiming: workerTiming,
		})
		assert.deepEqual(workerResults, [fixture])
		assertTiming(workerTiming, 'worker')
		assert.deepEqual(highlightResultsByKey([snippet], workerResults), {
			[highlightSnippetKey(snippet)]: fixture,
		})
		assert.deepEqual(
			uniqueHighlightSnippets([snippet, snippet, { code: 'x', lang: 'txt' }]),
			[snippet, { code: 'x', lang: 'txt' }],
		)

		const missTiming: Array<ServerTimingEntry> = []
		const missEnv = {
			HIGHLIGHT: {
				fetch: async () =>
					Response.json(
						{ results: [fixture] },
						{ headers: { [highlightCacheHeaderName]: 'miss' } },
					),
			} as unknown as Fetcher,
		}
		assert.deepEqual(
			await highlightSnippets(missEnv, [snippet], { serverTiming: missTiming }),
			[fixture],
		)
		assertTiming(missTiming, 'miss')

		const errorEnv = {
			HIGHLIGHT: {
				fetch: async () => new Response('nope', { status: 503 }),
			} as unknown as Fetcher,
		}
		assert.deepEqual(
			await highlightSnippets(errorEnv, [{ code: 'const x = 1', lang: 'ts' }]),
			[plainHighlightedCode('const x = 1', 'ts')],
		)
	})

	it('highlightMarkdownFences and highlightJsonValue use the worker', async () => {
		const markdownFixture = highlightedFixture('const x = 1')
		const jsonFixture = highlightedFixture('{\n  "ok": true\n}', 'json')
		let calls = 0
		const env = {
			HIGHLIGHT: {
				fetch: async () => {
					calls += 1
					return Response.json({
						results: calls === 1 ? [markdownFixture] : [jsonFixture],
					})
				},
			} as unknown as Fetcher,
		}
		assert.deepEqual(
			await highlightMarkdownFences(env, '```ts\nconst x = 1\n```'),
			[markdownFixture],
		)
		assert.deepEqual(await highlightJsonValue(env, { ok: true }), jsonFixture)
	})

	it('highlights through the in-process binding (kody-celld)', async () => {
		const [result] = await highlightSnippets(
			{ HIGHLIGHT: createInProcessHighlightFetcher() },
			[{ code: 'const x = 1', lang: 'ts' }],
		)
		assert.equal(result?.plain, false)
		assert.equal(result?.lang, 'ts')
		assert.ok((result?.lines.length ?? 0) > 0)
	})
})
