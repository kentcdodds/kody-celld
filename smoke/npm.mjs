// npm smoke: import a package through the configured ESM CDN, then prove the
// durable module cache serves the second run (hits go up, the CDN is not asked
// again) and that the admin stats/clear endpoints work. Set SMOKE_OFFLINE=1 to
// skip when the node has no route to the CDN.
import { admin, assert, log } from './lib.mjs'

const code = `import ms from 'ms@2.1.3'
export default async function main() { return { ms: ms('2h'), type: typeof ms } }`

export async function smokeNpm({ mcp }) {
	const { status, json: before } = await admin.npmCache()
	assert(status === 200, 'GET /admin/npm-cache failed', before)
	log('npm config', before.npm)
	if (!before.npm.enabled) {
		log('skip', 'KODY_NPM_IMPORTS=off on this node')
		return
	}
	if (process.env.SMOKE_OFFLINE === '1') {
		log('skip', 'SMOKE_OFFLINE=1 (no route to the ESM CDN)')
		return
	}

	// Start from a clean slate so the counters below are unambiguous.
	const cleared = await admin.clearNpmCache()
	assert(cleared.status === 200 && typeof cleared.json.cleared === 'number', 'cache clear failed', cleared.json)

	const first = await mcp.execute(code)
	assert(first.ok, 'npm import via the ESM CDN failed', { error: first.error, logs: first.logs })
	assert(first.result.ms === 7_200_000 && first.result.type === 'function', 'ms() returned the wrong value', first)
	log('import ms@2.1.3', { ...first.result, warnings: first.warnings })

	const afterFirst = (await admin.npmCache()).json.cache
	assert(afterFirst.modules >= 1 && afterFirst.bytes > 0, 'durable cache should hold the fetched module(s)', afterFirst)
	assert(afterFirst.misses >= 1, 'first run should register cache misses', afterFirst)

	// A second run must be served by the durable cache (or the process-local
	// memo) — either way the CDN miss counter must not move.
	const second = await mcp.run(code)
	assert(second.ms === 7_200_000, 'cached module returned the wrong value', second)
	const afterSecond = (await admin.npmCache()).json.cache
	assert(afterSecond.misses === afterFirst.misses, 'second run should not miss the durable cache', {
		afterFirst,
		afterSecond,
	})
	log('cache stats', {
		modules: afterSecond.modules,
		bytes: afterSecond.bytes,
		hits: afterSecond.hits,
		misses: afterSecond.misses,
	})

	// Unknown packages fail at graph build with the CDN's answer, not a hang.
	const missing = await mcp.execute(
		`import nothing from 'kody-celld-smoke-does-not-exist-${Date.now().toString(36)}'\nexport default async function main() { return nothing }`,
	)
	assert(!missing.ok, 'unknown npm packages should fail the run', missing)
	log('unknown package rejected', missing.error?.message?.slice(0, 100))

	const wiped = await admin.clearNpmCache()
	assert(wiped.json.cleared >= 1, 'clear should report the evicted modules', wiped.json)
	const empty = (await admin.npmCache()).json.cache
	assert(empty.modules === 0 && empty.bytes === 0, 'cache should be empty after clear', empty)
	log('cache cleared', wiped.json)
}
