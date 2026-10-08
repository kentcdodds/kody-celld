import highlightWorker from './index.ts'

export type InProcessHighlightHandler = {
	fetch(request: Request, env: Record<string, never>): Promise<Response>
}

/**
 * kody-celld: kody's highlight worker runs in its own isolate with its own CPU
 * limit; here tokenizing shares the isolate that serves MCP, jobs and the web
 * UI, so one batch (e.g. every fence of a hostile README) is capped. Over the
 * budget the binding answers 413 and highlight-code falls back to plain text.
 */
const maxBatchChars = 200_000
const maxBatchSnippets = 200

async function exceedsBudget(request: Request) {
	try {
		const body = (await request.json()) as { snippets?: unknown }
		if (!Array.isArray(body.snippets)) return false
		if (body.snippets.length > maxBatchSnippets) return true
		let chars = 0
		for (const snippet of body.snippets) {
			const code = (snippet as { code?: unknown } | null)?.code
			if (typeof code === 'string') chars += code.length
		}
		return chars > maxBatchChars
	} catch {
		return false
	}
}

/**
 * kody-celld: kody calls its highlight worker through the `HIGHLIGHT` service
 * binding. kody-celld runs one Worker, so the ported handler is bound
 * in-process and `#app/highlight-code.ts` stays a verbatim copy. A crash
 * becomes a 500, which highlight-code already turns into plain text.
 */
export function createInProcessHighlightFetcher(handler: InProcessHighlightHandler = highlightWorker): Fetcher {
	const fetcher = {
		async fetch(input: RequestInfo | URL, init?: RequestInit) {
			try {
				const request = new Request(input, init)
				if (await exceedsBudget(request.clone())) {
					return new Response('Highlight batch too large.', { status: 413 })
				}
				return await handler.fetch(request, {})
			} catch (error) {
				console.debug('highlight-in-process-failed', error)
				return new Response('Highlight failed.', { status: 500 })
			}
		},
	}
	return fetcher as unknown as Fetcher
}
