import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { UserCell } from '../cells/user-cell.ts'
import { parsePackageManifest } from '../packages/manifest.ts'
import { buildModuleGraph, relativeSpecifier, SEALED_MODULE_PATH, stampPackageStorage } from './module-graph.ts'

const counterFiles = {
	'package.json': JSON.stringify({
		name: '@t/counter',
		version: '1.0.0',
		exports: { '.': './status.js', './increment': './increment.js' },
	}),
	'README.md': 'counter',
	'AGENTS.md': 'counter',
	'status.js': "import { packageStorage } from 'kody:runtime'\nexport default async () => packageStorage().get('n')",
	'increment.js': "import { bump } from './lib/bump.js'\nexport default async () => bump()",
	'lib/bump.js':
		"import { packageStorage } from 'kody:runtime'\nexport const bump = () => packageStorage( ).set('n', 1)",
}

const vaultFiles = {
	'package.json': JSON.stringify({
		name: '@t/vault',
		version: '1.0.0',
		exports: { '.': './status.js', './secretProvider': './provider.js', './leak': './leak.js' },
		kody: { secretProvider: { id: 'vault' } },
	}),
	'README.md': 'vault',
	'AGENTS.md': 'vault',
	'status.js': 'export default async () => ({ ok: true })',
	'provider.js': "export default async ({ ref }) => ({ value: 'v-' + ref })",
	'leak.js': "import provider from './provider.js'\nexport default async () => provider({ ref: 'x' })",
}

// Ordinary entry reaches a helper only via dynamic import. The helper statically
// imports the provider and also has an unused literal dynamic bare import that
// fails with npm off. Rewrite must not publish the helper's original source
// (that would leave the provider import unsealed).
const deferredSealFiles = {
	'package.json': JSON.stringify({
		name: '@t/deferred-seal',
		version: '1.0.0',
		exports: { '.': './index.js', './secretProvider': './provider.js' },
		kody: { secretProvider: { id: 'deferred-seal' } },
	}),
	'README.md': 'deferred seal',
	'AGENTS.md': 'deferred seal',
	'index.js': "export default async () => (await import('./helper.js')).default()",
	'helper.js':
		"import provider from './provider.js'\nvoid import('lodash')\nexport default async () => provider({ ref: 'x' })",
	'provider.js': "export default async ({ ref }) => ({ value: 'v-' + ref })",
}

// A package written by an agent from inside execute: its source mentions
// imports in a string, a template literal and a comment.
const textFiles = {
	'package.json': JSON.stringify({ name: '@t/text', version: '1.0.0', exports: { '.': './main.js' } }),
	'README.md': 'text',
	'AGENTS.md': 'text',
	'main.js': [
		"import { packageStorage } from 'kody:runtime'",
		"export * from './lib/extra.js'",
		'const template = "import { packageStorage } from \'kody:runtime\'"',
		"// import other from 'kody:runtime'",
		"const doc = `import x from './lib/extra.js'`",
		"export default async () => ({ template, doc, extra: (await import('./lib/extra.js')).extra })",
	].join('\n'),
	'lib/extra.js': 'export const extra = 1',
}

const brokenFiles = {
	'package.json': JSON.stringify({ name: '@t/broken', version: '1.0.0', exports: { '.': './lib/main.js' } }),
	'README.md': 'broken',
	'AGENTS.md': 'broken',
	'lib/main.js': "import { packageStorage } from './kody-runtime.js'\nexport default async () => typeof packageStorage",
}

// Files celld never links (an unused test, a JSX client file) and an optional
// dynamic import must not stop the package from running: celld instantiates
// only what the entry reaches through static imports.
const tolerantFiles = {
	'package.json': JSON.stringify({ name: '@t/tolerant', version: '1.0.0', exports: { '.': './index.js' } }),
	'README.md': 'tolerant',
	'AGENTS.md': 'tolerant',
	'index.js':
		"export default async () => { try { await import('./optional.js'); return 'loaded' } catch { return 'fallback' } }",
	'test/unused.test.js': "import helper from '../src/helper.js'\nexport default helper",
	'client/view.js': 'export default () => <div>hi</div>',
}

const textImportFiles = {
	'package.json': JSON.stringify({ name: '@t/text-import', version: '1.0.0', exports: { '.': './index.js' } }),
	'README.md': 'text import',
	'AGENTS.md': 'text import',
	'index.js': "import notes from './notes.txt'\nexport default () => notes",
	'notes.txt': 'not a module',
}

// A kody.codes-style TypeScript package: annotations, an enum, a parameter
// property, a generic packageStorage call, a type-only sibling, a named import
// used only as a type from a file that does not exist, an .mts export, a JS
// file importing TS, a declaration file and an unreached broken file.
const typedFiles = {
	'package.json': JSON.stringify({
		name: '@t/typed',
		version: '1.0.0',
		exports: { '.': './src/index.ts', './extra': './src/extra.mts', './js': './src/bridge.js' },
	}),
	'README.md': 'typed',
	'AGENTS.md': 'typed',
	'src/index.ts': [
		"import { packageStorage } from 'kody:runtime'",
		"import type { Shape } from './types.ts'",
		"import { Missing } from './missing-types.ts'",
		"import { area } from './area.ts'",
		"enum Unit { Cm = 'cm' }",
		'class Box {',
		'\tconstructor(private readonly size: number) {}',
		'\tget area(): number { return area({ w: this.size, h: this.size } satisfies Shape) }',
		'}',
		'export const storage = () => packageStorage<{ n: number }>()',
		'export default async (params: { size?: number } = {}): Promise<string> => {',
		'\tconst none: Missing | null = null',
		'\treturn `${new Box(params.size ?? 2).area}${Unit.Cm}${none ?? ""}`',
		'}',
	].join('\n'),
	'src/types.ts': 'export type Shape = { w: number; h: number }',
	'src/area.ts': "import type { Shape } from './types.ts'\nexport const area = (s: Shape): number => s.w * s.h",
	'src/extra.mts': 'export default (n: number): number => n + 1',
	'src/bridge.js': "import { area } from './area.ts'\nexport default () => area({ w: 1, h: 3 })",
	'src/globals.d.ts': 'declare const injected: string',
	'src/unused-broken.ts': 'export const broken = (x: ) => 1',
}

const typedBrokenFiles = {
	'package.json': JSON.stringify({ name: '@t/typed-broken', version: '1.0.0', exports: { '.': './src/index.ts' } }),
	'README.md': 'typed broken',
	'AGENTS.md': 'typed broken',
	'src/index.ts': "import { broken } from './bad.ts'\nexport default () => broken",
	'src/bad.ts': 'export const broken = (x: ) => 1',
}

// A package app: JSONC tsconfig choosing remix/component's automatic runtime,
// a classic-pragma file with a local createElement, and a .jsx file.
const tsxFiles = {
	'package.json': JSON.stringify({
		name: '@t/tsx',
		version: '1.0.0',
		exports: { '.': './src/view.tsx', './classic': './src/classic.tsx', './plain': './src/plain.jsx' },
	}),
	'README.md': 'tsx',
	'AGENTS.md': 'tsx',
	'tsconfig.json':
		'{\n\t// package app\n\t"compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "remix/component", },\n}',
	'src/view.tsx':
		"import { label } from './label.ts'\nexport default (p: { n: number }) => (\n\t<b>{label}{p.n}</b>\n)",
	'src/label.ts': "export const label: string = 'n='",
	'src/classic.tsx':
		"/** @jsxRuntime classic */\nimport * as React from './h.ts'\nexport default (): string => <b n={1}>{'x'}</b>",
	'src/h.ts':
		'export const createElement = (tag: string, props: unknown, ...children: Array<unknown>): string => `<${tag}>${children.join("")}</${tag}>`\nexport const Fragment = "frag"',
	'src/plain.jsx': "import * as React from './h.ts'\nexport default () => <i>{'y'}</i>",
}

const tsxClassicFiles = {
	'package.json': JSON.stringify({ name: '@t/tsx-classic', version: '1.0.0', exports: { '.': './src/classic.tsx' } }),
	'README.md': 'tsx classic',
	'AGENTS.md': 'tsx classic',
	'tsconfig.json': '{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "remix/component" } }',
	'src/classic.tsx':
		"/** @jsxRuntime classic */\nimport * as React from './h.ts'\nexport default (): string => <b n={1}>{'x'}</b>",
	'src/h.ts':
		'export const createElement = (tag: string, props: unknown, ...children: Array<unknown>): string => `<${tag}>${children.join("")}</${tag}>`\nexport const Fragment = "frag"',
	'src/plain.jsx': "/** @jsxRuntime classic */\nimport * as React from './h.ts'\nexport default () => <i>{'y'}</i>",
}

// A package app: the server export is plain TS; client .tsx files under the
// automatic runtime import npm packages and are never reached from the entry.
const appShapeFiles = {
	'package.json': JSON.stringify({
		name: '@t/app-shape',
		version: '1.0.0',
		exports: { '.': './src/index.ts', './client': './client/app.tsx' },
	}),
	'README.md': 'app shape',
	'AGENTS.md': 'app shape',
	'tsconfig.json': '{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "remix/component" } }',
	'src/index.ts': 'export default (): number => 1',
	'client/app.tsx':
		"import { renderToString } from 'react-dom/server'\nimport other from 'kody:@t/not-saved'\nexport default () => <b>{String(renderToString)}{other}</b>",
}

const packages: Record<string, Record<string, string>> = {
	'@t/app-shape': appShapeFiles,
	'@t/typed': typedFiles,
	'@t/typed-broken': typedBrokenFiles,
	'@t/tsx': tsxFiles,
	'@t/tsx-classic': tsxClassicFiles,
	'@t/tolerant': tolerantFiles,
	'@t/text-import': textImportFiles,
	'@t/counter': counterFiles,
	'@t/vault': vaultFiles,
	'@t/deferred-seal': deferredSealFiles,
	'@t/text': textFiles,
	'@t/broken': brokenFiles,
}

// Saved before packageSave checked relative imports: their stored manifests
// exist even though parsing these files now refuses them.
const savedBeforeImportCheck: Record<string, Record<string, string>> = {
	'@t/broken': { 'lib/main.js': 'export default 1' },
	'@t/text-import': { 'index.js': 'export default 1' },
}

const fakeUserCell = {
	async packageGet(name: string) {
		const files = packages[name]
		if (!files) return null
		return {
			name,
			version: '1.0.0',
			// @t/broken was saved before packageSave checked relative imports, so its
			// stored manifest exists even though parsing its files now refuses them.
			manifest: parsePackageManifest(
				savedBeforeImportCheck[name] ? { ...files, ...savedBeforeImportCheck[name] } : files,
			),
			files,
			source: 'test',
			createdAt: '',
			updatedAt: '',
		}
	},
} as unknown as DurableObjectStub<UserCell>

describe('relativeSpecifier', () => {
	it('yields a path relative to the importing module (celld 0.6)', () => {
		assert.equal(relativeSpecifier('packages/@t/counter/lib/bump.js', 'kody-runtime.js'), '../../../../kody-runtime.js')
		assert.equal(relativeSpecifier('main.js', 'packages/@t/counter/status.js'), './packages/@t/counter/status.js')
	})
})

describe('stampPackageStorage', () => {
	it('binds bare packageStorage() calls to the declaring package', () => {
		assert.equal(
			stampPackageStorage('packageStorage()\npackageStorage( )', '@t/counter'),
			'packageStorage("@t/counter")\npackageStorage("@t/counter")',
		)
		assert.equal(stampPackageStorage('packageStorage("@other/pkg")', '@t/counter'), 'packageStorage("@other/pkg")')
	})
})

describe('buildModuleGraph', () => {
	it('rewrites kody:runtime, kody:<pkg>/<export>, and intra-package imports; drops docs from the isolate', async () => {
		const graph = await buildModuleGraph({
			entry: { kind: 'adhoc', code: "import inc from 'kody:@t/counter/increment'\nexport default async () => inc()" },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.equal(
			graph.modules['main.js'],
			"import inc from './packages/@t/counter/increment.js'\nexport default async () => inc()",
		)
		assert.match(graph.modules['packages/@t/counter/increment.js'] ?? '', /from '\.\/lib\/bump\.js'/)
		assert.match(
			graph.modules['packages/@t/counter/lib/bump.js'] ?? '',
			/from '\.\.\/\.\.\/\.\.\/\.\.\/kody-runtime\.js'/,
		)
		assert.match(graph.modules['packages/@t/counter/lib/bump.js'] ?? '', /packageStorage\("@t\/counter"\)/)
		assert.equal('packages/@t/counter/README.md' in graph.modules, false)
		assert.equal('packages/@t/counter/AGENTS.md' in graph.modules, false)
		assert.match(graph.modules['packages/@t/counter/package.json'] ?? '', /^export default \{/)
		assert.deepEqual(graph.packages, ['@t/counter'])
	})

	it('rewrites only real imports: strings, templates and comments that look like imports stay as written', async () => {
		const graph = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/text' },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.equal(
			graph.modules['packages/@t/text/main.js'],
			[
				"import { packageStorage } from '../../../kody-runtime.js'",
				"export * from './lib/extra.js'",
				'const template = "import { packageStorage } from \'kody:runtime\'"',
				"// import other from 'kody:runtime'",
				"const doc = `import x from './lib/extra.js'`",
				"export default async () => ({ template, doc, extra: (await import('./lib/extra.js')).extra })",
			].join('\n'),
		)
	})

	it('names the file and package of a relative import that does not resolve', async () => {
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'package', packageName: '@t/broken' },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			(error: unknown) => {
				const e = error as { code?: string; message?: string }
				return (
					e.code === 'invalid_import' &&
					e.message === 'Cannot resolve "./kody-runtime.js" from lib/main.js in package @t/broken.'
				)
			},
		)
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'adhoc', code: "import x from './nope.js'\nexport default () => x" },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/Cannot resolve "\.\/nope\.js" from your execute code\./,
		)
	})

	it('does not require import type to resolve; still names a missing value import', async () => {
		const graph = await buildModuleGraph({
			entry: {
				kind: 'adhoc',
				code: "import type { X } from './missing.js'\nexport default (): number => 1",
			},
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.doesNotMatch(graph.modules[graph.entryPath] ?? '', /missing\.js/)
		// Bare type-only must not trip unsupported_import when npm is disabled.
		await buildModuleGraph({
			entry: {
				kind: 'adhoc',
				code: "import type { X } from 'missing-types'\nexport default (): number => 1",
			},
			userCell: fakeUserCell,
			allowNpm: false,
		})
		await assert.rejects(
			buildModuleGraph({
				entry: {
					kind: 'adhoc',
					code: "import { X } from './missing.js'\nexport default () => X",
				},
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/Cannot resolve "\.\/missing\.js" from your execute code\./,
		)
		await assert.rejects(
			buildModuleGraph({
				entry: {
					kind: 'adhoc',
					code: "import type from './missing.js'\nexport default type",
				},
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/Cannot resolve "\.\/missing\.js" from your execute code\./,
		)
	})

	it('ignores files the entry never reaches and keeps optional dynamic imports catchable', async () => {
		const graph = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/tolerant' },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.equal(graph.modules['packages/@t/tolerant/index.js'], tolerantFiles['index.js'])
		assert.equal(graph.modules['packages/@t/tolerant/test/unused.test.js'], tolerantFiles['test/unused.test.js'])
		// JSX in an unreached .js file: publish a throwing stub, not the original source.
		assert.match(graph.modules['packages/@t/tolerant/client/view.js'] ?? '', /throw error/)
		assert.doesNotMatch(graph.modules['packages/@t/tolerant/client/view.js'] ?? '', /<div>/)
	})

	it('does not resolve imports to files that never become modules', async () => {
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'package', packageName: '@t/text-import' },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/Cannot resolve "\.\/notes\.txt" from index\.js in package @t\/text-import\./,
		)
	})

	it('refuses bare npm imports when npm is disabled and unknown packages always', async () => {
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'adhoc', code: "import x from 'lodash'\nexport default () => x" },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/unsupported_import/,
		)
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'adhoc', code: "import x from 'kody:@t/nope'\nexport default () => x" },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/package_not_found/,
		)
	})

	it('keeps a kody.secretProvider entry sealed: no import path reaches it, only a sealed run may enter', async () => {
		const sealedRun = () =>
			buildModuleGraph({
				entry: { kind: 'package', packageName: '@t/vault', entryPath: 'provider.js' },
				userCell: fakeUserCell,
				allowNpm: false,
				sealed: true,
			})
		const graph = await sealedRun()
		assert.equal(graph.entryPath, 'packages/@t/vault/provider.js')

		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'package', packageName: '@t/vault', entryPath: 'provider.js' },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/secret_provider_entry_sealed/,
		)

		// Imports of the entry (kody: or relative, even from its own package) are
		// pointed at a stub that throws on evaluation; unrelated exports still work.
		const viaKody = await buildModuleGraph({
			entry: {
				kind: 'adhoc',
				code: "import p from 'kody:@t/vault/secretProvider'\nexport default () => p({ ref: 'x' })",
			},
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.match(viaKody.modules['main.js'] ?? '', /from '\.\/kody-sealed\.js'/)
		assert.match(viaKody.modules[SEALED_MODULE_PATH] ?? '', /^const error = new Error\(/)
		assert.match(viaKody.modules[SEALED_MODULE_PATH] ?? '', /secret_provider_entry_sealed:403/)
		assert.match(viaKody.modules['packages/@t/vault/leak.js'] ?? '', /from '\.\.\/\.\.\/\.\.\/kody-sealed\.js'/)
		assert.doesNotMatch(viaKody.modules['main.js'] ?? '', /provider\.js/)

		const status = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/vault', entryPath: 'status.js' },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.equal(status.entryPath, 'packages/@t/vault/status.js')
		assert.equal(SEALED_MODULE_PATH in graph.modules, true, 'the sealed graph still stubs sibling imports')
	})

	it('never publishes original source when a deferred rewrite failed (sealed provider + unused bare import)', async () => {
		// With npm off, helper's unused `import('lodash')` fails rewrite after the
		// provider sealing redirect was computed. Publishing the original helper
		// would leave `./provider.js` reachable via the entry's dynamic import.
		const graph = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/deferred-seal' },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		const helper = graph.modules['packages/@t/deferred-seal/helper.js'] ?? ''
		assert.notEqual(helper, deferredSealFiles['helper.js'])
		assert.doesNotMatch(helper, /provider\.js/)
		assert.match(helper, /unsupported_import/)
		assert.match(helper, /throw error/)
		// Static admission still succeeds: the broken helper is only dynamic-reached.
		assert.equal(graph.entryPath, 'packages/@t/deferred-seal/index.js')
	})

	it('runs TypeScript packages: types removed before linking, sources stored as written', async () => {
		const graph = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/typed' },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		const index = graph.modules['packages/@t/typed/src/index.ts'] ?? ''
		assert.doesNotMatch(index, /: number|: Promise|satisfies|private readonly|enum Unit|missing-types|\.\/types\.ts/)
		assert.match(index, /var Unit; \(function \(Unit\)/)
		assert.match(index, /this\.size = size/)
		assert.match(index, /from '\.\/area\.ts'/)
		assert.match(index, /packageStorage\("@t\/typed"\)/, 'the generic packageStorage call is stamped')
		assert.equal(index.split('\n').length, typedFiles['src/index.ts'].split('\n').length, 'line numbers kept')
		assert.doesNotMatch(graph.modules['packages/@t/typed/src/area.ts'] ?? '', /Shape|: number/)
		assert.equal('packages/@t/typed/src/globals.d.ts' in graph.modules, false, '.d.ts is never a module')
		// Unreached broken TS: throwing stub so a later dynamic reach fails closed.
		assert.match(graph.modules['packages/@t/typed/src/unused-broken.ts'] ?? '', /Cannot read the TypeScript/)
		assert.doesNotMatch(graph.modules['packages/@t/typed/src/unused-broken.ts'] ?? '', /\(x: \)/)
	})

	it('runs .mts exports and JS files that import TypeScript', async () => {
		const extra = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/typed', exportName: './extra' },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.equal(extra.entryPath, 'packages/@t/typed/src/extra.mts')
		assert.doesNotMatch(extra.modules[extra.entryPath] ?? '', /: number/)
		assert.match(extra.modules[extra.entryPath] ?? '', /export default \(n\) => n \+ 1/)
		const bridge = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/typed', exportName: './js' },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.equal(bridge.modules['packages/@t/typed/src/bridge.js'], typedFiles['src/bridge.js'])
	})

	it('names a reachable TypeScript file it cannot read', async () => {
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'package', packageName: '@t/typed-broken' },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/Cannot read the TypeScript in src\/bad\.ts in package @t\/typed-broken: Unexpected token \(1:\d+\)\./,
		)
	})

	it('compiles .tsx with the JSX runtime from tsconfig.json, per-file pragmas winning', async () => {
		// The automatic runtime's import is a bare npm import: with npm off the
		// graph names it, which proves the import source came from tsconfig.json.
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'package', packageName: '@t/tsx' },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/Bare import "remix\/component\/jsx-runtime"/,
		)
	})

	it('uses a classic pragma over the tsconfig runtime, and compiles .jsx', async () => {
		const graph = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/tsx-classic' },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		const classic = graph.modules['packages/@t/tsx-classic/src/classic.tsx'] ?? ''
		assert.match(classic, /React\.createElement\('b', \{ n: 1,\}, 'x'\)/)
		assert.doesNotMatch(classic, /jsx-runtime|: string/)
		assert.match(graph.modules['packages/@t/tsx-classic/src/plain.jsx'] ?? '', /React\.createElement\('i'/)
		// tsconfig.json is JSON a run never imports: registering it as a module must not fail.
		assert.equal(typeof graph.modules['packages/@t/tsx-classic/tsconfig.json'], 'string')
	})

	it('does not fail a run over a JSONC tsconfig.json the entry never imports', async () => {
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'package', packageName: '@t/tsx' },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			(error: unknown) => {
				assert.doesNotMatch(String(error), /JSON|tsconfig/, 'the JSONC tsconfig must not be the failure')
				return true
			},
		)
	})

	it('removes types from ad hoc code (no JSX) and imports TypeScript packages', async () => {
		const graph = await buildModuleGraph({
			entry: {
				kind: 'adhoc',
				code: "import typed from 'kody:@t/typed'\nexport default async (p: { size: number }): Promise<string> => typed(p)",
			},
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.doesNotMatch(graph.modules['main.js'] ?? '', /: \{ size|Promise<string>/)
		assert.match(graph.modules['main.js'] ?? '', /from '\.\/packages\/@t\/typed\/src\/index\.ts'/)
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'adhoc', code: 'export default (x: ) => 1' },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/Cannot read the TypeScript in your execute code: Unexpected token/,
		)
	})

	it('never fails or fetches npm for files the entry does not reach (client .tsx)', async () => {
		const graph = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/app-shape' },
			userCell: fakeUserCell,
			allowNpm: false,
		})
		assert.equal(graph.entryPath, 'packages/@t/app-shape/src/index.ts')
		// With npm on, an unreached client file must not trigger CDN fetches:
		// the dead CDN origin makes any fetch fail the build.
		const withNpm = await buildModuleGraph({
			entry: { kind: 'package', packageName: '@t/app-shape' },
			userCell: fakeUserCell,
			allowNpm: true,
			npm: { config: { enabled: true, cdnOrigin: 'http://127.0.0.1:9', cacheMaxBytes: 0, cacheTtlMs: 0 }, cache: null },
		})
		assert.deepEqual(withNpm.npmModules, [])
		// Reached, the same file still names its problem.
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'package', packageName: '@t/app-shape', exportName: './client' },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/Bare import "remix\/component\/jsx-runtime" is not available/,
		)
	})
})
