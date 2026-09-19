// M3 smoke: AI status (never key material), metaMemory* verify → upsert → get →
// search → delete, conversation suppression, per-user isolation, and the
// semantic `search` tool ranking. Adapts to the server's AI configuration:
//
//   * no AI configured   → asserts the lexical-only path and ai_not_configured
//   * embeddings enabled → asserts hybrid ranking; with SMOKE_AI_MOCK=1 (see
//                          smoke/ai-mock-server.mjs) also proves a synonym-only
//                          query is found through the vector store, and that
//                          KODY_SEARCH_RERANK=llm re-orders the top window.
import { randomBytes } from 'node:crypto'
import { admin, assert, bootstrapUser, log } from './lib.mjs'

const mock = process.env.SMOKE_AI_MOCK === '1'

export async function smokeMemory({ mcp, user }) {
	const status = await mcp.call('aiStatus')
	const statusText = JSON.stringify(status)
	assert(status.ai && typeof status.ai.vectors === 'object', 'aiStatus missing ai description', status)
	assert(
		!/api[_-]?key"\s*:\s*"/i.test(statusText) && !/sk-|Bearer /.test(statusText),
		'aiStatus leaked key-like data',
		status,
	)
	const hasEmbed = status.ai.embed !== null
	const hasChat = status.ai.chat !== null
	const rerank = status.ai.rerank === 'llm'
	log('aiStatus', {
		chat: status.ai.chat?.provider ?? null,
		embed: status.ai.embed?.model ?? null,
		vectors: status.ai.vectors.provider,
		rerank: status.ai.rerank,
	})
	if (mock) assert(hasEmbed && hasChat && rerank, 'SMOKE_AI_MOCK=1 expects chat+embed+rerank=llm configured', status.ai)
	const adminAi = await admin.ai()
	assert(
		adminAi.status === 200 && JSON.stringify(adminAi.json) === JSON.stringify({ ai: status.ai }),
		'GET /admin/ai mismatch',
		adminAi.json,
	)

	// Capability discovery: memory + ai domains show up through `search` only.
	const found = await mcp.search({ query: 'remember a preference about editors' })
	assert(
		found.results.some((r) => r.id === 'metaMemoryVerify'),
		'search should surface metaMemoryVerify',
		found.results.map((r) => r.id),
	)
	assert(
		['lexical', 'hybrid', 'lexical+llm', 'hybrid+llm'].includes(found.ranking),
		'search ranking mode missing',
		found,
	)
	if (hasEmbed)
		assert(found.ranking.startsWith('hybrid'), 'expected hybrid search ranking with embeddings configured', found)
	if (rerank) assert(found.ranking.endsWith('+llm'), 'expected llm re-rank in search ranking', found)
	log('search ranking', found.ranking)

	const nonce = randomBytes(4).toString('hex')
	const dedupeKey = `pref:editor:${nonce}`
	const verifyEmpty = await mcp.call('metaMemoryVerify', {
		subject: `Editor preference ${nonce}`,
		summary: 'Prefers Zed over VS Code',
		dedupe_key: dedupeKey,
	})
	assert(verifyEmpty.dedupe_match === null, 'fresh dedupe key should not match', verifyEmpty.dedupe_match)
	assert(/metaMemoryVerify/.test(verifyEmpty.guidance), 'verify-first guidance missing', verifyEmpty.guidance)

	const created = await mcp.call('metaMemoryUpsert', {
		subject: `Editor preference ${nonce}`,
		summary: 'Prefers Zed over VS Code',
		details: `Switched in 2025 (${nonce}).`,
		category: 'preference',
		tags: ['tools', 'editor'],
		source_uris: ['https://example.com/notes/editor'],
		dedupe_key: dedupeKey,
	})
	assert(created.mode === 'created' && created.memory.status === 'active', 'upsert should create', created)
	const id = created.memory.id
	log('created', { id, warnings: created.warnings })
	if (hasEmbed) assert(created.warnings.length === 0, 'embedding on upsert reported warnings', created.warnings)

	const verifyDup = await mcp.call('metaMemoryVerify', {
		subject: 'Editor preference',
		summary: 'Prefers Zed',
		dedupe_key: dedupeKey,
	})
	assert(verifyDup.dedupe_match?.id === id, 'verify should find the dedupe match', verifyDup.dedupe_match)
	assert(
		verifyDup.related.some((m) => m.id === id),
		'verify should list the memory as related',
		verifyDup.related.map((m) => m.id),
	)

	const updated = await mcp.call('metaMemoryUpsert', {
		subject: `Editor preference ${nonce}`,
		summary: 'Prefers Zed over VS Code and Vim',
		dedupe_key: dedupeKey,
	})
	assert(
		updated.mode === 'updated' && updated.memory.id === id && /Vim/.test(updated.memory.summary),
		'dedupe key should update in place',
		updated,
	)

	const got = await mcp.call('metaMemoryGet', { id })
	assert(
		got.memory?.id === id && got.memory.last_accessed_at,
		'get should return the memory and stamp last_accessed_at',
		got,
	)

	const car = await mcp.call('metaMemoryUpsert', {
		subject: `Car ${nonce}`,
		summary: 'Drives a red car',
		category: 'fact',
		dedupe_key: `fact:car:${nonce}`,
	})
	const cat = await mcp.call('metaMemoryUpsert', {
		subject: `Cat ${nonce}`,
		summary: 'Has a cat named Miso',
		category: 'fact',
		dedupe_key: `fact:cat:${nonce}`,
	})

	const lexical = await mcp.call('metaMemorySearch', { query: `Zed ${nonce}` })
	assert(
		lexical.matches[0]?.id === id,
		'lexical search should rank the editor memory first',
		lexical.matches.map((m) => [m.id, m.score, m.lexical_rank]),
	)
	assert(lexical.matches[0].lexical_rank === 1, 'FTS rank missing', lexical.matches[0])
	assert(
		lexical.ranking === (hasEmbed ? 'hybrid' : 'lexical'),
		`expected ${hasEmbed ? 'hybrid' : 'lexical'} ranking`,
		lexical,
	)
	log('metaMemorySearch', { ranking: lexical.ranking, top: lexical.matches[0].subject })

	const byCategory = await mcp.call('metaMemorySearch', { query: nonce, category: 'fact', limit: 10 })
	assert(
		byCategory.matches.every((m) => m.category === 'fact') && byCategory.matches.length === 2,
		'category filter failed',
		byCategory.matches.map((m) => [m.subject, m.category]),
	)

	if (mock) {
		// "automobile" is not in any memory; only the mock's synonym-aware vectors can find the car.
		const semantic = await mcp.call('metaMemorySearch', { query: 'automobile', limit: 3 })
		const carMatch = semantic.matches.find((m) => m.id === car.memory.id)
		assert(
			carMatch && carMatch.vector_rank === 1 && carMatch.lexical_rank === null,
			'vector search should find the car via a synonym',
			semantic.matches,
		)
		log('semantic hit via vectors', { subject: carMatch.subject, vector_rank: carMatch.vector_rank })

		const embedded = await mcp.call('aiEmbed', { texts: ['car', 'automobile', 'cat'] })
		assert(embedded.dimensions === status.ai.embed.dimensions && embedded.vectors.length === 3, 'aiEmbed shape', {
			dims: embedded.dimensions,
		})
		const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0)
		assert(
			dot(embedded.vectors[0], embedded.vectors[1]) > 0.99 && dot(embedded.vectors[0], embedded.vectors[2]) < 0.5,
			'mock embeddings should treat car≈automobile',
			embedded.vectors.map((v) => v.slice(0, 4)),
		)

		const chat = await mcp.call('aiChat', { prompt: `ping ${nonce}`, json: true })
		assert(chat.json?.echo === `ping ${nonce}` && chat.provider === 'openai', 'aiChat json echo failed', chat)
		log('aiChat/aiEmbed', { provider: chat.provider, model: chat.model, dims: embedded.dimensions })

		// The mock re-ranker returns ids alphabetically: the capability search top window must follow it.
		const reranked = await mcp.search({ query: 'memory' })
		const window = reranked.results.slice(0, Math.min(reranked.results.length, 12)).map((r) => r.id)
		assert(reranked.ranking === 'hybrid+llm', 'expected hybrid+llm ranking', reranked.ranking)
		assert(window.join() === [...window].sort().join(), 'llm re-rank order not applied', window)
		log('llm re-rank applied', { window: window.length })
	} else if (!hasChat) {
		const { isError, payload, content } = await mcp.tool('execute', {
			code: `import { kody } from 'kody:runtime'
export default async function main() { return await kody.aiChat({ prompt: 'hi' }) }`,
		})
		const text = JSON.stringify(payload ?? content)
		assert(
			isError || /ai_not_configured/.test(text),
			'aiChat without provider should fail with ai_not_configured',
			payload,
		)
		log('aiChat unconfigured → ai_not_configured')
	}

	// Conversation suppression: the first search surfaces, the second (same conversation) hides.
	const conversation = `conv-${nonce}`
	const firstTurn = await mcp.call('metaMemorySearch', { query: `Miso ${nonce}`, conversation_id: conversation })
	assert(
		firstTurn.matches.some((m) => m.id === cat.memory.id),
		'cat memory should surface on first turn',
		firstTurn.matches.map((m) => m.subject),
	)
	const secondTurn = await mcp.call('metaMemorySearch', { query: `Miso ${nonce}`, conversation_id: conversation })
	assert(
		!secondTurn.matches.some((m) => m.id === cat.memory.id) && secondTurn.suppressed_count >= 1,
		'already-surfaced memory should be suppressed',
		secondTurn,
	)
	const forced = await mcp.call('metaMemorySearch', {
		query: `Miso ${nonce}`,
		conversation_id: conversation,
		include_suppressed_in_conversation: true,
	})
	assert(
		forced.matches.some((m) => m.id === cat.memory.id),
		'include_suppressed_in_conversation should override',
		forced.matches.map((m) => m.subject),
	)
	log('conversation suppression', { suppressed: secondTurn.suppressed_count })

	// Isolation: another user never sees these memories, even with the exact nonce.
	const other = await bootstrapUser('memory-other')
	await other.mcp.initialize()
	const leak = await other.mcp.call('metaMemorySearch', { query: nonce, limit: 20 })
	assert(leak.matches.length === 0, 'memories leaked across users', leak.matches)
	const otherGet = await other.mcp.call('metaMemoryGet', { id })
	assert(otherGet.memory === null, 'metaMemoryGet leaked across users', otherGet)
	log('isolation ok')

	// Soft delete hides, include_deleted shows, force removes.
	const soft = await mcp.call('metaMemoryDelete', { id: car.memory.id })
	assert(soft.mode === 'soft' && soft.memory.status === 'deleted', 'soft delete', soft)
	const afterSoft = await mcp.call('metaMemorySearch', { query: `red car ${nonce}` })
	assert(
		!afterSoft.matches.some((m) => m.id === car.memory.id),
		'soft-deleted memory should be hidden',
		afterSoft.matches.map((m) => m.subject),
	)
	const withDeleted = await mcp.call('metaMemorySearch', { query: `red car ${nonce}`, include_deleted: true })
	assert(
		withDeleted.matches.some((m) => m.id === car.memory.id && m.status === 'deleted'),
		'include_deleted should show it',
		withDeleted.matches,
	)
	const hard = await mcp.call('metaMemoryDelete', { id: car.memory.id, force: true })
	assert(hard.mode === 'hard', 'force delete', hard)
	const gone = await mcp.call('metaMemoryGet', { id: car.memory.id })
	assert(gone.memory === null, 'force-deleted memory should be gone', gone)
	log('delete', { soft: soft.mode, hard: hard.mode })

	// Admin views: list + reindex, and the audit log records ids/categories only.
	const listed = await admin.memories(user.id)
	assert(listed.status === 200 && listed.json.memories.some((m) => m.id === id), 'admin memory list', listed.json)
	const reindexed = await admin.reindexMemories(user.id)
	assert(
		reindexed.status === 200 && (hasEmbed ? reindexed.json.model : reindexed.json.model === null),
		'admin reindex',
		reindexed.json,
	)
	const audit = await admin.audit({ action: 'memory.create', limit: 50 })
	const auditText = JSON.stringify(audit.json)
	assert(
		audit.status === 200 && audit.json.entries.some((e) => e.target === id),
		'audit should record memory.create by id',
		audit.json,
	)
	assert(!auditText.includes('Zed') && !auditText.includes('Miso'), 'audit must not contain memory content', audit.json)
	log('admin + audit', { memories: listed.json.memories.length, reindexed: reindexed.json.reindexed })
}
