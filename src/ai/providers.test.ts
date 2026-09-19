import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KodyError } from '../lib/errors.ts'
import { aiConfigFromEnv } from './config.ts'
import { anthropicVersion, createAi, extractJsonObject, type FetchLike } from './providers.ts'

type Call = { url: string; init: RequestInit }

function fakeFetch(respond: (call: Call) => unknown, status = 200) {
	const calls: Array<Call> = []
	const fetchImpl: FetchLike = async (url, init) => {
		const call = { url, init }
		calls.push(call)
		const body = respond(call)
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
	}
	return { calls, fetchImpl }
}

function bodyOf(call: Call) {
	return JSON.parse(String(call.init.body)) as Record<string, unknown>
}

describe('openai-compatible provider', () => {
	it('sends bearer auth, system prompt and json mode to /chat/completions', async () => {
		const { calls, fetchImpl } = fakeFetch(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }))
		const ai = createAi(
			aiConfigFromEnv({ KODY_AI_PROVIDER: 'openai', KODY_AI_API_KEY: 'k', KODY_AI_CHAT_MODEL: 'm' }),
			fetchImpl,
		)
		const text = await ai.chat!.chat({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], json: true })
		assert.equal(text, '{"ok":true}')
		assert.equal(calls[0]!.url, 'https://api.openai.com/v1/chat/completions')
		assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer k')
		const body = bodyOf(calls[0]!)
		assert.equal(body.model, 'm')
		assert.deepEqual(body.messages, [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'hi' },
		])
		assert.deepEqual(body.response_format, { type: 'json_object' })
	})

	it('omits the authorization header when no key is configured (local servers)', async () => {
		const { calls, fetchImpl } = fakeFetch(() => ({ choices: [{ message: { content: 'x' } }] }))
		const ai = createAi(
			aiConfigFromEnv({ KODY_AI_PROVIDER: 'openai', KODY_AI_BASE_URL: 'http://ollama:11434/v1' }),
			fetchImpl,
		)
		await ai.chat!.chat({ messages: [{ role: 'user', content: 'hi' }] })
		assert.equal(new Headers(calls[0]!.init.headers).has('authorization'), false)
		assert.equal(calls[0]!.url, 'http://ollama:11434/v1/chat/completions')
	})

	it('batches embeddings, keeps input order, and validates dimensions', async () => {
		const { calls, fetchImpl } = fakeFetch((call) => {
			const input = bodyOf(call).input as Array<string>
			return { data: input.map((_, index) => ({ index, embedding: [index, 1, 2] })).reverse() }
		})
		const ai = createAi(aiConfigFromEnv({ KODY_AI_PROVIDER: 'openai', KODY_AI_EMBED_DIMENSIONS: '3' }), fetchImpl)
		const texts = Array.from({ length: 20 }, (_, i) => `t${i}`)
		const vectors = await ai.embeddings!.embed(texts)
		assert.equal(calls.length, 2)
		assert.equal(vectors.length, 20)
		assert.deepEqual(vectors[0], [0, 1, 2])
		assert.deepEqual(vectors[17], [1, 1, 2])
	})

	it('reports a dimension mismatch as a configuration error', async () => {
		const { fetchImpl } = fakeFetch(() => ({ data: [{ index: 0, embedding: [1, 2] }] }))
		const ai = createAi(aiConfigFromEnv({ KODY_AI_PROVIDER: 'openai', KODY_AI_EMBED_DIMENSIONS: '3' }), fetchImpl)
		await assert.rejects(ai.embeddings!.embed(['a']), (error: unknown) => {
			assert.ok(error instanceof KodyError)
			assert.equal(error.code, 'ai_embedding_dimensions')
			assert.match(error.message, /KODY_AI_EMBED_DIMENSIONS=2/)
			return true
		})
	})

	it('wraps HTTP failures as ai_provider_error without the key', async () => {
		const { fetchImpl } = fakeFetch(() => ({ error: 'nope' }), 401)
		const ai = createAi(aiConfigFromEnv({ KODY_AI_PROVIDER: 'openai', KODY_AI_API_KEY: 'sk-secret' }), fetchImpl)
		await assert.rejects(ai.chat!.chat({ messages: [{ role: 'user', content: 'hi' }] }), (error: unknown) => {
			assert.ok(error instanceof KodyError)
			assert.equal(error.code, 'ai_provider_error')
			assert.equal(error.status, 502)
			assert.ok(!error.message.includes('sk-secret'))
			return true
		})
	})
})

describe('anthropic provider', () => {
	it('uses x-api-key + version headers and joins text blocks', async () => {
		const { calls, fetchImpl } = fakeFetch(() => ({
			content: [
				{ type: 'text', text: 'Hel' },
				{ type: 'text', text: 'lo' },
			],
		}))
		const ai = createAi(aiConfigFromEnv({ KODY_AI_PROVIDER: 'anthropic', KODY_AI_API_KEY: 'a' }), fetchImpl)
		const text = await ai.chat!.chat({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 9 })
		assert.equal(text, 'Hello')
		assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages')
		const headers = new Headers(calls[0]!.init.headers)
		assert.equal(headers.get('x-api-key'), 'a')
		assert.equal(headers.get('anthropic-version'), anthropicVersion)
		const body = bodyOf(calls[0]!)
		assert.equal(body.system, 'sys')
		assert.equal(body.max_tokens, 9)
		assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
	})

	it('requires an api key', () => {
		assert.throws(() => createAi(aiConfigFromEnv({ KODY_AI_PROVIDER: 'anthropic' })), /KODY_AI_API_KEY/)
	})
})

describe('extractJsonObject', () => {
	it('finds objects in fences and prose', () => {
		assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
		assert.deepEqual(extractJsonObject('Sure! {"order": ["x"]} hope that helps'), { order: ['x'] })
		assert.equal(extractJsonObject('no json here'), null)
	})
})
