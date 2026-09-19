import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cosineSimilarity, float32Bytes, reciprocalRankFusion, vectorFromBytes } from './ranking.ts'
import { llmRerank } from './rerank.ts'
import { localChunkSize } from './vector-store.ts'

describe('ranking', () => {
	it('computes cosine similarity', () => {
		assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
		assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
		assert.equal(cosineSimilarity([1, 0], [1]), 0)
		assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9)
	})

	it('fuses rankings so items present in both lists win', () => {
		const fused = reciprocalRankFusion([
			['a', 'b', 'c'],
			['c', 'a', 'd'],
		])
		const order = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
		assert.deepEqual(order.slice(0, 2).sort(), ['a', 'c'])
		assert.ok(fused.get('a')! > fused.get('b')!)
		assert.ok(fused.get('d')! < fused.get('b')!)
	})

	it('round-trips float32 blobs', () => {
		const vector = [0.5, -1.25, 3]
		assert.deepEqual(vectorFromBytes(float32Bytes(vector)), vector)
	})
})

describe('llmRerank', () => {
	const candidates = [
		{ id: 'a', title: 'A', summary: 'first' },
		{ id: 'b', title: 'B', summary: 'second' },
		{ id: 'c', title: 'C', summary: 'third' },
	]
	const chatWith = (reply: string | Error) => ({
		kind: 'openai' as const,
		model: 'm',
		async chat() {
			if (reply instanceof Error) throw reply
			return reply
		},
	})

	it('reorders by the model output and appends anything it forgot', async () => {
		assert.deepEqual(await llmRerank(chatWith('{"order":["c","zzz","a"]}'), 'q', candidates), ['c', 'a', 'b'])
	})

	it('falls back to null on garbage or failure', async () => {
		assert.equal(await llmRerank(chatWith('I cannot do that'), 'q', candidates), null)
		assert.equal(await llmRerank(chatWith(new Error('boom')), 'q', candidates), null)
	})

	it('skips the model for a single candidate', async () => {
		assert.deepEqual(await llmRerank(chatWith(new Error('never called')), 'q', candidates.slice(0, 1)), ['a'])
	})
})

describe('localChunkSize', () => {
	it('keeps a vec0 chunk blob under the Durable Object value cap', () => {
		assert.equal(localChunkSize(64), 1024)
		assert.equal(localChunkSize(768), 336)
		assert.equal(localChunkSize(1536), 168)
		assert.equal(localChunkSize(8192), 32)
		for (const dims of [64, 768, 1536, 3072, 8192]) {
			const size = localChunkSize(dims)
			assert.equal(size % 8, 0)
			assert.ok(size * dims * 4 <= 1_048_576)
		}
	})
})
