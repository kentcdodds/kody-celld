import { KodyError } from '../lib/errors.ts'
import type { AiConfig, ChatConfig, EmbedConfig } from './config.ts'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export type ChatRequest = {
	system?: string | undefined
	messages: Array<ChatMessage>
	maxTokens?: number | undefined
	/** Ask the provider for a JSON object response where supported. */
	json?: boolean | undefined
}

export type ChatProvider = {
	readonly kind: ChatConfig['provider']
	readonly model: string
	chat(request: ChatRequest): Promise<string>
}

export type EmbeddingProvider = {
	readonly kind: EmbedConfig['provider']
	readonly model: string
	readonly dimensions: number
	embed(texts: Array<string>): Promise<Array<Array<number>>>
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export const embedMaxInputChars = 2_000
export const embedBatchSize = 16

export function truncateEmbedInput(text: string) {
	const compact = text.replaceAll(/\s+/g, ' ').trim()
	return compact.length <= embedMaxInputChars ? compact : compact.slice(0, embedMaxInputChars)
}

function providerError(provider: string, message: string, status = 502) {
	return new KodyError('ai_provider_error', `${provider}: ${message}`, { status })
}

async function postJson(
	fetchImpl: FetchLike,
	url: string,
	headers: Record<string, string>,
	body: unknown,
	timeoutMs: number,
	provider: string,
): Promise<unknown> {
	let response: Response
	try {
		response = await fetchImpl(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw providerError(provider, `request to ${url} failed: ${reason}`)
	}
	const text = await response.text()
	if (!response.ok) {
		throw providerError(provider, `${url} responded ${response.status}: ${text.slice(0, 300)}`)
	}
	try {
		return JSON.parse(text) as unknown
	} catch {
		throw providerError(provider, `${url} returned a non-JSON body.`)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ------------------------------------------------------------ OpenAI-compatible

export function createOpenAiCompatibleChat(
	config: ChatConfig,
	timeoutMs: number,
	fetchImpl: FetchLike = fetch,
): ChatProvider {
	const headers: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}
	return {
		kind: 'openai',
		model: config.model,
		async chat(request) {
			const messages = [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages]
			const payload = await postJson(
				fetchImpl,
				`${config.baseUrl}/chat/completions`,
				headers,
				{
					model: config.model,
					messages,
					temperature: 0,
					max_tokens: request.maxTokens ?? 512,
					...(request.json ? { response_format: { type: 'json_object' } } : {}),
				},
				timeoutMs,
				'openai-compatible chat',
			)
			const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : []
			const first = choices[0]
			const message = isRecord(first) && isRecord(first.message) ? first.message : null
			const content = message?.content
			if (typeof content === 'string') return content
			if (Array.isArray(content)) {
				return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('')
			}
			throw providerError('openai-compatible chat', 'response had no choices[0].message.content.')
		},
	}
}

export function createOpenAiCompatibleEmbeddings(
	config: EmbedConfig,
	timeoutMs: number,
	fetchImpl: FetchLike = fetch,
): EmbeddingProvider {
	const headers: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}
	return {
		kind: 'openai',
		model: config.model,
		dimensions: config.dimensions,
		async embed(texts) {
			if (texts.length === 0) return []
			const out: Array<Array<number>> = []
			for (let start = 0; start < texts.length; start += embedBatchSize) {
				const batch = texts.slice(start, start + embedBatchSize).map(truncateEmbedInput)
				const payload = await postJson(
					fetchImpl,
					`${config.baseUrl}/embeddings`,
					headers,
					{ model: config.model, input: batch },
					timeoutMs,
					'openai-compatible embeddings',
				)
				const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : null
				if (!data || data.length !== batch.length) {
					throw providerError(
						'openai-compatible embeddings',
						`expected ${batch.length} embeddings, got ${data?.length ?? 'none'}.`,
					)
				}
				const ordered = [...data].sort((a, b) => {
					const ai = isRecord(a) && typeof a.index === 'number' ? a.index : 0
					const bi = isRecord(b) && typeof b.index === 'number' ? b.index : 0
					return ai - bi
				})
				for (const item of ordered) {
					const vector = isRecord(item) ? item.embedding : undefined
					if (!Array.isArray(vector) || vector.some((n) => typeof n !== 'number')) {
						throw providerError('openai-compatible embeddings', 'response item had no numeric embedding.')
					}
					if (vector.length !== config.dimensions) {
						throw new KodyError(
							'ai_embedding_dimensions',
							`Model "${config.model}" returned ${vector.length}-dimensional vectors but KODY_AI_EMBED_DIMENSIONS is ${config.dimensions}. Set KODY_AI_EMBED_DIMENSIONS=${vector.length}.`,
							{ status: 500 },
						)
					}
					out.push(vector as Array<number>)
				}
			}
			return out
		},
	}
}

// -------------------------------------------------------------------- Anthropic

export const anthropicVersion = '2023-06-01'

export function createAnthropicChat(config: ChatConfig, timeoutMs: number, fetchImpl: FetchLike = fetch): ChatProvider {
	if (!config.apiKey) {
		throw new Error('KODY_AI_API_KEY is required for KODY_AI_PROVIDER=anthropic.')
	}
	const headers = { 'x-api-key': config.apiKey, 'anthropic-version': anthropicVersion }
	return {
		kind: 'anthropic',
		model: config.model,
		async chat(request) {
			const payload = await postJson(
				fetchImpl,
				`${config.baseUrl}/messages`,
				headers,
				{
					model: config.model,
					max_tokens: request.maxTokens ?? 512,
					temperature: 0,
					...(request.system ? { system: request.system } : {}),
					messages: request.messages,
				},
				timeoutMs,
				'anthropic',
			)
			const content = isRecord(payload) && Array.isArray(payload.content) ? payload.content : []
			const text = content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('')
			if (!text) throw providerError('anthropic', 'response had no text content.')
			return text
		},
	}
}

// ---------------------------------------------------------------------- factory

export type Ai = {
	config: AiConfig
	chat: ChatProvider | null
	embeddings: EmbeddingProvider | null
}

export function createAi(config: AiConfig, fetchImpl: FetchLike = fetch): Ai {
	let chat: ChatProvider | null = null
	if (config.chat?.provider === 'openai') chat = createOpenAiCompatibleChat(config.chat, config.timeoutMs, fetchImpl)
	if (config.chat?.provider === 'anthropic') chat = createAnthropicChat(config.chat, config.timeoutMs, fetchImpl)
	const embeddings = config.embed ? createOpenAiCompatibleEmbeddings(config.embed, config.timeoutMs, fetchImpl) : null
	return { config, chat, embeddings }
}

/** Pull the first JSON object out of a model reply that may be wrapped in prose or code fences. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
	const candidates = [fenced?.[1], text]
	for (const candidate of candidates) {
		if (!candidate) continue
		const start = candidate.indexOf('{')
		const end = candidate.lastIndexOf('}')
		if (start === -1 || end <= start) continue
		try {
			const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown
			if (isRecord(parsed)) return parsed
		} catch {
			// try the next candidate
		}
	}
	return null
}
