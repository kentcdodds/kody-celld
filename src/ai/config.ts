/**
 * Operator-level AI configuration. These are deployment settings (like the
 * master key), not user secrets: they come from `.dev.vars` / `.env` / fleet
 * vars and are read by the worker itself, never by sandboxed package code.
 */

export type ChatProviderKind = 'openai' | 'anthropic'
export type EmbedProviderKind = 'openai'
export type VectorProviderKind = 'local' | 'qdrant'
export type RerankMode = 'off' | 'llm'

export type AiEnv = {
	KODY_AI_PROVIDER?: string
	KODY_AI_BASE_URL?: string
	KODY_AI_API_KEY?: string
	KODY_AI_CHAT_MODEL?: string
	KODY_AI_EMBED_PROVIDER?: string
	KODY_AI_EMBED_BASE_URL?: string
	KODY_AI_EMBED_API_KEY?: string
	KODY_AI_EMBED_MODEL?: string
	KODY_AI_EMBED_DIMENSIONS?: string
	KODY_AI_TIMEOUT_MS?: string
	KODY_SEARCH_RERANK?: string
	KODY_VECTOR_PROVIDER?: string
	KODY_QDRANT_URL?: string
	KODY_QDRANT_API_KEY?: string
	KODY_QDRANT_COLLECTION?: string
}

export type ChatConfig = {
	provider: ChatProviderKind
	baseUrl: string
	apiKey: string | null
	model: string
}

export type EmbedConfig = {
	provider: EmbedProviderKind
	baseUrl: string
	apiKey: string | null
	model: string
	/** Declared vector size; verified against the first response. */
	dimensions: number
}

export type VectorConfig =
	{ provider: 'local' } | { provider: 'qdrant'; url: string; apiKey: string | null; collection: string }

export type AiConfig = {
	chat: ChatConfig | null
	embed: EmbedConfig | null
	vectors: VectorConfig
	rerank: RerankMode
	timeoutMs: number
}

export const defaultBaseUrls: Record<ChatProviderKind, string> = {
	openai: 'https://api.openai.com/v1',
	anthropic: 'https://api.anthropic.com/v1',
}

export const defaultChatModels: Record<ChatProviderKind, string> = {
	openai: 'gpt-4o-mini',
	anthropic: 'claude-3-5-haiku-latest',
}

export const defaultEmbedModel = 'text-embedding-3-small'
export const defaultEmbedDimensions = 1536
export const defaultAiTimeoutMs = 20_000
export const defaultQdrantCollection = 'kody-memories'

function trimmed(value: string | undefined) {
	const v = value?.trim()
	return v ? v : undefined
}

function oneOf<T extends string>(name: string, raw: string | undefined, allowed: ReadonlyArray<T>, fallback: T): T {
	const value = trimmed(raw)?.toLowerCase()
	if (value === undefined) return fallback
	if ((allowed as ReadonlyArray<string>).includes(value)) return value as T
	throw new Error(`${name}: expected one of ${allowed.join(', ')}, got "${raw}".`)
}

function positiveInt(name: string, raw: string | undefined, fallback: number, max: number) {
	const value = trimmed(raw)
	if (value === undefined) return fallback
	if (!/^\d+$/.test(value)) throw new Error(`${name}: expected a positive integer, got "${raw}".`)
	const n = Number(value)
	if (n < 1 || n > max) throw new Error(`${name}: must be between 1 and ${max}.`)
	return n
}

function stripTrailingSlash(url: string) {
	return url.replace(/\/+$/, '')
}

function httpUrl(name: string, raw: string) {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		throw new Error(`${name}: "${raw}" is not a valid URL.`)
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`${name}: only http(s) URLs are supported.`)
	}
	return stripTrailingSlash(parsed.toString())
}

export function aiConfigFromEnv(env: AiEnv): AiConfig {
	const chatProvider = oneOf('KODY_AI_PROVIDER', env.KODY_AI_PROVIDER, ['none', 'openai', 'anthropic'] as const, 'none')
	const chatApiKey = trimmed(env.KODY_AI_API_KEY) ?? null
	const chat: ChatConfig | null =
		chatProvider === 'none'
			? null
			: {
					provider: chatProvider,
					baseUrl: httpUrl('KODY_AI_BASE_URL', trimmed(env.KODY_AI_BASE_URL) ?? defaultBaseUrls[chatProvider]),
					apiKey: chatApiKey,
					model: trimmed(env.KODY_AI_CHAT_MODEL) ?? defaultChatModels[chatProvider],
				}

	// Embeddings default to the chat provider's endpoint when that endpoint is
	// OpenAI-compatible (Ollama, LM Studio, OpenRouter, vLLM, OpenAI itself).
	// Anthropic has no embeddings API, so it needs an explicit embed provider.
	const embedFallback = chatProvider === 'openai' ? 'openai' : 'none'
	const embedProvider = oneOf(
		'KODY_AI_EMBED_PROVIDER',
		env.KODY_AI_EMBED_PROVIDER,
		['none', 'openai'] as const,
		embedFallback,
	)
	const embed: EmbedConfig | null =
		embedProvider === 'none'
			? null
			: {
					provider: embedProvider,
					baseUrl: httpUrl(
						'KODY_AI_EMBED_BASE_URL',
						trimmed(env.KODY_AI_EMBED_BASE_URL) ??
							(chat?.provider === 'openai' ? chat.baseUrl : defaultBaseUrls.openai),
					),
					apiKey: trimmed(env.KODY_AI_EMBED_API_KEY) ?? (chat?.provider === 'openai' ? chatApiKey : null),
					model: trimmed(env.KODY_AI_EMBED_MODEL) ?? defaultEmbedModel,
					dimensions: positiveInt(
						'KODY_AI_EMBED_DIMENSIONS',
						env.KODY_AI_EMBED_DIMENSIONS,
						defaultEmbedDimensions,
						8192,
					),
				}

	const vectorProvider = oneOf('KODY_VECTOR_PROVIDER', env.KODY_VECTOR_PROVIDER, ['local', 'qdrant'] as const, 'local')
	let vectors: VectorConfig = { provider: 'local' }
	if (vectorProvider === 'qdrant') {
		const url = trimmed(env.KODY_QDRANT_URL)
		if (!url) throw new Error('KODY_QDRANT_URL is required when KODY_VECTOR_PROVIDER=qdrant.')
		vectors = {
			provider: 'qdrant',
			url: httpUrl('KODY_QDRANT_URL', url),
			apiKey: trimmed(env.KODY_QDRANT_API_KEY) ?? null,
			collection: trimmed(env.KODY_QDRANT_COLLECTION) ?? defaultQdrantCollection,
		}
	}

	const rerank = oneOf('KODY_SEARCH_RERANK', env.KODY_SEARCH_RERANK, ['off', 'llm'] as const, 'off')
	if (rerank === 'llm' && !chat) {
		throw new Error('KODY_SEARCH_RERANK=llm requires KODY_AI_PROVIDER (openai or anthropic).')
	}

	return {
		chat,
		embed,
		vectors,
		rerank,
		timeoutMs: positiveInt('KODY_AI_TIMEOUT_MS', env.KODY_AI_TIMEOUT_MS, defaultAiTimeoutMs, 300_000),
	}
}

/** Safe-to-display view: never includes API keys. */
export function describeAiConfig(config: AiConfig) {
	return {
		chat: config.chat
			? {
					provider: config.chat.provider,
					baseUrl: config.chat.baseUrl,
					model: config.chat.model,
					hasApiKey: !!config.chat.apiKey,
				}
			: null,
		embed: config.embed
			? {
					provider: config.embed.provider,
					baseUrl: config.embed.baseUrl,
					model: config.embed.model,
					dimensions: config.embed.dimensions,
					hasApiKey: !!config.embed.apiKey,
				}
			: null,
		vectors:
			config.vectors.provider === 'qdrant'
				? {
						provider: 'qdrant' as const,
						url: config.vectors.url,
						collection: config.vectors.collection,
						hasApiKey: !!config.vectors.apiKey,
					}
				: { provider: 'local' as const },
		rerank: config.rerank,
		timeoutMs: config.timeoutMs,
	}
}
