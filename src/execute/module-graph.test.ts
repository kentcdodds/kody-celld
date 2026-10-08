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

const packages: Record<string, Record<string, string>> = {
	'@t/counter': counterFiles,
	'@t/vault': vaultFiles,
	'@t/text': textFiles,
	'@t/broken': brokenFiles,
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
			manifest: parsePackageManifest(name === '@t/broken' ? { ...files, 'lib/main.js': 'export default 1' } : files),
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

	it('refuses bare npm imports when npm is disabled and unknown packages always', async () => {
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'adhoc', code: "import x from 'lodash'" },
				userCell: fakeUserCell,
				allowNpm: false,
			}),
			/unsupported_import/,
		)
		await assert.rejects(
			buildModuleGraph({
				entry: { kind: 'adhoc', code: "import x from 'kody:@t/nope'" },
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
})
