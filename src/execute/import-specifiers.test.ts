import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { lexImportSpecifiers, relativeImportCandidates, replaceImportSpecifiers } from './import-specifiers.ts'

const source = [
	"import a from 'kody:runtime'",
	"export * from './x.js'",
	"import './side.js'",
	'const s = "import { b } from \'kody:runtime\'"',
	"// import c from 'kody:runtime'",
	"const t = `import d from 'kody:runtime'`",
	"const m = await import('./dyn.js')",
	'const k = await import(name)',
	'console.log(import.meta.url)',
].join('\n')

describe('lexImportSpecifiers', () => {
	it('finds static, re-export, side-effect and literal dynamic imports only', () => {
		assert.deepEqual(
			lexImportSpecifiers(source, 'main.js').map((i) => i.specifier),
			['kody:runtime', './x.js', './side.js', './dyn.js'],
		)
	})

	it('marks TypeScript import type as typeOnly; export type … from is absent or typeOnly (kody skips both)', () => {
		const ranges = lexImportSpecifiers(
			[
				"import type { X } from './missing.js'",
				"export type { Y } from './also-missing.js'",
				"import { Z } from './real.js'",
				'export default 1',
			].join('\n'),
			'main.ts',
		)
		// es-module-lexer 2.3.2 omits `export type … from`; if a future lexer
		// reports it, typeOnly must be true so reachability still skips it.
		assert.deepEqual(
			ranges.map((i) => ({ specifier: i.specifier, typeOnly: i.typeOnly, kind: i.kind })),
			[
				{ specifier: './missing.js', typeOnly: true, kind: 'static' },
				{ specifier: './real.js', typeOnly: false, kind: 'static' },
			],
		)
		assert.equal(
			ranges.every((i) => i.specifier !== './also-missing.js' || i.typeOnly),
			true,
		)
	})

	it('reports a module the lexer cannot read as invalid_module with the file name', () => {
		assert.throws(
			() => lexImportSpecifiers("import x from 'a'\nconst = ;\n`", 'packages/@t/p/lib/bad.js'),
			(error: unknown) => {
				const e = error as { code?: string; message?: string }
				return e.code === 'invalid_module' && /packages\/@t\/p\/lib\/bad\.js/.test(e.message ?? '')
			},
		)
	})
})

describe('replaceImportSpecifiers', () => {
	it('rewrites real specifiers and leaves strings, comments and templates byte-for-byte', () => {
		const out = replaceImportSpecifiers(source, 'main.js', (specifier) =>
			specifier === 'kody:runtime' ? './kody-runtime.js' : specifier === './dyn.js' ? './lib/dyn.js' : null,
		)
		assert.equal(
			out,
			source
				.replace("import a from 'kody:runtime'", "import a from './kody-runtime.js'")
				.replace("import('./dyn.js')", "import('./lib/dyn.js')"),
		)
		assert.ok(out.includes('const s = "import { b } from \'kody:runtime\'"'))
		assert.ok(out.includes("// import c from 'kody:runtime'"))
		assert.ok(out.includes("const t = `import d from 'kody:runtime'`"))
	})

	it('returns the source untouched when nothing is replaced', () => {
		assert.equal(
			replaceImportSpecifiers(source, 'main.js', () => null),
			source,
		)
	})

	it('uses pre-lexed ranges without re-lexing when they are passed in', () => {
		const ranges = lexImportSpecifiers("import a from 'kody:runtime'\nexport default a", 'main.js')
		const out = replaceImportSpecifiers(
			"import a from 'kody:runtime'\nexport default a",
			'main.js',
			(specifier) => (specifier === 'kody:runtime' ? './kody-runtime.js' : null),
			ranges,
		)
		assert.equal(out, "import a from './kody-runtime.js'\nexport default a")
	})
})

describe('relativeImportCandidates', () => {
	it('lists the paths a relative import may resolve to, in order', () => {
		assert.deepEqual(relativeImportCandidates('lib/bump'), ['lib/bump', 'lib/bump.js', 'lib/bump/index.js'])
		assert.deepEqual(relativeImportCandidates('lib/bump.ts'), [
			'lib/bump.ts',
			'lib/bump.ts.js',
			'lib/bump.js',
			'lib/bump.ts/index.js',
		])
	})
})
