import { KodyError } from '../lib/errors.ts'
import type { VectorConfig } from './config.ts'
import type { FetchLike } from './providers.ts'

/**
 * Where memory vectors live. `local` keeps them inside the owning Durable
 * Object's SQLite via sqlite-vec (`vec0`, enabled by the `sqlite_vec`
 * compatibility flag), so a single-node install needs nothing else. `qdrant`
 * talks to a Qdrant server over REST for operators who already run one.
 *
 * Payload keys are a flat string map. `userId` is always present so a shared
 * external collection stays partitioned per user.
 */

export type VectorPayload = { userId: string; status: string; category: string }

export type VectorRecord = { id: string; vector: Array<number>; payload: VectorPayload }

export type VectorFilter = {
	userId: string
	statuses: ReadonlyArray<string>
	category?: string | null | undefined
}

export type VectorMatch = { id: string; score: number }

export type VectorStore = {
	readonly kind: VectorConfig['provider']
	/** Make sure the index exists with the given dimensionality; recreates on mismatch. */
	ensure(dimensions: number): Promise<{ recreated: boolean }>
	upsert(records: Array<VectorRecord>): Promise<void>
	delete(ids: Array<string>): Promise<void>
	query(vector: Array<number>, topK: number, filter: VectorFilter): Promise<Array<VectorMatch>>
	/** Ids currently indexed for this user (used to reconcile after config changes). */
	ids(userId: string): Promise<Array<string>>
}

// ------------------------------------------------------------------ local (vec0)

export const localVectorTable = 'memory_vectors'

// vec0 stores each chunk of vectors as one blob (chunk_size * dimensions * 4
// bytes). Durable Object SQLite caps a single value near 2 MB, so size chunks
// to stay well under it; vec0 requires a multiple of 8.
const localChunkBudgetBytes = 1_048_576
export function localChunkSize(dimensions: number): number {
	const fit = Math.floor(localChunkBudgetBytes / (dimensions * 4))
	return Math.max(8, Math.min(1024, fit - (fit % 8)))
}

export class LocalVectorStore implements VectorStore {
	readonly kind = 'local' as const
	private readonly sql: SqlStorage
	constructor(sql: SqlStorage) {
		this.sql = sql
	}

	private currentSchema(): { dimensions: number; chunkSize: number | null } | null {
		const row = this.sql
			.exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, localVectorTable)
			.toArray()[0]
		const dims = row ? /float\[(\d+)\]/.exec(row.sql) : null
		if (!row || !dims) return null
		const chunk = /chunk_size=(\d+)/.exec(row.sql)
		return { dimensions: Number(dims[1]), chunkSize: chunk ? Number(chunk[1]) : null }
	}

	async ensure(dimensions: number) {
		const existing = this.currentSchema()
		if (existing?.dimensions === dimensions && existing.chunkSize === localChunkSize(dimensions)) {
			return { recreated: false }
		}
		if (existing !== null) this.sql.exec(`DROP TABLE ${localVectorTable}`)
		try {
			this.sql.exec(
				`CREATE VIRTUAL TABLE ${localVectorTable} USING vec0(
					chunk_size=${localChunkSize(dimensions)},
					id TEXT PRIMARY KEY,
					embedding float[${dimensions}] distance_metric=cosine,
					user_id TEXT,
					status TEXT,
					category TEXT
				)`,
			)
		} catch (error) {
			throw new KodyError(
				'vector_store_unavailable',
				`sqlite-vec (vec0) is not available in this runtime: ${error instanceof Error ? error.message : String(error)}. Add "sqlite_vec" to compatibility_flags or set KODY_VECTOR_PROVIDER=qdrant.`,
				{ status: 500 },
			)
		}
		return { recreated: existing !== null }
	}

	async upsert(records: Array<VectorRecord>) {
		for (const record of records) {
			this.sql.exec(`DELETE FROM ${localVectorTable} WHERE id = ?`, record.id)
			this.sql.exec(
				`INSERT INTO ${localVectorTable} (id, embedding, user_id, status, category) VALUES (?, ?, ?, ?, ?)`,
				record.id,
				JSON.stringify(record.vector),
				record.payload.userId,
				record.payload.status,
				record.payload.category,
			)
		}
	}

	async delete(ids: Array<string>) {
		for (const id of ids) this.sql.exec(`DELETE FROM ${localVectorTable} WHERE id = ?`, id)
	}

	async query(vector: Array<number>, topK: number, filter: VectorFilter) {
		if (this.currentSchema() === null) return []
		// vec0 KNN supports equality metadata filters; the status list is
		// applied afterwards on an over-fetched candidate set.
		const params: Array<string | number> = [JSON.stringify(vector), Math.max(topK * 4, 16), filter.userId]
		let where = `embedding MATCH ? AND k = ? AND user_id = ?`
		if (filter.category) {
			where += ` AND category = ?`
			params.push(filter.category)
		}
		const rows = this.sql
			.exec<{ id: string; distance: number; status: string }>(
				`SELECT id, distance, status FROM ${localVectorTable} WHERE ${where} ORDER BY distance`,
				...params,
			)
			.toArray()
		return rows
			.filter((row) => filter.statuses.includes(row.status))
			.slice(0, topK)
			.map((row) => ({ id: row.id, score: 1 - row.distance }))
	}

	async ids(userId: string) {
		if (this.currentSchema() === null) return []
		return this.sql
			.exec<{ id: string }>(`SELECT id FROM ${localVectorTable} WHERE user_id = ?`, userId)
			.toArray()
			.map((row) => row.id)
	}
}

// ---------------------------------------------------------------------- Qdrant

type QdrantConfig = Extract<VectorConfig, { provider: 'qdrant' }>

export class QdrantVectorStore implements VectorStore {
	readonly kind = 'qdrant' as const
	private readonly config: QdrantConfig
	private readonly timeoutMs: number
	private readonly fetchImpl: FetchLike
	constructor(config: QdrantConfig, timeoutMs: number, fetchImpl: FetchLike = fetch) {
		this.config = config
		this.timeoutMs = timeoutMs
		this.fetchImpl = fetchImpl
	}

	private get collectionUrl() {
		return `${this.config.url}/collections/${encodeURIComponent(this.config.collection)}`
	}

	private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
		const headers: Record<string, string> = { 'content-type': 'application/json' }
		if (this.config.apiKey) headers['api-key'] = this.config.apiKey
		let response: Response
		try {
			response = await this.fetchImpl(`${this.collectionUrl}${path}`, {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(this.timeoutMs),
			})
		} catch (error) {
			throw new KodyError(
				'vector_store_unavailable',
				`qdrant request failed: ${error instanceof Error ? error.message : String(error)}`,
				{ status: 502 },
			)
		}
		const text = await response.text()
		let parsed: unknown = null
		try {
			parsed = text ? (JSON.parse(text) as unknown) : null
		} catch {
			parsed = null
		}
		const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
		if (!response.ok) {
			record.httpStatus = response.status
			if (response.status !== 404) {
				throw new KodyError(
					'vector_store_error',
					`qdrant ${method} ${path} responded ${response.status}: ${text.slice(0, 300)}`,
					{
						status: 502,
					},
				)
			}
		}
		return record
	}

	async ensure(dimensions: number) {
		const info = await this.request('GET', '')
		if (info.httpStatus === 404) {
			await this.createCollection(dimensions)
			return { recreated: false }
		}
		const result = info.result as Record<string, unknown> | undefined
		const config = result?.config as Record<string, unknown> | undefined
		const params = config?.params as Record<string, unknown> | undefined
		const vectors = params?.vectors as Record<string, unknown> | undefined
		const size = typeof vectors?.size === 'number' ? vectors.size : null
		if (size === dimensions) {
			await this.ensureIndexes()
			return { recreated: false }
		}
		await this.request('DELETE', '')
		await this.createCollection(dimensions)
		return { recreated: true }
	}

	private async createCollection(dimensions: number) {
		await this.request('PUT', '', { vectors: { size: dimensions, distance: 'Cosine' } })
		await this.ensureIndexes()
	}

	private async ensureIndexes() {
		for (const field of ['userId', 'status', 'category']) {
			await this.request('PUT', '/index?wait=true', { field_name: field, field_schema: 'keyword' })
		}
	}

	async upsert(records: Array<VectorRecord>) {
		if (records.length === 0) return
		await this.request('PUT', '/points?wait=true', {
			points: records.map((record) => ({ id: record.id, vector: record.vector, payload: record.payload })),
		})
	}

	async delete(ids: Array<string>) {
		if (ids.length === 0) return
		await this.request('POST', '/points/delete?wait=true', { points: ids })
	}

	async query(vector: Array<number>, topK: number, filter: VectorFilter) {
		const must: Array<unknown> = [
			{ key: 'userId', match: { value: filter.userId } },
			{ key: 'status', match: { any: [...filter.statuses] } },
		]
		if (filter.category) must.push({ key: 'category', match: { value: filter.category } })
		const payload = await this.request('POST', '/points/search', {
			vector,
			limit: topK,
			with_payload: false,
			filter: { must },
		})
		const result = Array.isArray(payload.result) ? payload.result : []
		return result
			.filter((hit): hit is { id: string; score: number } => {
				return typeof hit === 'object' && hit !== null && typeof (hit as { id?: unknown }).id === 'string'
			})
			.map((hit) => ({ id: hit.id, score: typeof hit.score === 'number' ? hit.score : 0 }))
	}

	async ids(userId: string) {
		const ids: Array<string> = []
		let offset: unknown = null
		do {
			const payload = await this.request('POST', '/points/scroll', {
				filter: { must: [{ key: 'userId', match: { value: userId } }] },
				limit: 256,
				with_payload: false,
				with_vector: false,
				...(offset === null ? {} : { offset }),
			})
			const result = (payload.result ?? {}) as { points?: Array<{ id?: unknown }>; next_page_offset?: unknown }
			for (const point of result.points ?? []) if (typeof point.id === 'string') ids.push(point.id)
			offset = result.next_page_offset ?? null
		} while (offset !== null)
		return ids
	}
}

export function createVectorStore(
	config: VectorConfig,
	sql: SqlStorage,
	timeoutMs: number,
	fetchImpl?: FetchLike,
): VectorStore {
	if (config.provider === 'qdrant') return new QdrantVectorStore(config, timeoutMs, fetchImpl)
	return new LocalVectorStore(sql)
}
