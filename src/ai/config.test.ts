import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { aiConfigFromEnv, defaultAiTimeoutMs, defaultEmbedDimensions, describeAiConfig } from './config.ts'

describe('aiConfigFromEnv', () => {
	it('is fully off by default', () => {
		const config = aiConfigFromEnv({})
		assert.equal(config.chat, null)
		assert.equal(config.embed, null)
		assert.deepEqual(config.vectors, { provider: 'local' })
		assert.equal(config.rerank, 'off')
		assert.equal(config.timeoutMs, defaultAiTimeoutMs)
	})

	it('configures OpenAI-compatible chat + embeddings from one key', () => {
		const config = aiConfigFromEnv({ KODY_AI_PROVIDER: 'openai', KODY_AI_API_KEY: 'k' })
		assert.equal(config.chat?.provider, 'openai')
		assert.equal(config.chat?.baseUrl, 'https://api.openai.com/v1')
		assert.equal(config.embed?.provider, 'openai')
		assert.equal(config.embed?.apiKey, 'k')
		assert.equal(config.embed?.dimensions, defaultEmbedDimensions)
	})

	it('points at a local OpenAI-compatible server (Ollama) without a key', () => {
		const config = aiConfigFromEnv({
			KODY_AI_PROVIDER: 'openai',
			KODY_AI_BASE_URL: 'http://ollama:11434/v1/',
			KODY_AI_CHAT_MODEL: 'llama3.2',
			KODY_AI_EMBED_MODEL: 'nomic-embed-text',
			KODY_AI_EMBED_DIMENSIONS: '768',
		})
		assert.equal(config.chat?.baseUrl, 'http://ollama:11434/v1')
		assert.equal(config.chat?.apiKey, null)
		assert.equal(config.chat?.model, 'llama3.2')
		assert.equal(config.embed?.baseUrl, 'http://ollama:11434/v1')
		assert.equal(config.embed?.model, 'nomic-embed-text')
		assert.equal(config.embed?.dimensions, 768)
	})

	it('supports Anthropic chat with a separate embedding endpoint', () => {
		const config = aiConfigFromEnv({
			KODY_AI_PROVIDER: 'anthropic',
			KODY_AI_API_KEY: 'a',
			KODY_AI_EMBED_PROVIDER: 'openai',
			KODY_AI_EMBED_BASE_URL: 'http://embed:8080/v1',
			KODY_AI_EMBED_MODEL: 'bge-small',
			KODY_AI_EMBED_DIMENSIONS: '384',
		})
		assert.equal(config.chat?.provider, 'anthropic')
		assert.equal(config.chat?.baseUrl, 'https://api.anthropic.com/v1')
		assert.equal(config.embed?.baseUrl, 'http://embed:8080/v1')
		assert.equal(config.embed?.apiKey, null)
		assert.equal(config.embed?.dimensions, 384)
	})

	it('does not enable embeddings by default for anthropic', () => {
		assert.equal(aiConfigFromEnv({ KODY_AI_PROVIDER: 'anthropic', KODY_AI_API_KEY: 'a' }).embed, null)
	})

	it('configures qdrant and llm re-ranking', () => {
		const config = aiConfigFromEnv({
			KODY_AI_PROVIDER: 'openai',
			KODY_VECTOR_PROVIDER: 'qdrant',
			KODY_QDRANT_URL: 'http://qdrant:6333',
			KODY_SEARCH_RERANK: 'llm',
		})
		assert.deepEqual(config.vectors, {
			provider: 'qdrant',
			url: 'http://qdrant:6333',
			apiKey: null,
			collection: 'kody-memories',
		})
		assert.equal(config.rerank, 'llm')
	})

	it('rejects invalid combinations', () => {
		assert.throws(() => aiConfigFromEnv({ KODY_AI_PROVIDER: 'gemini' }), /KODY_AI_PROVIDER/)
		assert.throws(() => aiConfigFromEnv({ KODY_VECTOR_PROVIDER: 'qdrant' }), /KODY_QDRANT_URL/)
		assert.throws(() => aiConfigFromEnv({ KODY_SEARCH_RERANK: 'llm' }), /KODY_SEARCH_RERANK/)
		assert.throws(() => aiConfigFromEnv({ KODY_AI_PROVIDER: 'openai', KODY_AI_BASE_URL: 'ftp://x' }), /http/)
		assert.throws(
			() => aiConfigFromEnv({ KODY_AI_PROVIDER: 'openai', KODY_AI_EMBED_DIMENSIONS: '0' }),
			/KODY_AI_EMBED_DIMENSIONS/,
		)
		assert.throws(() => aiConfigFromEnv({ KODY_AI_TIMEOUT_MS: 'soon' }), /KODY_AI_TIMEOUT_MS/)
	})

	it('describes config without leaking keys', () => {
		const described = describeAiConfig(
			aiConfigFromEnv({
				KODY_AI_PROVIDER: 'openai',
				KODY_AI_API_KEY: 'sk-super-secret',
				KODY_VECTOR_PROVIDER: 'qdrant',
				KODY_QDRANT_URL: 'http://qdrant:6333',
				KODY_QDRANT_API_KEY: 'qd-secret',
			}),
		)
		const text = JSON.stringify(described)
		assert.ok(!text.includes('sk-super-secret'))
		assert.ok(!text.includes('qd-secret'))
		assert.ok(text.includes('"hasApiKey":true'))
	})
})
