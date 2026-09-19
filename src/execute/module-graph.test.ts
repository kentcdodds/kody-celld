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

const packages: Record<string, Record<string, string>> = { '@t/counter': counterFiles, '@t/vault': vaultFiles }

const fakeUserCell = {
	async packageGet(name: string) {
		const files = packages[name]
		if (!files) return null
		return {
			name,
			version: '1.0.0',
			manifest: parsePackageManifest(files),
			files,
			source: 'test',
			createdAt: '',
			updatedAt: '',
		}
	},
} as unknown as DurableObjectStub<UserCell>

describe('relativeSpecifier', () => {
	it('always yields a root-anchored specifier (celld resolves by exact name)', () => {
		assert.equal(relativeSpecifier('packages/@t/counter/lib/bump.js', 'kody-runtime.js'), './kody-runtime.js')
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
		assert.match(
			graph.modules['packages/@t/counter/increment.js'] ?? '',
			/from '\.\/packages\/@t\/counter\/lib\/bump\.js'/,
		)
		assert.match(graph.modules['packages/@t/counter/lib/bump.js'] ?? '', /from '\.\/kody-runtime\.js'/)
		assert.match(graph.modules['packages/@t/counter/lib/bump.js'] ?? '', /packageStorage\("@t\/counter"\)/)
		assert.equal('packages/@t/counter/README.md' in graph.modules, false)
		assert.equal('packages/@t/counter/AGENTS.md' in graph.modules, false)
		assert.match(graph.modules['packages/@t/counter/package.json'] ?? '', /^export default \{/)
		assert.deepEqual(graph.packages, ['@t/counter'])
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
		assert.match(viaKody.modules['packages/@t/vault/leak.js'] ?? '', /from '\.\/kody-sealed\.js'/)
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
