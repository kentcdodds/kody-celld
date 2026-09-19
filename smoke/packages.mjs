// Packages smoke: save a local package, run its exports (directly and via
// kody:<pkg>/<export> imports), and prove packageStorage() isolation.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, log, readPackageDir } from './lib.mjs'

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
}
