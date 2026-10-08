import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	inProcessHighlightEnv,
	loadPackageFilesData,
} from '#app/package-files-data.ts'

const files = {
	'README.md': '# Demo\n\nRun it:\n\n```ts\nconst x = 1\n```\n',
	'src/index.ts': 'export const answer = 42\n',
	'icons/logo.svg':
		'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>\n',
	'big.ts': 'export const x = 1\n'.repeat(3000),
}

function load(
	selectedPath: string,
	overrides: Partial<{ files: Record<string, string> }> = {},
) {
	return loadPackageFilesData({
		env: inProcessHighlightEnv(),
		files: overrides.files ?? files,
		selectedPath,
		title: '@demo/pkg',
		backHref: '/account/packages/%40demo%2Fpkg',
		backLabel: '@demo/pkg',
		filesBasePath: '/account/packages/%40demo%2Fpkg/files',
	})
}

describe('loadPackageFilesData', () => {
	it('opens the root on the README with highlighted fences', async () => {
		const data = await load('')
		assert.ok(data)
		assert.equal(data.kind, 'directory')
		assert.equal(data.contentPath, 'README.md')
		assert.equal(data.contentKind, 'markdown')
		assert.equal(data.contentFences?.length, 1)
		assert.equal(data.contentFences?.[0]?.plain, false)
		assert.deepEqual(data.paths, [
			'big.ts',
			'icons/logo.svg',
			'README.md',
			'src/index.ts',
		])
		assert.equal(data.filesBasePath, '/account/packages/%40demo%2Fpkg/files')
		assert.equal(data.mediaHref, null)
		assert.equal(data.imageBaseHref, null)
	})

	it('highlights a code file', async () => {
		const data = await load('src/index.ts')
		assert.equal(data?.contentKind, 'code')
		assert.equal(data?.contentHighlighted?.plain, false)
		assert.equal(data?.contentHighlighted?.lang, 'ts')
	})

	it('svg shows as highlighted XML instead of a media preview', async () => {
		const data = await load('icons/logo.svg')
		assert.equal(data?.contentKind, 'code')
		assert.equal(data?.language, 'xml')
		assert.ok(data?.content?.startsWith('<svg'))
		assert.equal(data?.contentHighlighted?.plain, false)
		assert.equal(data?.mediaHref, null)
	})

	it('directory without README lists children', async () => {
		const data = await load('lib', {
			files: { 'lib/a.js': 'a', 'lib/b.js': 'b' },
		})
		assert.equal(data?.kind, 'directory')
		assert.equal(data?.content, null)
		assert.equal(data?.contentKind, null)
		assert.deepEqual(
			data?.children.map((child) => child.name),
			['a.js', 'b.js'],
		)
	})

	it('large files fall back to plain text without a second copy of the content', async () => {
		const data = await load('big.ts')
		assert.equal(data?.content?.length, files['big.ts'].length)
		assert.equal(data?.contentKind, 'code')
		assert.equal(data?.contentHighlighted, null)
	})

	it('very large files are truncated for display with a notice (kody-celld)', async () => {
		const huge = 'x'.repeat(300_000)
		const data = await load('huge.txt', { files: { 'huge.txt': huge } })
		assert.ok(data?.content?.startsWith('x'.repeat(200_000)))
		assert.ok((data?.content?.length ?? 0) < 200_200)
		assert.match(
			data?.content ?? '',
			/truncated: showing the first 200,000 characters/,
		)
		assert.equal(data?.contentByteLength, 300_000)
	})

	it('unknown, traversal and prototype paths return null', async () => {
		for (const path of [
			'nope.js',
			'../README.md',
			'src/%2E%2E/README.md',
			'constructor',
			'__proto__',
		]) {
			assert.equal(await load(path), null, path)
		}
	})
})
