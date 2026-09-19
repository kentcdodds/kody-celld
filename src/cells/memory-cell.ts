import { DurableObject } from 'cloudflare:workers'
import { aiConfigFromEnv, describeAiConfig, type AiConfig } from '../ai/config.ts'
import { createAi, truncateEmbedInput, type Ai } from '../ai/providers.ts'
import { float32Bytes, reciprocalRankFusion, vectorFromBytes } from '../ai/ranking.ts'
import { createVectorStore, type VectorStore } from '../ai/vector-store.ts'
import type { Env } from '../env.ts'
import { sha256Hex } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import {
	memoryEmbedText,
	memoryLimits,
	ftsQuery,
	normalizeMemoryInput,
	type MemoryInput,
	type MemoryMatch,
	type MemoryRecord,
	type MemorySearchInput,
	type MemorySearchResult,
	type MemoryStatus,
} from '../memory/model.ts'

export type { MemoryInput, MemoryMatch, MemoryRecord, MemorySearchInput, MemorySearchResult, MemoryStatus }
export { memoryLimits, memoryStatuses } from '../memory/model.ts'

type MemoryRow = {
	id: string
	category: string | null
	status: MemoryStatus
	subject: string
	summary: string
	details: string
	tags_json: string
	source_uris_json: string
	dedupe_key: string | null
	embedded_model: string | null
	created_at: string
	updated_at: string
	last_accessed_at: string | null
	deleted_at: string | null
}

const suppressionTtlMs = 6 * 60 * 60 * 1000
const embeddingCacheMax = 5_000
/** Rows repaired per search when the embedding model changed or a provider call failed earlier. */
const lazyReindexBatch = 32

function nowIso() {
	return new Date().toISOString()
}

function toRecord(row: MemoryRow): MemoryRecord {
	return {
		id: row.id,
		category: row.category,
		status: row.status,
		subject: row.subject,
		summary: row.summary,
		details: row.details,
		tags: JSON.parse(row.tags_json) as Array<string>,
		sourceUris: JSON.parse(row.source_uris_json) as Array<string>,
		dedupeKey: row.dedupe_key,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastAccessedAt: row.last_accessed_at,
		deletedAt: row.deleted_at,
	}
}

/**
 * One user's memories plus that user's semantic index: FTS5 for lexical recall,
 * sqlite-vec (or Qdrant) for embeddings, and the embedding cache the `search`
 * tool uses to rank capabilities semantically. Separate from UserCell so the
 * AI-dependent surface can evolve without touching secrets/packages/jobs.
 */
export class MemoryCell extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				category TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				subject TEXT NOT NULL,
				summary TEXT NOT NULL,
				details TEXT NOT NULL DEFAULT '',
				tags_json TEXT NOT NULL DEFAULT '[]',
				source_uris_json TEXT NOT NULL DEFAULT '[]',
				dedupe_key TEXT,
				embedded_model TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_accessed_at TEXT,
				deleted_at TEXT
			);
			CREATE UNIQUE INDEX IF NOT EXISTS memories_dedupe ON memories(dedupe_key) WHERE dedupe_key IS NOT NULL;
			CREATE INDEX IF NOT EXISTS memories_status ON memories(status, updated_at DESC);
			CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
				subject, summary, details, tags, category,
				content='memories', content_rowid='rowid', tokenize='unicode61'
			);
			CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
				INSERT INTO memories_fts(rowid, subject, summary, details, tags, category)
				VALUES (new.rowid, new.subject, new.summary, new.details, new.tags_json, coalesce(new.category, ''));
			END;
			CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, subject, summary, details, tags, category)
				VALUES ('delete', old.rowid, old.subject, old.summary, old.details, old.tags_json, coalesce(old.category, ''));
			END;
			CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, subject, summary, details, tags, category)
				VALUES ('delete', old.rowid, old.subject, old.summary, old.details, old.tags_json, coalesce(old.category, ''));
				INSERT INTO memories_fts(rowid, subject, summary, details, tags, category)
				VALUES (new.rowid, new.subject, new.summary, new.details, new.tags_json, coalesce(new.category, ''));
			END;
			CREATE TABLE IF NOT EXISTS memory_suppressions (
				conversation_id TEXT NOT NULL,
				memory_id TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				PRIMARY KEY (conversation_id, memory_id)
			);
			CREATE TABLE IF NOT EXISTS embedding_cache (
				key TEXT PRIMARY KEY,
				model TEXT NOT NULL,
				vector BLOB NOT NULL,
				created_at TEXT NOT NULL
			);
		`)
		this.aiConfig = aiConfigFromEnv(env)
		this.ai = createAi(this.aiConfig)
		this.vectors = createVectorStore(this.aiConfig.vectors, this.ctx.storage.sql, this.aiConfig.timeoutMs)
	}

	private readonly aiConfig: AiConfig
	private readonly ai: Ai
	private readonly vectors: VectorStore
	private vectorsReady: Promise<void> | undefined

	private get userId() {
		const row = this.ctx.storage.sql
			.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'user_id'`)
			.toArray()[0]
		if (!row) throw new KodyError('cell_uninitialized', 'MemoryCell has no user id yet.', { status: 500 })
		return row.value
	}

	async init(userId: string) {
		this.ctx.storage.sql.exec(`INSERT INTO meta (key, value) VALUES ('user_id', ?) ON CONFLICT(key) DO NOTHING`, userId)
	}

	/** Model identity used to tell fresh vectors from stale ones. */
	private get embedModelId() {
		const embed = this.aiConfig.embed
		return embed ? `${embed.provider}:${embed.model}:${embed.dimensions}` : null
	}

	private ensureVectors() {
		const embed = this.aiConfig.embed
		if (!embed) return Promise.resolve()
		this.vectorsReady ??= (async () => {
			const { recreated } = await this.vectors.ensure(embed.dimensions)
			if (recreated) this.ctx.storage.sql.exec(`UPDATE memories SET embedded_model = NULL`)
		})().catch((error: unknown) => {
			this.vectorsReady = undefined
			throw error
		})
		return this.vectorsReady
	}

	// --------------------------------------------------------------- embeddings

	/**
	 * Embed texts through the configured provider with a content-addressed cache.
	 * Used by the `search` tool for capability/package docs and by memories.
	 * Returns null when no embedding provider is configured.
	 */
	async embedCached(texts: Array<string>): Promise<Array<Array<number>> | null> {
		const provider = this.ai.embeddings
		const modelId = this.embedModelId
		if (!provider || !modelId) return null
		const normalized = texts.map(truncateEmbedInput)
		const keys = await Promise.all(normalized.map(async (text) => `${modelId}:${await sha256Hex(text)}`))
		const cached = new Map<string, Array<number>>()
		for (const key of keys) {
			const row = this.ctx.storage.sql
				.exec<{ vector: ArrayBuffer }>(`SELECT vector FROM embedding_cache WHERE key = ?`, key)
				.toArray()[0]
			if (row) cached.set(key, vectorFromBytes(row.vector))
		}
		const missing = [...new Set(keys.filter((key) => !cached.has(key)))]
		if (missing.length > 0) {
			const byKey = new Map(keys.map((key, i) => [key, normalized[i]!]))
			const vectors = await provider.embed(missing.map((key) => byKey.get(key)!))
			const at = nowIso()
			missing.forEach((key, i) => {
				const vector = vectors[i]!
				cached.set(key, vector)
				this.ctx.storage.sql.exec(
					`INSERT INTO embedding_cache (key, model, vector, created_at) VALUES (?, ?, ?, ?)
					 ON CONFLICT(key) DO UPDATE SET vector = excluded.vector, created_at = excluded.created_at`,
					key,
					modelId,
					float32Bytes(vector),
					at,
				)
			})
			this.ctx.storage.sql.exec(
				`DELETE FROM embedding_cache WHERE key NOT IN (SELECT key FROM embedding_cache ORDER BY created_at DESC LIMIT ?)`,
				embeddingCacheMax,
			)
		}
		return keys.map((key) => cached.get(key)!)
	}

	private async indexMemories(rows: Array<MemoryRow>) {
		const modelId = this.embedModelId
		if (!modelId || rows.length === 0) return
		await this.ensureVectors()
		const vectors = await this.embedCached(rows.map((row) => memoryEmbedText(toRecord(row))))
		if (!vectors) return
		await this.vectors.upsert(
			rows.map((row, i) => ({
				id: row.id,
				vector: vectors[i]!,
				payload: { userId: this.userId, status: row.status, category: row.category ?? '' },
			})),
		)
		for (const row of rows) {
			this.ctx.storage.sql.exec(`UPDATE memories SET embedded_model = ? WHERE id = ?`, modelId, row.id)
		}
	}

	/** Embed rows whose vector is missing or from another model. Returns how many were repaired. */
	private async repairStaleVectors(limit: number) {
		const modelId = this.embedModelId
		if (!modelId) return 0
		const rows = this.ctx.storage.sql
			.exec<MemoryRow>(
				`SELECT * FROM memories WHERE embedded_model IS NULL OR embedded_model != ? ORDER BY updated_at DESC LIMIT ?`,
				modelId,
				limit,
			)
			.toArray()
		await this.indexMemories(rows)
		return rows.length
	}

	/** Re-embed every memory with the current model (admin, after changing providers). */
	async memoryReindex(): Promise<{ model: string | null; reindexed: number; vectorStore: string }> {
		const modelId = this.embedModelId
		if (!modelId) return { model: null, reindexed: 0, vectorStore: this.vectors.kind }
		await this.ensureVectors()
		this.ctx.storage.sql.exec(`UPDATE memories SET embedded_model = NULL`)
		let total = 0
		for (;;) {
			const repaired = await this.repairStaleVectors(lazyReindexBatch)
			total += repaired
			if (repaired < lazyReindexBatch) break
		}
		return { model: modelId, reindexed: total, vectorStore: this.vectors.kind }
	}

	async aiStatus() {
		const counts = this.ctx.storage.sql
			.exec<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM memories GROUP BY status`)
			.toArray()
		const stale = this.embedModelId
			? Number(
					this.ctx.storage.sql
						.exec<{ n: number }>(
							`SELECT COUNT(*) AS n FROM memories WHERE embedded_model IS NULL OR embedded_model != ?`,
							this.embedModelId,
						)
						.toArray()[0]?.n ?? 0,
				)
			: null
		return {
			ai: describeAiConfig(this.aiConfig),
			memories: Object.fromEntries(counts.map((row) => [row.status, row.n])),
			staleVectors: stale,
			embeddingCacheSize: Number(
				this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM embedding_cache`).toArray()[0]?.n ?? 0,
			),
		}
	}

	// ----------------------------------------------------------------- memories

	private rowById(id: string) {
		return this.ctx.storage.sql.exec<MemoryRow>(`SELECT * FROM memories WHERE id = ?`, id).toArray()[0] ?? null
	}

	async memoryUpsert(
		input: MemoryInput & { id?: string | null | undefined; status?: MemoryStatus | undefined },
	): Promise<{ mode: 'created' | 'updated'; memory: MemoryRecord; warnings: Array<string> }> {
		const normalized = normalizeMemoryInput(input)
		const warnings: Array<string> = []
		const now = nowIso()
		let existing: MemoryRow | null = null
		if (input.id) {
			existing = this.rowById(input.id)
			if (!existing) throw new KodyError('memory_not_found', `No memory with id "${input.id}".`, { status: 404 })
		} else if (normalized.dedupeKey) {
			existing =
				this.ctx.storage.sql
					.exec<MemoryRow>(`SELECT * FROM memories WHERE dedupe_key = ?`, normalized.dedupeKey)
					.toArray()[0] ?? null
		}
		if (normalized.dedupeKey) {
			const clash = this.ctx.storage.sql
				.exec<{ id: string }>(
					`SELECT id FROM memories WHERE dedupe_key = ? AND id != ?`,
					normalized.dedupeKey,
					existing?.id ?? '',
				)
				.toArray()[0]
			if (clash) {
				throw new KodyError(
					'memory_dedupe_conflict',
					`dedupe_key "${normalized.dedupeKey}" belongs to memory ${clash.id}.`,
					{
						status: 409,
						details: { memoryId: clash.id },
					},
				)
			}
		}
		const status: MemoryStatus =
			input.status ?? (existing && existing.status !== 'deleted' ? existing.status : 'active')
		const id = existing?.id ?? crypto.randomUUID()
		if (existing) {
			this.ctx.storage.sql.exec(
				`UPDATE memories SET category = ?, status = ?, subject = ?, summary = ?, details = ?, tags_json = ?, source_uris_json = ?,
					dedupe_key = ?, embedded_model = NULL, updated_at = ?, deleted_at = ? WHERE id = ?`,
				normalized.category,
				status,
				normalized.subject,
				normalized.summary,
				normalized.details,
				JSON.stringify(normalized.tags),
				JSON.stringify(normalized.sourceUris),
				normalized.dedupeKey,
				now,
				status === 'deleted' ? (existing.deleted_at ?? now) : null,
				id,
			)
		} else {
			this.ctx.storage.sql.exec(
				`INSERT INTO memories (id, category, status, subject, summary, details, tags_json, source_uris_json, dedupe_key, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				normalized.category,
				status,
				normalized.subject,
				normalized.summary,
				normalized.details,
				JSON.stringify(normalized.tags),
				JSON.stringify(normalized.sourceUris),
				normalized.dedupeKey,
				now,
				now,
			)
		}
		const row = this.rowById(id)!
		try {
			await this.indexMemories([row])
		} catch (error) {
			// The memory is saved either way; the vector is repaired lazily on the next search.
			warnings.push(`embedding_deferred: ${error instanceof Error ? error.message : String(error)}`)
		}
		return { mode: existing ? 'updated' : 'created', memory: toRecord(row), warnings }
	}

	async memoryGet(input: { id: string }): Promise<MemoryRecord | null> {
		const row = this.rowById(input.id)
		if (!row) return null
		this.ctx.storage.sql.exec(`UPDATE memories SET last_accessed_at = ? WHERE id = ?`, nowIso(), input.id)
		return toRecord({ ...row, last_accessed_at: nowIso() })
	}

	async memoryList(
		input: { limit?: number | undefined; status?: MemoryStatus | undefined } = {},
	): Promise<Array<MemoryRecord>> {
		const limit = Math.min(Math.max(input.limit ?? 50, 1), 500)
		const rows = input.status
			? this.ctx.storage.sql
					.exec<MemoryRow>(
						`SELECT * FROM memories WHERE status = ? ORDER BY updated_at DESC LIMIT ?`,
						input.status,
						limit,
					)
					.toArray()
			: this.ctx.storage.sql.exec<MemoryRow>(`SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?`, limit).toArray()
		return rows.map(toRecord)
	}

	async memoryDelete(input: {
		id: string
		force?: boolean | undefined
	}): Promise<{ id: string; mode: 'soft' | 'hard'; memory: MemoryRecord | null }> {
		const row = this.rowById(input.id)
		if (!row) throw new KodyError('memory_not_found', `No memory with id "${input.id}".`, { status: 404 })
		if (input.force) {
			this.ctx.storage.sql.exec(`DELETE FROM memories WHERE id = ?`, input.id)
			this.ctx.storage.sql.exec(`DELETE FROM memory_suppressions WHERE memory_id = ?`, input.id)
			if (this.embedModelId) {
				await this.ensureVectors()
				await this.vectors.delete([input.id])
			}
			return { id: input.id, mode: 'hard', memory: null }
		}
		const now = nowIso()
		this.ctx.storage.sql.exec(
			`UPDATE memories SET status = 'deleted', deleted_at = ?, updated_at = ?, embedded_model = NULL WHERE id = ?`,
			now,
			now,
			input.id,
		)
		const updated = this.rowById(input.id)!
		try {
			await this.indexMemories([updated])
		} catch {
			// status stays 'deleted' in SQLite; the vector payload catches up on the next repair pass.
		}
		return { id: input.id, mode: 'soft', memory: toRecord(updated) }
	}

	// ------------------------------------------------------------------- search

	private lexicalRanking(query: string, statuses: ReadonlyArray<MemoryStatus>, category: string | null, limit: number) {
		const expression = ftsQuery(query)
		if (!expression) return []
		const placeholders = statuses.map(() => '?').join(', ')
		const params: Array<string | number> = [expression, ...statuses]
		let where = `memories_fts MATCH ? AND m.status IN (${placeholders})`
		if (category) {
			where += ` AND m.category = ?`
			params.push(category)
		}
		params.push(limit)
		return this.ctx.storage.sql
			.exec<{ id: string }>(
				`SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE ${where} ORDER BY bm25(memories_fts) LIMIT ?`,
				...params,
			)
			.toArray()
			.map((row) => row.id)
	}

	private pruneSuppressions() {
		this.ctx.storage.sql.exec(`DELETE FROM memory_suppressions WHERE expires_at < ?`, nowIso())
	}

	async memorySearch(input: MemorySearchInput): Promise<MemorySearchResult> {
		const query = input.query?.trim() ?? ''
		if (!query) throw new KodyError('invalid_args', '"query" is required.')
		const limit = Math.min(Math.max(input.limit ?? 5, 1), memoryLimits.searchLimit)
		const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : (['active'] as const)
		const category = input.category?.trim() || null
		const conversationId = input.conversationId?.trim() || null
		if (conversationId && conversationId.length > memoryLimits.conversationId) {
			throw new KodyError(
				'invalid_args',
				`"conversation_id" must be at most ${memoryLimits.conversationId} characters.`,
			)
		}
		const warnings: Array<string> = []
		const candidateLimit = limit * 4

		const lexical = this.lexicalRanking(query, statuses, category, candidateLimit)
		let vector: Array<{ id: string; score: number }> = []
		if (this.embedModelId) {
			try {
				await this.ensureVectors()
				await this.repairStaleVectors(lazyReindexBatch)
				const [queryVector] = (await this.embedCached([query])) ?? []
				if (queryVector) {
					vector = await this.vectors.query(queryVector, candidateLimit, { userId: this.userId, statuses, category })
				}
			} catch (error) {
				warnings.push(`semantic_unavailable: ${error instanceof Error ? error.message : String(error)}`)
				vector = []
			}
		}
		const vectorIds = vector.map((hit) => hit.id)
		const fused = reciprocalRankFusion([lexical, vectorIds])
		const rowsById = new Map<string, MemoryRow>()
		for (const id of fused.keys()) {
			const row = this.rowById(id)
			// The vector store can lag SQLite (deleted/archived rows); SQLite is the truth.
			if (row && statuses.includes(row.status) && (!category || row.category === category)) rowsById.set(id, row)
		}
		const ranked = [...rowsById.keys()].sort((a, b) => fused.get(b)! - fused.get(a)! || a.localeCompare(b))

		this.pruneSuppressions()
		let suppressedCount = 0
		let visible = ranked
		if (conversationId && !input.includeSuppressedInConversation) {
			const suppressed = new Set(
				this.ctx.storage.sql
					.exec<{ memory_id: string }>(
						`SELECT memory_id FROM memory_suppressions WHERE conversation_id = ?`,
						conversationId,
					)
					.toArray()
					.map((row) => row.memory_id),
			)
			visible = ranked.filter((id) => !suppressed.has(id))
			suppressedCount = ranked.length - visible.length
		}
		const top = visible.slice(0, limit)
		const bestScore = top[0] ? fused.get(top[0])! : 1
		const matches: Array<MemoryMatch> = top.map((id) => {
			const lexicalRank = lexical.indexOf(id)
			const vectorRank = vectorIds.indexOf(id)
			return {
				...toRecord(rowsById.get(id)!),
				score: Number((fused.get(id)! / bestScore).toFixed(4)),
				lexicalRank: lexicalRank === -1 ? null : lexicalRank + 1,
				vectorRank: vectorRank === -1 ? null : vectorRank + 1,
			}
		})
		if (top.length > 0) {
			const now = nowIso()
			for (const id of top) this.ctx.storage.sql.exec(`UPDATE memories SET last_accessed_at = ? WHERE id = ?`, now, id)
			if (conversationId && input.acknowledge !== false) {
				const expiresAt = new Date(Date.now() + suppressionTtlMs).toISOString()
				for (const id of top) {
					this.ctx.storage.sql.exec(
						`INSERT INTO memory_suppressions (conversation_id, memory_id, expires_at) VALUES (?, ?, ?)
						 ON CONFLICT(conversation_id, memory_id) DO UPDATE SET expires_at = excluded.expires_at`,
						conversationId,
						id,
						expiresAt,
					)
				}
			}
		}
		return {
			query,
			matches,
			suppressedCount,
			ranking: this.embedModelId !== null && warnings.length === 0 ? 'hybrid' : 'lexical',
			warnings,
		}
	}

	async memoryVerify(input: {
		candidate: MemoryInput
		limit?: number | undefined
		conversationId?: string | null | undefined
		includeSuppressedInConversation?: boolean | undefined
	}) {
		const candidate = normalizeMemoryInput(input.candidate)
		const exact = candidate.dedupeKey
			? (this.ctx.storage.sql
					.exec<MemoryRow>(`SELECT * FROM memories WHERE dedupe_key = ?`, candidate.dedupeKey)
					.toArray()[0] ?? null)
			: null
		const query = [candidate.subject, candidate.summary, candidate.tags.join(' ')].filter(Boolean).join(' ')
		const result = await this.memorySearch({
			query,
			limit: input.limit ?? 5,
			statuses: ['active', 'archived'],
			conversationId: input.conversationId,
			includeSuppressedInConversation: input.includeSuppressedInConversation,
			acknowledge: false,
		})
		return {
			candidate,
			dedupeMatch: exact ? toRecord(exact) : null,
			related: result.matches,
			suppressedCount: result.suppressedCount,
			ranking: result.ranking,
			warnings: result.warnings,
		}
	}

	async count(): Promise<number> {
		return Number(
			this.ctx.storage.sql
				.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE status != 'deleted'`)
				.toArray()[0]?.n ?? 0,
		)
	}
}
