#!/usr/bin/env node
// A tiny OpenAI-compatible server (embeddings + chat completions) for smoke runs
// that must not depend on external AI credentials. Deterministic on purpose:
//
//   * POST /v1/embeddings       hashing-trick bag-of-words vectors (64 dims by
//                               default) with a small synonym table so that
//                               "automobile" lands near "car" while FTS5 does not.
//   * POST /v1/chat/completions echoes the last user message (JSON mode returns
//                               {"echo": ...}); re-rank prompts get their
//                               candidate ids back in alphabetical order.
//
//   node smoke/ai-mock-server.mjs            # listens on 127.0.0.1:8790
//   SMOKE_AI_PORT=9000 SMOKE_AI_DIMENSIONS=64 node smoke/ai-mock-server.mjs
//
// Point kody-celld at it with (see README "AI, memories and semantic search"):
//   KODY_AI_PROVIDER=openai KODY_AI_BASE_URL=http://127.0.0.1:8790/v1
//   KODY_AI_EMBED_DIMENSIONS=64 KODY_SEARCH_RERANK=llm
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.SMOKE_AI_PORT ?? 8790)
const dimensions = Number(process.env.SMOKE_AI_DIMENSIONS ?? 64)
const expectedKey = process.env.SMOKE_AI_API_KEY ?? null

const synonyms = new Map([
	['automobile', 'car'],
	['vehicle', 'car'],
	['feline', 'cat'],
	['kitty', 'cat'],
	['editor', 'ide'],
])

function tokens(text) {
	return String(text)
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map((token) => synonyms.get(token) ?? token)
}

export function embed(text) {
	const vector = new Array(dimensions).fill(0)
	for (const token of tokens(text)) {
		const digest = createHash('sha256').update(token).digest()
		const index = digest.readUInt32BE(0) % dimensions
		const sign = digest[4] & 1 ? 1 : -1
		vector[index] += sign
	}
	const norm = Math.hypot(...vector) || 1
	return vector.map((value) => value / norm)
}

function readJson(request) {
	return new Promise((resolve, reject) => {
		let body = ''
		request.on('data', (chunk) => (body += chunk))
		request.on('end', () => {
			try {
				resolve(body ? JSON.parse(body) : {})
			} catch (error) {
				reject(error)
			}
		})
		request.on('error', reject)
	})
}

function send(response, status, payload) {
	response.writeHead(status, { 'content-type': 'application/json' })
	response.end(JSON.stringify(payload))
}

function chatReply(body) {
	const messages = Array.isArray(body.messages) ? body.messages : []
	const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
	const wantsJson = body.response_format?.type === 'json_object'
	const ids = [...lastUser.matchAll(/^\d+\. id="([^"]+)"/gm)].map((match) => match[1])
	if (/^Query: /.test(lastUser) && ids.length > 0) return JSON.stringify({ order: [...new Set(ids)].sort() })
	if (wantsJson) return JSON.stringify({ echo: lastUser })
	return `MOCK: ${lastUser}`
}

const server = createServer(async (request, response) => {
	try {
		if (expectedKey && request.headers.authorization !== `Bearer ${expectedKey}`) {
			return send(response, 401, { error: { message: 'bad api key' } })
		}
		const url = new URL(request.url ?? '/', 'http://localhost')
		if (request.method !== 'POST') return send(response, 404, { error: { message: 'not found' } })
		const body = await readJson(request)
		if (url.pathname.endsWith('/embeddings')) {
			const input = Array.isArray(body.input) ? body.input : [body.input]
			return send(response, 200, {
				object: 'list',
				model: body.model ?? 'mock-embed',
				data: input.map((text, index) => ({ object: 'embedding', index, embedding: embed(text) })),
			})
		}
		if (url.pathname.endsWith('/chat/completions')) {
			return send(response, 200, {
				id: 'mock',
				object: 'chat.completion',
				model: body.model ?? 'mock-chat',
				choices: [{ index: 0, message: { role: 'assistant', content: chatReply(body) }, finish_reason: 'stop' }],
			})
		}
		send(response, 404, { error: { message: `no route for ${url.pathname}` } })
	} catch (error) {
		send(response, 500, { error: { message: String(error) } })
	}
})

server.listen(port, '127.0.0.1', () => {
	console.log(`mock OpenAI-compatible AI server on http://127.0.0.1:${port}/v1 (${dimensions} dims)`)
})
