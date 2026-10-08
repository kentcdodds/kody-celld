import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	inProcessHighlightEnv,
	loadPackageFilesData,
} from '#app/package-files-data.ts'
import { packageFileViewMaxChars } from '../packages/install.ts'

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
	it('opens files whose names contain % (route params arrive decoded)', async () => {
		const percentFiles = {
			'100%.txt': 'full\n',
			'a%41.txt': 'literal\n',
			'aA.txt': 'decoded\n',
		}
		const full = await load('100%.txt', { files: percentFiles })
		assert.equal(full?.contentPath, '100%.txt')
		const literal = await load('a%41.txt', { files: percentFiles })
		assert.equal(literal?.contentPath, 'a%41.txt')
		assert.equal(literal?.content, 'literal\n')
	})

	it('still refuses traversal after the decoded path is re-encoded', async () => {
		assert.equal(await load('../README.md'), null)
		assert.equal(await load('src/../../README.md'), null)
	})

	it('encoded .. segments stay literal after re-encoding (do not open README)', async () => {
		// Without re-encoding, decodeURIComponent('%2E%2E') is '..' and normalize
		// rejects. After re-encoding each segment, '%2E%2E' is a literal name —
		// not parent traversal — so the real README is never selected.
		assert.equal(await load('src/%2E%2E/README.md'), null)
		assert.equal(await load('%2E%2E/README.md'), null)
		assert.equal((await load('README.md'))?.contentPath, 'README.md')
	})

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
		assert.equal(data?.contentTruncated, false)
	})

	it('very large files are truncated for display; notice is outside content', async () => {
		const huge = 'x'.repeat(packageFileViewMaxChars + 100_000)
		const data = await load('huge.txt', { files: { 'huge.txt': huge } })
		assert.equal(data?.content, 'x'.repeat(packageFileViewMaxChars))
		assert.equal(data?.contentTruncated, true)
		assert.equal(data?.contentByteLength, huge.length)
		assert.doesNotMatch(data?.content ?? '', /truncated/)
	})

	it('unknown, traversal and prototype paths return null', async () => {
		for (const path of [
			'nope.js',
			'../README.md',
			'constructor',
			'__proto__',
		]) {
			assert.equal(await load(path), null, path)
		}
	})
})
