import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bytesToLatin1String } from './package-file-media.ts'
import {
	buildPackageFilesAncestors,
	buildPackageFilesView,
	contentKindFromLanguage,
	findDirectoryReadmePath,
	languageFromFilePath,
	listPackageFilesChildren,
	normalizePackageFilesPath,
} from './package-files.ts'
import { resolvePackageReadmeImagePath } from './package-readme-images.ts'

// Ported from kody packages/worker/universal/package-files.node.test.ts (first test;
// the second covers community/raw hrefs, which kody-celld does not port).
const files = {
	'README.md': '# Hello\n\n## Intent\n\nDo a thing.',
	'package.json': '{"name":"@owner/demo"}',
	'src/index.ts': 'export const answer = 42\n',
	'src/lib/util.ts':
		'export function add(a: number, b: number) { return a + b }\n',
	'docs/guide.md': '# Guide\n',
}

function assertMatches(actual: unknown, expected: Record<string, unknown>) {
	assert.ok(actual && typeof actual === 'object', 'expected an object')
	for (const [key, value] of Object.entries(expected)) {
		assert.deepEqual((actual as Record<string, unknown>)[key], value, key)
	}
}

describe('package files view', () => {
	it('normalizes paths and distinguishes root, directories, files, and misses', () => {
		const paths: Array<[string | null, string | null]> = [
			[null, ''],
			['', ''],
			['/', ''],
			['src/index.ts', 'src/index.ts'],
			['/src/lib/util.ts/', 'src/lib/util.ts'],
			['src/%2E%2E/secrets', null],
			['../package.json', null],
			['src\\index.ts', null],
			['src/%2Findex.ts', 'src/index.ts'],
		]
		assert.deepEqual(
			paths.map(([path]) => [path, normalizePackageFilesPath(path)]),
			paths,
		)

		const root = buildPackageFilesView({ files, selectedPath: '' })
		assertMatches(root, {
			kind: 'directory',
			selectedPath: '',
			contentPath: 'README.md',
			contentKind: 'markdown',
		})
		assert.deepEqual(
			root?.children.map((child) => child.name),
			['docs', 'src', 'package.json', 'README.md'],
		)

		const src = buildPackageFilesView({ files, selectedPath: 'src' })
		assertMatches(src, { kind: 'directory', contentPath: null, content: null })
		assert.deepEqual(src?.children, [
			{ name: 'lib', path: 'src/lib', kind: 'directory' },
			{ name: 'index.ts', path: 'src/index.ts', kind: 'file' },
		])

		const file = buildPackageFilesView({ files, selectedPath: 'src/index.ts' })
		assertMatches(file, {
			kind: 'file',
			content: 'export const answer = 42\n',
			contentPath: 'src/index.ts',
			contentKind: 'code',
			language: 'ts',
		})

		const pngBytes = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
		])
		const image = buildPackageFilesView({
			files: { ...files, 'docs/logo.png': bytesToLatin1String(pngBytes) },
			selectedPath: 'docs/logo.png',
		})
		assertMatches(image, {
			kind: 'file',
			content: null,
			contentKind: 'image',
			language: null,
			contentByteLength: pngBytes.byteLength,
		})
		assertMatches(
			buildPackageFilesView({
				files: { 'app.wasm': 'wasm\0module' },
				selectedPath: 'app.wasm',
			}),
			{
				kind: 'file',
				content: null,
				contentKind: 'binary',
			},
		)
		assertMatches(
			buildPackageFilesView({
				files: { 'evil.svg': '<!DOCTYPE html><script>alert(1)</script>' },
				selectedPath: 'evil.svg',
			}),
			{
				kind: 'file',
				content: '<!DOCTYPE html><script>alert(1)</script>',
				contentKind: 'code',
				language: 'xml',
			},
		)

		for (const selectedPath of [
			'missing',
			'constructor',
			'toString',
			'__proto__',
		]) {
			assert.equal(
				buildPackageFilesView({ files, selectedPath }),
				null,
				selectedPath,
			)
		}
		assert.equal(
			buildPackageFilesView({ files: {}, selectedPath: '' })?.kind,
			'directory',
		)
		assertMatches(
			buildPackageFilesView({
				files: { constructor: 'export {}\n' },
				selectedPath: 'constructor',
			}),
			{ kind: 'file', content: 'export {}\n' },
		)

		assert.equal(findDirectoryReadmePath(files, ''), 'README.md')
		assert.equal(findDirectoryReadmePath(files, 'docs'), null)
		assert.deepEqual(listPackageFilesChildren(Object.keys(files), 'docs'), [
			{ name: 'guide.md', path: 'docs/guide.md', kind: 'file' },
		])
		assert.deepEqual(
			buildPackageFilesAncestors('src/lib/util.ts').map((entry) => entry.name),
			['src', 'lib', 'util.ts'],
		)
	})

	it('exports language helpers for the text fallback (kody-celld)', () => {
		assert.equal(languageFromFilePath('icons/logo.svg'), 'xml')
		assert.equal(languageFromFilePath('notes.txt'), 'plaintext')
		assert.equal(contentKindFromLanguage('xml'), 'code')
		assert.equal(contentKindFromLanguage('markdown'), 'markdown')
		assert.equal(contentKindFromLanguage('plaintext'), 'text')
	})

	it('resolves README image paths inside the package only', () => {
		assert.equal(
			resolvePackageReadmeImagePath('./logo.png', 'docs'),
			'docs/logo.png',
		)
		assert.equal(resolvePackageReadmeImagePath('../logo.png', 'docs'), null)
		assert.equal(
			resolvePackageReadmeImagePath('https://example.com/logo.png'),
			null,
		)
	})
})
