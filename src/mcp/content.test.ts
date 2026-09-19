import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractMcpContent, mcpContentKey, summarizeMcpContent } from './content.ts'

const png = 'iVBORw0KGgo='

describe('mcp content', () => {
	it('ignores ordinary results', () => {
		assert.equal(extractMcpContent({ ok: true }, 1000), null)
		assert.equal(extractMcpContent('text', 1000), null)
		assert.equal(extractMcpContent([{ [mcpContentKey]: [] }], 1000), null)
	})

	it('validates and splits content blocks from the rest of the result', () => {
		const extracted = extractMcpContent(
			{
				[mcpContentKey]: [
					{ type: 'image', data: png, mimeType: 'image/png', extra: 'dropped' },
					{ type: 'text', text: 'caption' },
					{ type: 'resource', resource: { uri: 'kody://blob/a.txt', text: 'hi', mimeType: 'text/plain' } },
					{ type: 'resource_link', uri: 'https://example.com/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' },
				],
				runId: 'r1',
			},
			10_000,
		)
		assert.ok(extracted)
		assert.deepEqual(extracted.rest, { runId: 'r1' })
		assert.deepEqual(extracted.blocks[0], { type: 'image', data: png, mimeType: 'image/png' })
		assert.equal(extracted.blocks.length, 4)
		assert.equal(extractMcpContent({ [mcpContentKey]: [{ type: 'text', text: 'only' }] }, 1000)?.rest, undefined)
	})

	it('rejects malformed blocks with invalid_mcp_content', () => {
		const cases: Array<unknown> = [
			[],
			'nope',
			[{ type: 'image', data: 'not base64!', mimeType: 'image/png' }],
			[{ type: 'image', data: png, mimeType: 'text/plain' }],
			[{ type: 'audio', data: png, mimeType: 'image/png' }],
			[{ type: 'text' }],
			[{ type: 'resource', resource: { uri: 'x' } }],
			[{ type: 'resource_link', uri: 'x' }],
			[{ type: 'video', data: png }],
		]
		for (const value of cases) {
			assert.throws(
				() => extractMcpContent({ [mcpContentKey]: value }, 1000),
				/invalid_mcp_content/,
				JSON.stringify(value),
			)
		}
	})

	it('enforces the serialized size cap instead of truncating media', () => {
		const big = 'A'.repeat(4000)
		assert.throws(
			() => extractMcpContent({ [mcpContentKey]: [{ type: 'image', data: big, mimeType: 'image/png' }] }, 1000),
			/mcp_content_too_large/,
		)
	})

	it('summarizes binary payloads for run history', () => {
		assert.deepEqual(
			summarizeMcpContent([
				{ type: 'image', data: png, mimeType: 'image/png' },
				{ type: 'text', text: 'caption' },
				{ type: 'resource', resource: { uri: 'kody://x', blob: png, mimeType: 'image/png' } },
			]),
			[
				{ type: 'image', mimeType: 'image/png', bytes: 9 },
				{ type: 'text', text: 'caption' },
				{ type: 'resource', resource: { uri: 'kody://x', mimeType: 'image/png', bytes: 9 } },
			],
		)
	})
})
