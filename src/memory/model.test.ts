import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KodyError } from '../lib/errors.ts'
import { ftsQuery, memoryEmbedText, memoryLimits, normalizeMemoryInput } from './model.ts'

describe('normalizeMemoryInput', () => {
	it('trims, dedupes tags/uris and nulls empty optionals', () => {
		const normalized = normalizeMemoryInput({
			subject: '  Editor ',
			summary: 'Prefers Zed ',
			tags: ['tools', 'tools', ' editor '],
			sourceUris: ['https://a.example/x', 'https://a.example/x'],
			category: '',
			dedupeKey: ' pref:editor ',
		})
		assert.equal(normalized.subject, 'Editor')
		assert.equal(normalized.summary, 'Prefers Zed')
		assert.equal(normalized.details, '')
		assert.equal(normalized.category, null)
		assert.deepEqual(normalized.tags, ['tools', 'editor'])
		assert.deepEqual(normalized.sourceUris, ['https://a.example/x'])
		assert.equal(normalized.dedupeKey, 'pref:editor')
	})

	it('enforces required fields and limits', () => {
		assert.throws(
			() => normalizeMemoryInput({ subject: '', summary: 'x' }),
			(e: unknown) => e instanceof KodyError && /subject/.test(e.message),
		)
		assert.throws(
			() => normalizeMemoryInput({ subject: 'x', summary: 'y'.repeat(memoryLimits.summary + 1) }),
			/summary/,
		)
		assert.throws(() => normalizeMemoryInput({ subject: 'x', summary: 'y', sourceUris: ['not a url'] }), /valid URL/)
		assert.throws(
			() =>
				normalizeMemoryInput({
					subject: 'x',
					summary: 'y',
					tags: Array.from({ length: memoryLimits.tags + 1 }, (_, i) => `t${i}`),
				}),
			/tags/,
		)
	})
})

describe('ftsQuery', () => {
	it('builds an OR of quoted prefix tokens and ignores punctuation/quotes', () => {
		assert.equal(ftsQuery('Zed "editor" pref:editor'), '"zed"* OR "editor"* OR "pref"*')
		assert.equal(ftsQuery('a ! ?'), null)
	})
})

describe('memoryEmbedText', () => {
	it('combines the durable fields into one embeddable text', () => {
		const text = memoryEmbedText({ subject: 'S', summary: 'Sum', details: '', tags: ['t1', 't2'], category: 'pref' })
		assert.equal(text, 'S Sum tags: t1, t2 category: pref')
	})
})
