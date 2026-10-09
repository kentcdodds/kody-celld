import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isCodeModulePath, jsxOptionsFromFiles, stripTypes, transpileKind } from './strip-types.ts'

describe('transpileKind / isCodeModulePath', () => {
	it('maps extensions to the transform they need; declarations are never modules', () => {
		assert.equal(transpileKind('src/index.ts'), 'ts')
		assert.equal(transpileKind('src/extra.mts'), 'ts')
		assert.equal(transpileKind('app/view.tsx'), 'tsx')
		assert.equal(transpileKind('app/view.jsx'), 'jsx')
		for (const path of ['src/globals.d.ts', 'src/globals.d.mts', 'lib/main.js', 'lib/x.mjs', 'notes.txt']) {
			assert.equal(transpileKind(path), null, path)
		}
	})

	it('lists the files that become isolate modules', () => {
		for (const path of ['a.js', 'a.mjs', 'a.ts', 'a.mts', 'a.tsx', 'a.jsx'])
			assert.equal(isCodeModulePath(path), true, path)
		for (const path of ['a.d.ts', 'a.d.mts', 'a.json', 'README.md']) assert.equal(isCodeModulePath(path), false, path)
	})
})

describe('stripTypes (TypeScript)', () => {
	it('removes annotations, generics, as and satisfies', () => {
		const out = stripTypes(
			'export const id = <T,>(x: T): T => x\nexport default (n: number) => ({ n } satisfies { n: number }) as const',
			'src/a.ts in package @t/x',
		)
		assert.doesNotMatch(out, /: T|<T|satisfies|as const|: number/)
		assert.match(out, /export const id = \(x\) => x/)
	})

	it('emits enums and constructor parameter properties', () => {
		const out = stripTypes(
			"enum Unit { Cm = 'cm' }\nclass Box { constructor(private readonly size: number) {} }\nexport { Unit, Box }",
			'x',
		)
		assert.match(out, /var Unit; \(function \(Unit\)/)
		assert.match(out, /this\.size = size/)
	})

	it('drops type-only imports and imports used only as types, keeps value and side-effect imports', () => {
		const out = stripTypes(
			[
				"import type { A } from './a.ts'",
				"import { B, type C } from './b.ts'",
				"import { OnlyType } from './only-type.ts'",
				"import './side.ts'",
				"export type { D } from './d.ts'",
				'export default (x: OnlyType | C): A => B(x)',
			].join('\n'),
			'x',
		)
		assert.doesNotMatch(out, /\.\/a\.ts|only-type|\.\/d\.ts/)
		assert.match(out, /import \{ B, \} from '\.\/b\.ts'/)
		assert.match(out, /import '\.\/side\.ts'/)
	})

	it('keeps the line count so stack traces point at the source lines', () => {
		const source = 'type T = {\n\ta: number\n}\nexport default (x: T): number =>\n\tx.a\n'
		assert.equal(stripTypes(source, 'x').split('\n').length, source.split('\n').length)
	})

	it('leaves import-shaped text in strings and templates alone', () => {
		const source = 'export const t = `import x from "kody:runtime"`\nexport const s = "import y from \'./y.ts\'"'
		assert.equal(stripTypes(source, 'x'), source)
	})

	it('returns plain modern JS unchanged', () => {
		const source =
			"import { kody } from 'kody:runtime'\nclass C { #n = 1; static s = 2 }\nexport default async (p) => (await kody.runList({}))?.runs ?? new C()"
		assert.equal(stripTypes(source, 'your execute code'), source)
	})

	it('names the module and position of a syntax error', () => {
		assert.throws(
			() => stripTypes('export const broken = (x: ) => 1', 'src/bad.ts in package @t/typed-broken'),
			(error: unknown) => {
				assert.equal((error as { code?: string }).code, 'invalid_module')
				assert.match(
					(error as Error).message,
					/^Cannot read the TypeScript in src\/bad\.ts in package @t\/typed-broken: Unexpected token \(1:\d+\)\.$/,
				)
				return true
			},
		)
	})

	it('does not read JSX in TypeScript-only mode (ad hoc code)', () => {
		assert.throws(() => stripTypes('export default () => <b/>', 'your execute code'), /Cannot read the TypeScript/)
	})
})

describe('stripTypes (JSX)', () => {
	it('compiles .tsx with the automatic runtime and import source, keeping line numbers', () => {
		const source = 'export default (p: { n: number }) => (\n\t<div class="x">\n\t\t{p.n}<></>\n\t</div>\n)'
		const out = stripTypes(source, 'app/view.tsx', 'tsx', { runtime: 'automatic', importSource: 'remix/component' })
		assert.match(out, /from "remix\/component\/jsx-runtime"/)
		assert.match(out, /_jsxs?\('div'/)
		assert.doesNotMatch(out, /: \{ n: number \}|jsxDEV/)
		assert.equal(out.split('\n').length, source.split('\n').length)
	})

	it('uses the classic React.createElement by default', () => {
		const out = stripTypes('export default () => <><b x={1}/></>', 'app/view.jsx', 'jsx')
		assert.match(out, /React\.createElement\(React\.Fragment, null, React\.createElement\('b'/)
	})

	it('lets per-file pragmas override the package options', () => {
		const automatic = stripTypes('/** @jsxImportSource remix/component */\nexport default () => <b/>', 'x', 'tsx', {
			runtime: 'classic',
		})
		assert.match(automatic, /from "remix\/component\/jsx-runtime"/)
		const classic = stripTypes('/** @jsxRuntime classic */\nexport default () => <b/>', 'x', 'tsx', {
			runtime: 'automatic',
			importSource: 'remix/component',
		})
		assert.match(classic, /React\.createElement\('b'/)
		assert.doesNotMatch(classic, /jsx-runtime/)
	})

	it('names the JSX module that cannot be read', () => {
		assert.throws(
			() => stripTypes('export default (x: number) => <b/>', 'app/view.jsx in package @t/x', 'jsx'),
			/Cannot read the JSX in app\/view\.jsx in package @t\/x: Unexpected token/,
		)
	})
})

describe('jsxOptionsFromFiles', () => {
	const withTsconfig = (raw: string) => ({ 'tsconfig.json': raw })

	it('reads jsx and jsxImportSource from a JSONC tsconfig.json, as kody does', () => {
		assert.deepEqual(
			jsxOptionsFromFiles(
				withTsconfig(
					'{\n\t// package app\n\t"compilerOptions": {\n\t\t"jsx": "react-jsx", /* automatic */\n\t\t"jsxImportSource": "remix/component",\n\t},\n}',
				),
			),
			{ runtime: 'automatic', importSource: 'remix/component' },
		)
		assert.deepEqual(jsxOptionsFromFiles(withTsconfig('{"compilerOptions":{"jsx":"react-jsxdev"}}')), {
			runtime: 'automatic',
		})
		assert.deepEqual(jsxOptionsFromFiles(withTsconfig('{"compilerOptions":{"jsx":"react"}}')), { runtime: 'classic' })
		assert.deepEqual(jsxOptionsFromFiles(withTsconfig('{"compilerOptions":{"jsx":"preserve"}}')), {
			runtime: 'preserve',
		})
	})

	it('keeps // inside strings and falls back to classic without a usable tsconfig', () => {
		assert.deepEqual(
			jsxOptionsFromFiles(withTsconfig('{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"https://x.dev//y"}}')),
			{ runtime: 'automatic', importSource: 'https://x.dev//y' },
		)
		assert.deepEqual(jsxOptionsFromFiles({}), { runtime: 'classic' })
		assert.deepEqual(jsxOptionsFromFiles(withTsconfig('{ not json')), { runtime: 'classic' })
		assert.deepEqual(jsxOptionsFromFiles(withTsconfig('{"compilerOptions":{"jsx":"weird"}}')), { runtime: 'classic' })
	})
})
