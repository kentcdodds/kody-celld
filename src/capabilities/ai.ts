import { aiConfigFromEnv } from '../ai/config.ts'
import { createAi, extractJsonObject, type ChatMessage } from '../ai/providers.ts'
import { KodyError } from '../lib/errors.ts'
import { defineCapability, defineDomain } from './define.ts'
import { getMemoryCell } from './memory.ts'

export const aiDomain = defineDomain({
	name: 'ai',
	description:
		'Operator-configured language model access: chat completions and embeddings through any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, OpenRouter, OpenAI) or Anthropic. The API key lives in the deployment, never in packages or MCP output.',
})

export const aiStatus = defineCapability<Record<string, never>>({
	domain: 'ai',
	name: 'aiStatus',
	description:
		'Describe the configured AI providers (chat/embeddings/vector store/re-ranking): provider, model, endpoint, dimensions and whether an API key is set. Never returns key material.',
	tags: ['ai', 'read', 'system'],
	keywords: ['ai', 'llm', 'model', 'embeddings', 'ollama', 'openai', 'anthropic', 'qdrant', 'is ai configured'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		const cell = getMemoryCell(ctx.env, ctx.user.id)
		await cell.init(ctx.user.id)
		return cell.aiStatus()
	},
})

export const aiChat = defineCapability<{
	prompt?: string
	messages?: Array<ChatMessage>
	system?: string
	max_tokens?: number
	json?: boolean
}>({
	domain: 'ai',
	name: 'aiChat',
	description:
		'Run a chat completion on the operator-configured model. Pass prompt (single user turn) or messages; set json=true to request a JSON object and get it parsed back. Errors with ai_not_configured when no chat provider is set.',
	tags: ['ai', 'llm', 'chat'],
	keywords: ['llm', 'chat completion', 'summarize', 'classify', 'generate text', 'ask the model', 'workers ai'],
	inputSchema: {
		type: 'object',
		properties: {
			prompt: { type: 'string', description: 'Single user message (alternative to messages).' },
			messages: { type: 'array', items: { type: 'object' }, description: '[{ role: "user" | "assistant", content }]' },
			system: { type: 'string', description: 'System instructions.' },
			max_tokens: { type: 'integer', description: 'Completion cap (default 512, max 4096).' },
			json: { type: 'boolean', description: 'Ask for a JSON object; the parsed object is returned as `json`.' },
		},
	},
	readOnly: true,
	example: `import { kody } from 'kody:runtime'
export default async function main({ text }) {
  const result = await kody.aiChat({
    system: 'Reply with JSON: { "sentiment": "positive" | "neutral" | "negative" }',
    prompt: text,
    json: true,
  })
  return result.json ?? result.text
}`,
	async handler(args, ctx) {
		const ai = createAi(aiConfigFromEnv(ctx.env))
		if (!ai.chat) {
			throw new KodyError(
				'ai_not_configured',
				'No chat provider configured. Set KODY_AI_PROVIDER (openai | anthropic) on the server.',
				{
					status: 503,
				},
			)
		}
		const messages: Array<ChatMessage> = []
		for (const message of args.messages ?? []) {
			if (
				typeof message !== 'object' ||
				message === null ||
				(message.role !== 'user' && message.role !== 'assistant') ||
				typeof message.content !== 'string'
			) {
				throw new KodyError(
					'invalid_args',
					'aiChat.messages entries must be { role: "user" | "assistant", content: string }.',
				)
			}
			messages.push({ role: message.role, content: message.content })
		}
		if (args.prompt) messages.push({ role: 'user', content: args.prompt })
		if (messages.length === 0) throw new KodyError('invalid_args', 'aiChat requires prompt or messages.')
		const maxTokens = Math.min(Math.max(args.max_tokens ?? 512, 1), 4096)
		const text = await ai.chat.chat({ system: args.system, messages, maxTokens, json: args.json })
		return {
			provider: ai.chat.kind,
			model: ai.chat.model,
			text,
			...(args.json ? { json: extractJsonObject(text) } : {}),
		}
	},
})

export const aiEmbed = defineCapability<{ texts: Array<string> }>({
	domain: 'ai',
	name: 'aiEmbed',
	description:
		'Embed up to 32 texts with the configured embedding model (cached per user by content hash). Errors with ai_not_configured when no embedding provider is set.',
	tags: ['ai', 'embeddings'],
	keywords: ['embedding', 'vector', 'similarity', 'semantic'],
	inputSchema: {
		type: 'object',
		properties: { texts: { type: 'array', items: { type: 'string' } } },
		required: ['texts'],
	},
	readOnly: true,
	async handler(args, ctx) {
		if (args.texts.length === 0 || args.texts.length > 32 || args.texts.some((t) => typeof t !== 'string')) {
			throw new KodyError('invalid_args', 'aiEmbed.texts must contain 1-32 strings.')
		}
		const cell = getMemoryCell(ctx.env, ctx.user.id)
		await cell.init(ctx.user.id)
		const vectors = await cell.embedCached(args.texts)
		if (!vectors) {
			throw new KodyError(
				'ai_not_configured',
				'No embedding provider configured. Set KODY_AI_EMBED_PROVIDER=openai and a model.',
				{
					status: 503,
				},
			)
		}
		const config = aiConfigFromEnv(ctx.env)
		return { model: config.embed?.model ?? null, dimensions: vectors[0]?.length ?? 0, vectors }
	},
})

export const aiCapabilities = [aiStatus, aiChat, aiEmbed]
