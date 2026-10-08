import { highlightCacheHeaderName } from '../../universal/highlight-cache-header.ts'
import { type HighlightedCode, type HighlightSnippet } from '../../universal/highlighted-code.ts'
import { handleHighlightHealthRequest } from './health.ts'
import { tokenizeSnippets } from './tokenize.ts'

/**
 * kody-celld: kody's highlight worker runs in its own isolate with its own CPU
 * limit; here tokenizing shares the isolate that serves MCP, jobs and the web
 * UI, so one batch (e.g. every fence of a hostile README) is capped. Over the
 * budget the binding answers 413 and highlight-code falls back to plain text.
 */
const maxBatchChars = 200_000
const maxBatchSnippets = 200

function isSnippet(value: unknown): value is HighlightSnippet {
	if (typeof value !== 'object' || value === null) return false
	const snippet = value as { code?: unknown; lang?: unknown }
	if (typeof snippet.code !== 'string') return false
	return snippet.lang === undefined || snippet.lang === null || typeof snippet.lang === 'string'
}

function parseSnippets(value: unknown): Array<HighlightSnippet> | null {
	if (typeof value !== 'object' || value === null) return null
	const body = value as { snippets?: unknown }
	if (!Array.isArray(body.snippets)) return null
	if (!body.snippets.every(isSnippet)) return null
	return body.snippets
}

function batchOverBudget(snippets: Array<HighlightSnippet>) {
	if (snippets.length > maxBatchSnippets) return true
	let chars = 0
	for (const snippet of snippets) chars += snippet.code.length
	return chars > maxBatchChars
}

function highlightJsonResponse(results: Array<HighlightedCode>, cache: 'hit' | 'miss') {
	return Response.json({ results }, { headers: { [highlightCacheHeaderName]: cache } })
}

/**
 * kody-celld: kody calls its highlight worker through the `HIGHLIGHT` service
 * binding. kody-celld runs one Worker, so the ported handler contract is
 * answered in-process and `#app/highlight-code.ts` stays a verbatim copy.
 *
 * Skip the worker's `kody-highlight-tokens` Cache API write: in kody that cache
 * lives in a separate isolate from highlight-code's `kody-highlight-origin`
 * cache; here both would share one process and double-store every batch.
 * Origin cache in highlight-code is enough. A crash becomes a 500, which
 * highlight-code already turns into plain text.
 */
export function createInProcessHighlightFetcher(): Fetcher {
	const fetcher = {
		async fetch(input: RequestInfo | URL, init?: RequestInit) {
			try {
				const request = new Request(input, init)
				const health = handleHighlightHealthRequest(request, {})
				if (health) return health

				const url = new URL(request.url)
				if (request.method !== 'POST' || url.pathname !== '/highlight') {
					return new Response('Not found', { status: 404 })
				}

				let parsed: unknown
				try {
					parsed = await request.json()
				} catch {
					return Response.json({ error: 'Invalid JSON.' }, { status: 400 })
				}
				const snippets = parseSnippets(parsed)
				if (!snippets) {
					return Response.json({ error: 'Expected { snippets }.' }, { status: 400 })
				}
				if (batchOverBudget(snippets)) {
					return new Response('Highlight batch too large.', { status: 413 })
				}

				return highlightJsonResponse(tokenizeSnippets(snippets), 'miss')
			} catch (error) {
				console.debug('highlight-in-process-failed', error)
				return new Response('Highlight failed.', { status: 500 })
			}
		},
	}
	return fetcher as unknown as Fetcher
}
