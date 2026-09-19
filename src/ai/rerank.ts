import { extractJsonObject, type ChatProvider } from './providers.ts'

export type RerankCandidate = { id: string; title: string; summary: string }

export const rerankWindow = 12

/**
 * Ask the configured chat model to order candidates by relevance to `query`.
 * Only the ids the model returns (that exist in the input) are reordered; the
 * rest keep their incoming order after them, so a sloppy reply degrades to the
 * original ranking instead of dropping results. Returns null on any failure so
 * callers fall back silently.
 */
export async function llmRerank(
	chat: ChatProvider,
	query: string,
	candidates: ReadonlyArray<RerankCandidate>,
): Promise<Array<string> | null> {
	if (candidates.length < 2) return candidates.map((c) => c.id)
	const window = candidates.slice(0, rerankWindow)
	const listing = window
		.map(
			(c, i) =>
				`${i + 1}. id=${JSON.stringify(c.id)} title=${JSON.stringify(c.title)} summary=${JSON.stringify(c.summary)}`,
		)
		.join('\n')
	try {
		const reply = await chat.chat({
			system:
				'You rank search results for a developer tool. Reply with a JSON object {"order": [id, ...]} listing the candidate ids from most to least relevant to the query. Include every id exactly once. No prose.',
			messages: [{ role: 'user', content: `Query: ${JSON.stringify(query)}\n\nCandidates:\n${listing}` }],
			maxTokens: 400,
			json: true,
		})
		const parsed = extractJsonObject(reply)
		const order = parsed && Array.isArray(parsed.order) ? parsed.order : null
		if (!order) return null
		const known = new Set(window.map((c) => c.id))
		const seen = new Set<string>()
		const ranked: Array<string> = []
		for (const id of order) {
			if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
				seen.add(id)
				ranked.push(id)
			}
		}
		if (ranked.length === 0) return null
		for (const c of candidates) if (!seen.has(c.id)) ranked.push(c.id)
		return ranked
	} catch {
		return null
	}
}
