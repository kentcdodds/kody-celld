import { memoryLimits, memoryStatuses, type MemoryRecord, type MemoryStatus } from '../cells/memory-cell.ts'
import type { Env } from '../env.ts'
import { recordAudit } from '../lib/audit.ts'
import { defineCapability, defineDomain, type CapabilityContext, type JsonSchema } from './define.ts'

export const verifyFirstGuidance =
	'Always run metaMemoryVerify before upserting or deleting memories. Review the related memories returned by verify, then decide whether to upsert, delete, both, or do nothing. Do not mutate memory blindly.'

export const memoryDomain = defineDomain({
	name: 'memory',
	description:
		'Durable per-user memories the assistant can recall later: verify a candidate against existing memories, upsert, get, search (lexical + semantic when an embedding provider is configured), and delete. Mirrors Kody metaMemory*.',
	guide: verifyFirstGuidance,
})

export function getMemoryCell(env: Env, userId: string) {
	return env.MEMORY.getByName(userId)
}

async function memoryCell(ctx: CapabilityContext) {
	const cell = getMemoryCell(ctx.env, ctx.user.id)
	await cell.init(ctx.user.id)
	return cell
}

const memoryFieldSchemas: Record<string, JsonSchema> = {
	subject: { type: 'string', description: `Short durable subject line (max ${memoryLimits.subject} chars).` },
	summary: { type: 'string', description: `Compact durable summary (max ${memoryLimits.summary} chars).` },
	details: { type: 'string', description: `Optional supporting details (max ${memoryLimits.details} chars).` },
	category: { type: 'string', description: 'Optional freeform category, e.g. "preference", "project", "person".' },
	tags: { type: 'array', items: { type: 'string' }, description: `Up to ${memoryLimits.tags} short tags.` },
	source_uris: { type: 'array', items: { type: 'string' }, description: 'URLs the memory was derived from.' },
	dedupe_key: {
		type: 'string',
		description:
			'Stable key for a fact that should exist once (e.g. "pref:editor"). Upserts with the same key update in place.',
	},
}

const conversationSchemas: Record<string, JsonSchema> = {
	conversation_id: {
		type: 'string',
		description:
			'Opaque chat/thread handle. Memories already surfaced for this handle are suppressed from later searches for a few hours so the same facts are not repeated.',
	},
	include_suppressed_in_conversation: {
		type: 'boolean',
		description: 'Return memories even if already surfaced for conversation_id.',
	},
}

type MemoryArgs = {
	subject: string
	summary: string
	details?: string
	category?: string
	tags?: Array<string>
	source_uris?: Array<string>
	dedupe_key?: string
}

function toInput(args: MemoryArgs) {
	return {
		subject: args.subject,
		summary: args.summary,
		details: args.details,
		category: args.category,
		tags: args.tags,
		sourceUris: args.source_uris,
		dedupeKey: args.dedupe_key,
	}
}

/** MCP-facing shape (snake_case, like production Kody). */
export function toMemoryRecordOutput(memory: MemoryRecord) {
	return {
		id: memory.id,
		category: memory.category,
		status: memory.status,
		subject: memory.subject,
		summary: memory.summary,
		details: memory.details,
		tags: memory.tags,
		source_uris: memory.sourceUris,
		dedupe_key: memory.dedupeKey,
		created_at: memory.createdAt,
		updated_at: memory.updatedAt,
		last_accessed_at: memory.lastAccessedAt,
		deleted_at: memory.deletedAt,
	}
}

export const metaMemoryVerify = defineCapability<
	MemoryArgs & { limit?: number; conversation_id?: string; include_suppressed_in_conversation?: boolean }
>({
	domain: 'memory',
	name: 'metaMemoryVerify',
	description:
		'Check a candidate memory against what is already stored before writing: returns the exact dedupe_key match (if any) and semantically/lexically related memories with scores. Run this first, then upsert, delete, or do nothing.',
	tags: ['memory', 'read', 'verify'],
	keywords: ['memory', 'verify', 'duplicate', 'before saving', 'related memories', 'remember'],
	inputSchema: {
		type: 'object',
		properties: {
			...memoryFieldSchemas,
			limit: { type: 'integer', description: 'Related memories to return (default 5, max 20).' },
			...conversationSchemas,
		},
		required: ['subject', 'summary'],
	},
	readOnly: true,
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  const check = await kody.metaMemoryVerify({ subject: 'Editor preference', summary: 'Prefers Zed over VS Code', dedupe_key: 'pref:editor' })
  return { dedupe: check.dedupe_match?.id ?? null, related: check.related.map((m) => [m.id, m.score, m.subject]) }
}`,
	async handler(args, ctx) {
		const cell = await memoryCell(ctx)
		const result = await cell.memoryVerify({
			candidate: toInput(args),
			limit: args.limit,
			conversationId: args.conversation_id,
			includeSuppressedInConversation: args.include_suppressed_in_conversation,
		})
		return {
			candidate: {
				subject: result.candidate.subject,
				summary: result.candidate.summary,
				details: result.candidate.details,
				category: result.candidate.category,
				tags: result.candidate.tags,
				source_uris: result.candidate.sourceUris,
				dedupe_key: result.candidate.dedupeKey,
			},
			dedupe_match: result.dedupeMatch ? toMemoryRecordOutput(result.dedupeMatch) : null,
			related: result.related.map((match) => ({ ...toMemoryRecordOutput(match), score: match.score })),
			suppressed_count: result.suppressedCount,
			ranking: result.ranking,
			warnings: result.warnings,
			guidance: verifyFirstGuidance,
		}
	},
})

export const metaMemoryUpsert = defineCapability<MemoryArgs & { id?: string; status?: MemoryStatus }>({
	domain: 'memory',
	name: 'metaMemoryUpsert',
	description:
		'Create or update a durable memory. Pass id to update a specific record; otherwise a matching dedupe_key updates in place and anything else creates a new memory. Embeds the record for semantic search when an embedding provider is configured.',
	tags: ['memory', 'write'],
	keywords: ['remember', 'save memory', 'note', 'preference', 'update memory', 'store fact'],
	inputSchema: {
		type: 'object',
		properties: {
			id: { type: 'string', description: 'Existing memory id to update.' },
			...memoryFieldSchemas,
			status: { type: 'string', enum: [...memoryStatuses], description: 'active (default), archived, or deleted.' },
		},
		required: ['subject', 'summary'],
	},
	example: `import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.metaMemoryUpsert({
    subject: 'Editor preference',
    summary: 'Prefers Zed over VS Code',
    category: 'preference',
    tags: ['tools'],
    dedupe_key: 'pref:editor',
  })
}`,
	async handler(args, ctx) {
		const cell = await memoryCell(ctx)
		const result = await cell.memoryUpsert({ ...toInput(args), id: args.id, status: args.status })
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: `memory.${result.mode === 'created' ? 'create' : 'update'}`,
			target: result.memory.id,
			details: { category: result.memory.category, status: result.memory.status, viaPackage: ctx.packageName },
		})
		return {
			mode: result.mode,
			memory: toMemoryRecordOutput(result.memory),
			warnings: result.warnings,
			guidance: verifyFirstGuidance,
		}
	},
})

export const metaMemoryGet = defineCapability<{ id: string }>({
	domain: 'memory',
	name: 'metaMemoryGet',
	description: 'Fetch one memory by id (also bumps last_accessed_at).',
	tags: ['memory', 'read'],
	keywords: ['memory', 'get', 'read memory', 'recall by id'],
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	readOnly: true,
	async handler(args, ctx) {
		const cell = await memoryCell(ctx)
		const memory = await cell.memoryGet({ id: args.id })
		return { memory: memory ? toMemoryRecordOutput(memory) : null }
	},
})

export const metaMemorySearch = defineCapability<{
	query: string
	limit?: number
	category?: string
	include_deleted?: boolean
	include_archived?: boolean
	conversation_id?: string
	include_suppressed_in_conversation?: boolean
}>({
	domain: 'memory',
	name: 'metaMemorySearch',
	description:
		"Search the signed-in user's memories. Uses FTS5 lexical matching fused (reciprocal rank) with embedding similarity when an embedding provider is configured; falls back to lexical-only otherwise. Prefer metaMemoryVerify before writing or deleting.",
	tags: ['memory', 'read', 'search'],
	keywords: ['memory', 'recall', 'search memories', 'what do you know about', 'related', 'lookup'],
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Freeform query.' },
			limit: { type: 'integer', description: 'Max matches (default 5, max 20).' },
			category: { type: 'string', description: 'Restrict to one category.' },
			include_deleted: { type: 'boolean', description: 'Also match soft-deleted memories.' },
			include_archived: { type: 'boolean', description: 'Also match archived memories.' },
			...conversationSchemas,
		},
		required: ['query'],
	},
	readOnly: true,
	example: `import { kody } from 'kody:runtime'
export default async function main({ query }) {
  const result = await kody.metaMemorySearch({ query, limit: 5 })
  return result.matches.map((m) => ({ id: m.id, score: m.score, subject: m.subject, summary: m.summary }))
}`,
	async handler(args, ctx) {
		const cell = await memoryCell(ctx)
		const statuses: Array<MemoryStatus> = ['active']
		if (args.include_archived) statuses.push('archived')
		if (args.include_deleted) statuses.push('deleted')
		const result = await cell.memorySearch({
			query: args.query,
			limit: args.limit,
			category: args.category,
			statuses,
			conversationId: args.conversation_id,
			includeSuppressedInConversation: args.include_suppressed_in_conversation,
		})
		return {
			query: result.query,
			matches: result.matches.map((match) => ({
				...toMemoryRecordOutput(match),
				score: match.score,
				lexical_rank: match.lexicalRank,
				vector_rank: match.vectorRank,
				can_mutate: true,
			})),
			suppressed_count: result.suppressedCount,
			ranking: result.ranking,
			warnings: result.warnings,
			guidance: verifyFirstGuidance,
		}
	},
})

export const metaMemoryDelete = defineCapability<{ id: string; force?: boolean }>({
	domain: 'memory',
	name: 'metaMemoryDelete',
	description:
		'Delete a memory. Soft-deletes by default (status becomes deleted, recoverable by upserting with status active); force=true removes the record and its vector permanently.',
	tags: ['memory', 'write', 'delete'],
	keywords: ['forget', 'delete memory', 'remove memory', 'purge'],
	inputSchema: {
		type: 'object',
		properties: {
			id: { type: 'string' },
			force: { type: 'boolean', description: 'Permanently delete instead of soft-deleting.' },
		},
		required: ['id'],
	},
	async handler(args, ctx) {
		const cell = await memoryCell(ctx)
		const result = await cell.memoryDelete({ id: args.id, force: args.force })
		await recordAudit(ctx.env, {
			actor: `user:${ctx.user.id}`,
			action: `memory.delete.${result.mode}`,
			target: result.id,
			details: { viaPackage: ctx.packageName },
		})
		return {
			id: result.id,
			mode: result.mode,
			memory: result.memory ? toMemoryRecordOutput(result.memory) : null,
			guidance: `${verifyFirstGuidance} Use soft delete by default; reserve force=true for records that should be removed permanently.`,
		}
	},
})

export const memoryCapabilities = [
	metaMemoryVerify,
	metaMemoryUpsert,
	metaMemoryGet,
	metaMemorySearch,
	metaMemoryDelete,
]
