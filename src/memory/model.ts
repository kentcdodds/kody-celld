import { truncateEmbedInput } from '../ai/providers.ts'
import { KodyError } from '../lib/errors.ts'

export const memoryStatuses = ['active', 'archived', 'deleted'] as const
export type MemoryStatus = (typeof memoryStatuses)[number]

export type MemoryRecord = {
	id: string
	category: string | null
	status: MemoryStatus
	subject: string
	summary: string
	details: string
	tags: Array<string>
	sourceUris: Array<string>
	dedupeKey: string | null
	createdAt: string
	updatedAt: string
	lastAccessedAt: string | null
	deletedAt: string | null
}

export type MemoryMatch = MemoryRecord & {
	score: number
	lexicalRank: number | null
	vectorRank: number | null
}

export type MemoryInput = {
	subject: string
	summary: string
	details?: string | null | undefined
	category?: string | null | undefined
	tags?: Array<string> | null | undefined
	sourceUris?: Array<string> | null | undefined
	dedupeKey?: string | null | undefined
}

export type MemorySearchInput = {
	query: string
	limit?: number | undefined
	category?: string | null | undefined
	statuses?: ReadonlyArray<MemoryStatus> | undefined
	conversationId?: string | null | undefined
	includeSuppressedInConversation?: boolean | undefined
	/** Record the returned ids as surfaced for `conversationId` (default true when a conversation id is given). */
	acknowledge?: boolean | undefined
}

export type MemorySearchResult = {
	query: string
	matches: Array<MemoryMatch>
	suppressedCount: number
	ranking: 'lexical' | 'hybrid'
	warnings: Array<string>
}

export const memoryLimits = {
	subject: 200,
	summary: 500,
	details: 2_000,
	category: 80,
	tag: 80,
	tags: 12,
	sourceUri: 2_048,
	sourceUris: 12,
	dedupeKey: 160,
	searchLimit: 20,
	conversationId: 64,
}

function bounded(value: string, max: number, field: string, required = false) {
	const trimmed = value.trim()
	if (required && !trimmed) throw new KodyError('invalid_args', `"${field}" is required.`)
	if (trimmed.length > max) throw new KodyError('invalid_args', `"${field}" must be at most ${max} characters.`)
	return trimmed
}

export function normalizeMemoryInput(input: MemoryInput) {
	const tags = [
		...new Set((input.tags ?? []).map((tag) => bounded(String(tag), memoryLimits.tag, 'tags[]')).filter(Boolean)),
	]
	if (tags.length > memoryLimits.tags) throw new KodyError('invalid_args', `At most ${memoryLimits.tags} tags.`)
	const sourceUris = [
		...new Set((input.sourceUris ?? []).map((uri) => bounded(String(uri), memoryLimits.sourceUri, 'source_uris[]'))),
	]
	if (sourceUris.length > memoryLimits.sourceUris) {
		throw new KodyError('invalid_args', `At most ${memoryLimits.sourceUris} source_uris.`)
	}
	for (const uri of sourceUris) {
		if (!URL.canParse(uri)) throw new KodyError('invalid_args', `source_uris entry "${uri}" is not a valid URL.`)
	}
	const category = input.category ? bounded(input.category, memoryLimits.category, 'category') : ''
	const dedupeKey = input.dedupeKey ? bounded(input.dedupeKey, memoryLimits.dedupeKey, 'dedupe_key') : ''
	return {
		subject: bounded(input.subject ?? '', memoryLimits.subject, 'subject', true),
		summary: bounded(input.summary ?? '', memoryLimits.summary, 'summary', true),
		details: bounded(input.details ?? '', memoryLimits.details, 'details'),
		category: category || null,
		tags,
		sourceUris,
		dedupeKey: dedupeKey || null,
	}
}

/** The text a memory is embedded and lexically indexed as. */
export function memoryEmbedText(memory: Pick<MemoryRecord, 'subject' | 'summary' | 'details' | 'tags' | 'category'>) {
	return truncateEmbedInput(
		[
			memory.subject,
			memory.summary,
			memory.details,
			memory.tags.length ? `tags: ${memory.tags.join(', ')}` : '',
			memory.category ? `category: ${memory.category}` : '',
		]
			.filter(Boolean)
			.join('\n'),
	)
}

/** Turn a freeform query into an FTS5 expression: OR of quoted prefix tokens. */
export function ftsQuery(query: string) {
	const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].filter((t) => t.length > 1)
	if (tokens.length === 0) return null
	return tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' OR ')
}
