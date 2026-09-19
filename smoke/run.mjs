#!/usr/bin/env node
// Runs every smoke workload against a running kody-celld (default http://127.0.0.1:8787).
//
//   node smoke/run.mjs                 # all scenarios, skips the ~1-2 minute real-cron wait
//   node smoke/run.mjs --wait-cron     # also waits for celld's cron trigger to fire a job
//   node smoke/run.mjs --only secrets  # one scenario (mcp | packages | secrets | jobs | limits | memory | blobs | browser)
//   SMOKE_AI_MOCK=1 node smoke/run.mjs --only memory  # with smoke/ai-mock-server.mjs + KODY_AI_* set
//
// Env: KODY_URL, KODY_ADMIN_TOKEN, SMOKE_ECHO_PORT, SMOKE_EXPECT_TIMEOUT_MS, SMOKE_AI_MOCK,
//      SMOKE_BROWSER_TARGET_HOST (browser scenario skips itself when no provider is configured)
import { baseUrl, bootstrapUser, log, SmokeError } from './lib.mjs'
import { smokeBlobs } from './blobs.mjs'
import { smokeBrowser } from './browser.mjs'
import { smokeJobs } from './jobs.mjs'
import { smokeLimits } from './limits.mjs'
import { smokeMcp } from './mcp.mjs'
import { smokeMemory } from './memory.mjs'
import { smokePackages } from './packages.mjs'
import { smokeSecrets } from './secrets.mjs'

const args = new Set(process.argv.slice(2))
const only =
	[...args].find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ??
	(args.has('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null)
const waitForCron = args.has('--wait-cron')

const scenarios = [
	['mcp', smokeMcp],
	['packages', smokePackages],
	['secrets', smokeSecrets],
	['jobs', smokeJobs],
	['limits', smokeLimits],
	['memory', smokeMemory],
	['blobs', smokeBlobs],
	['browser', smokeBrowser],
].filter(([name]) => !only || only === name)

if (scenarios.length === 0) {
	console.error(
		`Unknown scenario "${only}". Choose one of: mcp, packages, secrets, jobs, limits, memory, blobs, browser`,
	)
	process.exit(2)
}

async function main() {
	const health = await fetch(`${baseUrl}/health`).then((res) => res.json())
	console.log(`kody-celld ${health.version} at ${baseUrl}`)
	const session = await bootstrapUser()
	console.log(`user ${session.user.email} (${session.user.id})`)
	const ctx = { ...session, waitForCron }
	if (only && only !== 'mcp') await session.mcp.initialize()
	if (only === 'secrets' || only === 'jobs') {
		// These scenarios depend on the example packages being saved.
		console.log('\n[packages] (prerequisite)')
		await smokePackages(ctx)
	}
	const summary = []
	for (const [name, scenario] of scenarios) {
		console.log(`\n[${name}]`)
		const started = Date.now()
		await scenario(ctx)
		summary.push(`${name} ok (${Date.now() - started}ms)`)
	}
	console.log(`\nSMOKE PASSED: ${summary.join(', ')}`)
}

main().catch((error) => {
	if (error instanceof SmokeError) {
		console.error(`\nSMOKE FAILED: ${error.message}`)
	} else {
		console.error('\nSMOKE FAILED (unexpected):', error)
	}
	log('hint', 'is `celld dev .` running? see README "Run locally"')
	process.exit(1)
})
