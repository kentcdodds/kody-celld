import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KodyError } from '../lib/errors.ts'
import { decodePreviewSource, encodePreviewSource } from './preview-source.ts'

describe('preview source segment', () => {
	it('round-trips source and subdir through one URL-safe segment', () => {
		for (const ref of [
			{ source: 'github:kentcdodds/kody-celld/examples/packages/http-probe#main', subdir: null },
			{ source: 'https://example.com/pkg.tgz', subdir: 'package' },
			{ source: 'kody:@kody/żółw', subdir: null },
		]) {
			const segment = encodePreviewSource(ref)
			assert.match(segment, /^[A-Za-z0-9_-]+$/)
			assert.deepEqual(decodePreviewSource(segment), ref)
		}
	})

	it('matches the documented wire format (smoke builds segments by hand)', () => {
		const segment = Buffer.from(JSON.stringify(['https://10.0.0.7/pkg.tgz'])).toString('base64url')
		assert.deepEqual(decodePreviewSource(segment), { source: 'https://10.0.0.7/pkg.tgz', subdir: null })
	})

	it('rejects junk with a 400', () => {
		const junk = [
			'not*base64',
			'',
			Buffer.from('{"source":"x"}').toString('base64url'),
			Buffer.from('[]').toString('base64url'),
			Buffer.from('[""]').toString('base64url'),
			Buffer.from('[1]').toString('base64url'),
			Buffer.from('["a","b","c"]').toString('base64url'),
			Buffer.from(JSON.stringify(['x'.repeat(2049)])).toString('base64url'),
		]
		for (const segment of junk) {
			assert.throws(
				() => decodePreviewSource(segment),
				(error: unknown) =>
					error instanceof KodyError && error.code === 'invalid_preview_source' && error.status === 400,
				segment,
			)
		}
	})
})
