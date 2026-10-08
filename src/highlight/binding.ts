import highlightWorker from './index.ts'

export type InProcessHighlightHandler = {
	fetch(request: Request, env: Record<string, never>): Promise<Response>
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
				return await handler.fetch(new Request(input, init), {})
			} catch (error) {
				console.debug('highlight-in-process-failed', error)
				return new Response('Highlight failed.', { status: 500 })
			}
		},
	}
	return fetcher as unknown as Fetcher
}
