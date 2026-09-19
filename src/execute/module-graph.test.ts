import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { UserCell } from '../cells/user-cell.ts'
import { parsePackageManifest } from '../packages/manifest.ts'
import { buildModuleGraph, relativeSpecifier, stampPackageStorage } from './module-graph.ts'

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

const fakeUserCell = {
	async packageGet(name: string) {
		if (name !== '@t/counter') return null
		return {
			name,
			version: '1.0.0',
			manifest: parsePackageManifest(counterFiles),
			files: counterFiles,
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
})
