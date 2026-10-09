// Packages smoke: save a local package, run its exports (directly and via
// kody:<pkg>/<export> imports), and prove packageStorage() isolation.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, log, readPackageDir, sha256 } from './lib.mjs'

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/packages')

export async function smokePackages({ mcp }) {
	const counterFiles = await readPackageDir(path.join(examples, 'counter'))
	const saved = await mcp.call('packageSave', { files: counterFiles, source: 'examples/packages/counter' })
	assert(saved.name === '@kody-smoke/counter', 'packageSave returned the wrong package', saved)
	assert(Object.keys(saved.manifest.jobs).length === 2, 'package should declare its two jobs', saved.manifest.jobs)
	log('packageSave', {
		name: saved.name,
		exports: Object.keys(saved.manifest.exports),
		jobs: Object.keys(saved.manifest.jobs),
	})

	const list = await mcp.call('packageList')
	assert(
		list.packages.some((pkg) => pkg.name === '@kody-smoke/counter'),
		'saved package missing from list',
		list,
	)

	const invalid = await mcp.execute(
		`import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.packageSave({ files: { 'package.json': JSON.stringify({ name: 'broken', version: '1.0.0', exports: './missing.js' }) } })
}`,
	)
	assert(
		!invalid.ok && /README\.md|missing\.js/.test(invalid.error?.message ?? ''),
		'invalid manifests should be rejected',
		invalid.error,
	)
	log('invalid manifest rejected', invalid.error.message.slice(0, 80))

	// Run an export through the packageRun capability (package provenance).
	const run1 = await mcp.callDirect('packageRun', {
		name: '@kody-smoke/counter',
		export: './increment',
		params: { by: 2 },
	})
	assert(run1.ok && run1.result.count >= 2, 'packageRun ./increment failed', run1)
	log('packageRun ./increment', run1.result)

	// Import the export from ad hoc code; storage must still belong to the package.
	const viaImport = await mcp.run(
		`import increment from 'kody:@kody-smoke/counter/increment'
import status from 'kody:@kody-smoke/counter'
export default async function main() {
  const after = await increment({ by: 3 })
  return { after, status: await status() }
}`,
	)
	assert(
		viaImport.after.count === run1.result.count + 3,
		'kody:<pkg>/<export> import should share package storage',
		viaImport,
	)
	assert(
		viaImport.status.id === 'package-storage:@kody-smoke/counter',
		'storage id should carry provenance',
		viaImport.status,
	)
	assert(
		viaImport.status.events.some((row) => row.kind === 'increment' && row.n === 2),
		'SQL events table should record both increments',
		viaImport.status.events,
	)
	log('import kody:@kody-smoke/counter/increment', viaImport)

	// Ad hoc code has no package provenance and therefore no storage.
	const noProvenance = await mcp.execute(
		`import { packageStorage } from 'kody:runtime'
export default async function main() { return await packageStorage().get('count') }`,
	)
	assert(
		!noProvenance.ok && /provenance/.test(noProvenance.error?.message ?? ''),
		'ad hoc packageStorage() must fail',
		noProvenance,
	)
	log('ad hoc packageStorage() rejected')

	// Host-side inspection of the storage cell.
	const inspect = await mcp.call('packageStorageInspect', { packageName: '@kody-smoke/counter' })
	const countItem = inspect.items.find((item) => item.key === 'count')
	assert(
		countItem && countItem.value === viaImport.after.count,
		'packageStorageInspect should see the KV rows',
		inspect,
	)
	assert(inspect.stats.tables.includes('events'), 'packageStorageInspect should list custom SQL tables', inspect.stats)
	log('packageStorageInspect', { keys: inspect.items.map((item) => item.key), tables: inspect.stats.tables })

	const got = await mcp.call('packageGet', { name: '@kody-smoke/counter' })
	assert(
		got.readme.includes('@kody-smoke/counter') && got.agents.length > 0,
		'packageGet should include README/AGENTS',
		Object.keys(got),
	)

	// Second package for the secrets smoke.
	const probeFiles = await readPackageDir(path.join(examples, 'http-probe'))
	const probe = await mcp.call('packageSave', { files: probeFiles, source: 'examples/packages/http-probe' })
	assert(probe.name === '@kody-smoke/http-probe', 'http-probe save failed', probe)
	log('packageSave', { name: probe.name })

	// A package written from inside execute keeps its imports as written: the
	// import inside this code's string literal must not be rewritten on the
	// way into packageSave (it used to become './kody-runtime.js').
	const agentSaved = await mcp.run(`import { kody } from 'kody:runtime'
export default async function main() {
  await kody.packageSave({
    files: {
      'package.json': JSON.stringify({ name: '@kody-smoke/agent-written', version: '1.0.0', description: 'saved from execute', exports: './lib/main.js' }),
      'README.md': '# agent-written',
      'AGENTS.md': 'Saved from execute.',
      'lib/main.js': "import { packageStorage } from 'kody:runtime'\\nexport default async () => typeof packageStorage",
    },
  })
  const saved = await kody.packageGet({ name: '@kody-smoke/agent-written', includeFiles: true })
  return saved.files['lib/main.js'].split('\\n')[0]
}`)
	assert(
		agentSaved === "import { packageStorage } from 'kody:runtime'",
		'a package saved from execute keeps its kody:runtime import as written',
		agentSaved,
	)
	const agentRun = await mcp.run(`import main from 'kody:@kody-smoke/agent-written'
export default async () => main()`)
	assert(agentRun === 'function', 'the package saved from execute loads and runs', agentRun)

	const brokenSave = await mcp.execute(`import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.packageSave({
    files: {
      'package.json': JSON.stringify({ name: '@kody-smoke/broken-import', version: '1.0.0', exports: './lib/main.js' }),
      'README.md': '# broken', 'AGENTS.md': 'Broken.',
      'lib/main.js': "import x from './missing.js'\\nexport default () => x",
    },
  })
}`)
	assert(
		!brokenSave.ok &&
			/invalid_import: Cannot resolve "\.\/missing\.js" from lib\/main\.js/.test(brokenSave.error?.message ?? ''),
		'packageSave refuses a relative import that resolves to nothing, naming it',
		brokenSave.error,
	)
	log('imports', { agentWritten: agentSaved, brokenImport: brokenSave.error?.message })

	// celld links only what the entry reaches through static imports: unused
	// files and optional dynamic imports must keep working as before.
	const tolerant = {
		'@kody-smoke/unreached-missing': {
			'index.js': 'export default () => "ok"',
			'test/unused.js': "import h from './missing.js'\nexport default h",
		},
		'@kody-smoke/unreached-jsx': {
			'index.js': 'export default () => "ok"',
			'client/view.js': 'export default () => <div>hi</div>',
		},
		'@kody-smoke/dynamic-optional': {
			'index.js':
				"export default async () => { try { await import('./optional.js'); return 'loaded' } catch { return 'fallback' } }",
		},
	}
	for (const [name, files] of Object.entries(tolerant)) {
		await mcp.call('packageSave', {
			files: {
				'package.json': JSON.stringify({ name, version: '1.0.0', exports: './index.js' }),
				'README.md': `# ${name}`,
				'AGENTS.md': 'Smoke.',
				...files,
			},
		})
		const result = await mcp.run(`import m from 'kody:${name}'\nexport default async () => m()`)
		assert(
			result === (name.endsWith('dynamic-optional') ? 'fallback' : 'ok'),
			`${name} saves and runs: unreached files and optional dynamic imports are not checked`,
			result,
		)
	}
	log('imports', { unreachedAndDynamic: 'ok' })

	// Per-file SQLite rows: a ~3.5 MiB package (with one file over 1 MiB) must
	// round-trip, and anything over the documented 4 MiB cap must be refused
	// with an error that names the limit (issue #35 part 3).
	const bigChunk = 'x'.repeat(1.2 * 1024 * 1024)
	const midChunk = 'y'.repeat(1.1 * 1024 * 1024)
	const filler = 'z'.repeat(1.2 * 1024 * 1024)
	const largeFiles = {
		'package.json': JSON.stringify({
			name: '@kody-smoke/large-package',
			version: '1.0.0',
			description: 'smoke large package',
			exports: './index.js',
		}),
		'README.md': '# large-package',
		'AGENTS.md': 'Large package smoke.',
		'index.js': 'export default async () => "large-ok"',
		'data/big-a.txt': bigChunk,
		'data/big-b.txt': midChunk,
		'data/filler.txt': filler,
	}
	const largeTotal = Object.values(largeFiles).reduce((n, content) => n + content.length, 0)
	assert(
		largeTotal > 3.4 * 1024 * 1024 && largeTotal < 4 * 1024 * 1024,
		`large package fixture should be ~3.5 MiB (got ${largeTotal})`,
		{ largeTotal },
	)
	assert(bigChunk.length > 1024 * 1024, 'at least one file must exceed 1 MiB', bigChunk.length)
	// Save over REST so the 3.5 MiB file map is not an execute result payload.
	const largeSaved = await mcp.callDirect('packageSave', { files: largeFiles, source: 'smoke/packages.mjs' })
	assert(largeSaved.name === '@kody-smoke/large-package', 'large packageSave returned wrong name', largeSaved)
	assert(largeSaved.fileCount === Object.keys(largeFiles).length, 'large package fileCount', largeSaved)
	const expectedDigests = {
		'data/big-a.txt': sha256(bigChunk),
		'data/big-b.txt': sha256(midChunk),
		'data/filler.txt': sha256(filler),
	}
	// Hash inside execute — returning the full files map would exceed responseLimit.
	const largeRoundTrip = await mcp.run(
		`import { kody } from 'kody:runtime'
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
export default async function main({ expect }) {
  const pkg = await kody.packageGet({ name: '@kody-smoke/large-package', includeFiles: true })
  const digests = {}
  for (const path of Object.keys(expect)) {
    const content = pkg.files[path]
    if (typeof content !== 'string') return { ok: false, path, reason: 'missing' }
    digests[path] = await sha256Hex(content)
  }
  return { ok: true, fileCount: Object.keys(pkg.files).length, digests }
}`,
		{ expect: expectedDigests },
	)
	assert(largeRoundTrip.ok === true, 'large packageGet must return all big files', largeRoundTrip)
	assert(largeRoundTrip.fileCount === Object.keys(largeFiles).length, 'large package file count', largeRoundTrip)
	assert(
		largeRoundTrip.digests['data/big-a.txt'] === expectedDigests['data/big-a.txt'] &&
			largeRoundTrip.digests['data/big-b.txt'] === expectedDigests['data/big-b.txt'] &&
			largeRoundTrip.digests['data/filler.txt'] === expectedDigests['data/filler.txt'],
		'large package file digests must match what was saved',
		largeRoundTrip.digests,
	)
	const largeRun = await mcp.run(`import m from 'kody:@kody-smoke/large-package'\nexport default async () => m()`)
	assert(largeRun === 'large-ok', 'large package must still execute', largeRun)
	log('large package', { bytes: largeTotal, files: largeSaved.fileCount, run: largeRun })

	const overLimit = await mcp.execute(`import { kody } from 'kody:runtime'
export default async function main() {
  const huge = 'x'.repeat(4 * 1024 * 1024 + 1)
  return await kody.packageSave({
    files: {
      'package.json': JSON.stringify({ name: '@kody-smoke/too-big', version: '1.0.0', exports: './index.js' }),
      'README.md': '# too-big',
      'AGENTS.md': 'Too big.',
      'index.js': 'export default async () => 1',
      'blob.txt': huge,
    },
  })
}`)
	assert(
		!overLimit.ok &&
			/invalid_package:.*at most 4 MiB/.test(overLimit.error?.message ?? '') &&
			/limit is 4 MiB/.test(overLimit.error?.message ?? ''),
		'packages over 4 MiB must be rejected naming the limit',
		overLimit.error,
	)
	log('over-limit package rejected', overLimit.error.message.slice(0, 120))
}
